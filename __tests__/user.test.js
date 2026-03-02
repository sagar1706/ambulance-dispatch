// ─────────────────────────────────────────────────────────────────
// User Profile Tests — GET & PATCH /api/user/me
//
// NOTE ON TEST ISOLATION:
//   Each test file creates its own test user with a unique email.
//   Tests within one file share the same user (efficient).
//   But test FILES are completely isolated from each other.
// ─────────────────────────────────────────────────────────────────

require("dotenv").config();
const request = require("supertest");
const { app } = require("../src/server");
const prisma = require("../src/config/prisma");

const ts = Date.now();
const userEmail = `test_user_profile_${ts}@example.com`;
let userToken = null;

beforeAll(async () => {
    await request(app)
        .post("/api/auth/register")
        .send({ name: "Profile Test User", email: userEmail, password: "TestPass1234", role: "USER" });

    const res = await request(app)
        .post("/api/auth/login")
        .send({ email: userEmail, password: "TestPass1234" });

    userToken = res.body.token;
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: "test_user_profile_" } } });
    await prisma.$disconnect();
});

// ══════════════════════════════════════════════════════════════════
// GET /api/user/me
// ══════════════════════════════════════════════════════════════════
describe("GET /api/user/me", () => {

    it("should return 401 without auth", async () => {
        const res = await request(app).get("/api/user/me");
        expect(res.statusCode).toBe(401);
    });

    it("should return profile with correct fields", async () => {
        const res = await request(app)
            .get("/api/user/me")
            .set("Authorization", `Bearer ${userToken}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.user).toBeDefined();

        const user = res.body.user;
        expect(user.name).toBe("Profile Test User");
        expect(user.email).toBe(userEmail);
        expect(user.role).toBe("USER");

        // Password must NEVER appear in the response
        expect(user.password).toBeUndefined();

        // Booking count must be present (0 for a new user)
        expect(user._count).toBeDefined();
        expect(user._count.bookings).toBe(0);
    });

});

// ══════════════════════════════════════════════════════════════════
// PATCH /api/user/me
// ══════════════════════════════════════════════════════════════════
describe("PATCH /api/user/me", () => {

    it("should return 401 without auth", async () => {
        const res = await request(app)
            .patch("/api/user/me")
            .send({ name: "New Name" });
        expect(res.statusCode).toBe(401);
    });

    it("should update name successfully", async () => {
        const res = await request(app)
            .patch("/api/user/me")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ name: "Updated Name" });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain("updated");
        expect(res.body.user.name).toBe("Updated Name");
    });

    it("should return 400 for empty body", async () => {
        const res = await request(app)
            .patch("/api/user/me")
            .set("Authorization", `Bearer ${userToken}`)
            .send({});

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("at least one field");
    });

    it("should return 400 for invalid name format", async () => {
        const res = await request(app)
            .patch("/api/user/me")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ name: "R4hul123" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("letters and spaces");
    });

    it("should return 400 for invalid email format", async () => {
        const res = await request(app)
            .patch("/api/user/me")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ email: "not-an-email" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("email");
    });

    it("should return 409 if email is already taken", async () => {
        // Try to take the email of an existing test user
        // We'll use the auth test email format (which should exist from auth.test.js)
        // But since test files run independently, let's create a known email first
        const takenEmail = `test_taken_email_${ts}@example.com`;
        await prisma.user.create({
            data: { name: "Taken Email User", email: takenEmail, password: "hashed", role: "USER" },
        });

        const res = await request(app)
            .patch("/api/user/me")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ email: takenEmail });

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toContain("already used");

        // Cleanup the extra user we created
        await prisma.user.deleteMany({ where: { email: takenEmail } });
    });

});
