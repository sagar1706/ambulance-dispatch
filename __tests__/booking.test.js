// ─────────────────────────────────────────────────────────────────
// Booking Tests — POST /api/booking, GET /api/booking/my, etc.
//
// STRATEGY:
//   1. Before all tests, register + login a fresh USER and DRIVER
//   2. Run all booking tests using those accounts
//   3. After all tests, clean up the users + bookings we created
//
// WHY beforeAll vs beforeEach:
//   `beforeAll`  — runs ONCE before the first test in this describe
//   `beforeEach` — runs before EVERY single test
//
//   Login/register is expensive (DB writes + bcrypt hashing).
//   We do it once in `beforeAll` and reuse the token for all tests.
// ─────────────────────────────────────────────────────────────────

require("dotenv").config();
const request = require("supertest");
const { app } = require("../src/server");
const prisma = require("../src/config/prisma");

// Shared state for this test file
const ts = Date.now();
const userEmail = `test_booking_user_${ts}@example.com`;
let userToken = null;
let bookingId = null;  // created booking ID, reused across tests

// ── Setup: create user and login ──────────────────────────────────
beforeAll(async () => {
    // Register a fresh USER
    await request(app)
        .post("/api/auth/register")
        .send({ name: "Booking Test User", email: userEmail, password: "TestPass1234", role: "USER" });

    // Login and grab the token
    const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ email: userEmail, password: "TestPass1234" });

    userToken = loginRes.body.token;
});

// ── Cleanup: remove all test data ─────────────────────────────────
afterAll(async () => {
    // Delete the test user (cascade-deletes their bookings too)
    await prisma.user.deleteMany({ where: { email: { contains: "test_booking_" } } });
    await prisma.$disconnect();
});

// ══════════════════════════════════════════════════════════════════
// CREATE BOOKING
// ══════════════════════════════════════════════════════════════════
describe("POST /api/booking", () => {

    it("should return 401 when not authenticated", async () => {
        // No Authorization header → should be rejected
        const res = await request(app)
            .post("/api/booking")
            .send({ pickupLat: 19.076, pickupLng: 72.877 });

        expect(res.statusCode).toBe(401);
    });

    it("should create a booking with valid coords", async () => {
        const res = await request(app)
            .post("/api/booking")
            .set("Authorization", `Bearer ${userToken}`)  // <-- set the auth header
            .send({ pickupLat: 19.076, pickupLng: 72.877 });

        // 201 = driver found and immediately assigned
        // 202 = no driver available, booking added to queue
        // Both are valid — depends on whether a driver has a known location in the test DB
        expect([201, 202]).toContain(res.statusCode);
        expect(res.body.booking).toBeDefined();
        expect(["REQUESTED", "ASSIGNED"]).toContain(res.body.booking.status);
        expect(res.body.booking.pickupLat).toBe(19.076);

        // Save the booking ID to use in later tests
        bookingId = res.body.booking.id;
    });

    it("should return 400 when pickupLat or pickupLng is missing", async () => {
        const res = await request(app)
            .post("/api/booking")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ pickupLat: 19.076 });  // missing pickupLng

        expect(res.statusCode).toBe(400);
    });

    it("should return 400 for invalid coordinates (out of range)", async () => {
        const res = await request(app)
            .post("/api/booking")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ pickupLat: 999, pickupLng: 72.877 });  // lat must be -90 to 90

        expect(res.statusCode).toBe(400);
    });

});

// ══════════════════════════════════════════════════════════════════
// GET MY BOOKINGS (with filters)
// ══════════════════════════════════════════════════════════════════
describe("GET /api/booking/my", () => {

    it("should return 401 when not authenticated", async () => {
        const res = await request(app).get("/api/booking/my");
        expect(res.statusCode).toBe(401);
    });

    it("should return booking list with correct pagination metadata", async () => {
        const res = await request(app)
            .get("/api/booking/my")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);

        // Pagination fields must all be present
        expect(typeof res.body.total).toBe("number");
        expect(typeof res.body.page).toBe("number");
        expect(typeof res.body.totalPages).toBe("number");
        expect(typeof res.body.hasNextPage).toBe("boolean");
        expect(Array.isArray(res.body.bookings)).toBe(true);

        // We created at least one booking in the POST test above
        expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it("should filter by status=REQUESTED and return only matching bookings", async () => {
        const res = await request(app)
            .get("/api/booking/my?status=REQUESTED")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.filters.status).toBe("REQUESTED");

        // Every returned booking must have the REQUESTED status
        res.body.bookings.forEach((b) => {
            expect(b.status).toBe("REQUESTED");
        });
    });

    it("should return 400 for invalid status filter", async () => {
        const res = await request(app)
            .get("/api/booking/my?status=INVALID_STATUS")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Invalid status");
    });

    it("should respect page and limit params", async () => {
        const res = await request(app)
            .get("/api/booking/my?page=1&limit=1")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.limit).toBe(1);
        expect(res.body.bookings.length).toBeLessThanOrEqual(1);
    });

    it("should cap limit at 50 even if 999 is requested", async () => {
        const res = await request(app)
            .get("/api/booking/my?limit=999")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.limit).toBe(50);
    });

    it("should return 400 for invalid sort value", async () => {
        const res = await request(app)
            .get("/api/booking/my?sort=random")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("oldest");
    });

});

// ══════════════════════════════════════════════════════════════════
// GET SINGLE BOOKING
// ══════════════════════════════════════════════════════════════════
describe("GET /api/booking/:id", () => {

    it("should return the booking by ID", async () => {
        // bookingId was set in the POST test above
        if (!bookingId) return; // skip if POST test failed

        const res = await request(app)
            .get(`/api/booking/${bookingId}`)
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.booking.id).toBe(bookingId);
    });

    it("should return 404 for a non-existing booking ID", async () => {
        const res = await request(app)
            .get("/api/booking/00000000-0000-0000-0000-000000000000")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(404);
    });

});

// ══════════════════════════════════════════════════════════════════
// CANCEL BOOKING
// ══════════════════════════════════════════════════════════════════
describe("PATCH /api/booking/:id/cancel", () => {

    it("should cancel a REQUESTED booking", async () => {
        if (!bookingId) return;

        const res = await request(app)
            .patch(`/api/booking/${bookingId}/cancel`)
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.booking.status).toBe("CANCELLED");
    });

    it("should return 400 when trying to cancel an already-cancelled booking", async () => {
        if (!bookingId) return;

        // The booking is already CANCELLED from the test above
        const res = await request(app)
            .patch(`/api/booking/${bookingId}/cancel`)
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(400);
    });

});
