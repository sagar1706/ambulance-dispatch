// ─────────────────────────────────────────────────────────────────
// Auth Tests — POST /api/auth/register & POST /api/auth/login
//
// HOW SUPERTEST WORKS:
//   - `request(app)` creates a test HTTP client bound to our Express app
//   - It spins up a temporary server on a random port (no conflicts!)
//   - `.post("/...")`  creates the request
//   - `.send({...})`   sets the JSON body
//   - `.expect(201)`   asserts the HTTP status code
//   - The whole thing returns a Promise, so we use async/await
//
// HOW JEST WORKS:
//   - `describe("name", fn)` groups related tests together
//   - `it("name", fn)` or `test("name", fn)` is one individual test
//   - `expect(value).toBe(x)` makes an assertion
//   - If the assertion fails, Jest marks the test as FAILED
//   - All tests are isolated — each `it` block is independent
//
// TEST DATABASE:
//   These tests run against your REAL database.
//   We use unique emails (timestamped) so tests don't collide with
//   each other or with existing data.
//   The `afterAll` block cleans up any users created during testing.
// ─────────────────────────────────────────────────────────────────

require("dotenv").config();
const request = require("supertest");
const { app } = require("../src/server");
const prisma = require("../src/config/prisma");

// Store data that needs to be shared between tests in a describe block
const testEmail = `test_auth_${Date.now()}@example.com`;
const testPassword = "TestPass1234";
let authToken = null;  // filled in by the login test

// ── Cleanup ────────────────────────────────────────────────────────
// After ALL tests in this file finish, delete the user we created.
// This keeps the database clean between test runs.
afterAll(async () => {
    await prisma.user.deleteMany({
        where: { email: { contains: "test_auth_" } },
    });
    await prisma.$disconnect();
});

// ══════════════════════════════════════════════════════════════════
// REGISTRATION TESTS
// ══════════════════════════════════════════════════════════════════
describe("POST /api/auth/register", () => {

    // ── Happy path ────────────────────────────────────────────────
    it("should register a new USER and return 201", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({
                name: "Test User Auth",
                email: testEmail,
                password: testPassword,
                role: "USER",
            });

        // `expect(res.statusCode).toBe(201)` asserts the HTTP status
        expect(res.statusCode).toBe(201);

        // `expect(res.body).toMatchObject({...})` asserts the response
        // body contains AT LEAST these fields (extra fields are OK)
        expect(res.body).toMatchObject({
            message: "Registration successful",
            role: "USER",
        });

        // Check that userId is a non-empty string (a UUID was generated)
        expect(typeof res.body.userId).toBe("string");
        expect(res.body.userId.length).toBeGreaterThan(0);
    });

    // ── Duplicate email ───────────────────────────────────────────
    it("should return 409 for duplicate email", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({
                name: "Test User Auth",
                email: testEmail,           // same email as above
                password: testPassword,
                role: "USER",
            });

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toContain("already exists");
    });

    // ── Validation: missing fields ────────────────────────────────
    it("should return 400 when required fields are missing", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "Only Name" });   // missing email, password, role

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBeTruthy();  // some error message must exist
    });

    // ── Validation: name has numbers ──────────────────────────────
    it("should return 400 for name with numbers", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "R4hul1", email: "x@x.com", password: "pass1234", role: "USER" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("letters and spaces");
    });

    // ── Validation: bad email format ──────────────────────────────
    it("should return 400 for invalid email format", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "Valid Name", email: "notanemail", password: "pass1234", role: "USER" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("email");
    });

    // ── Validation: weak password ─────────────────────────────────
    it("should return 400 for password without a number", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "Valid Name", email: "v@test.com", password: "onlyletters", role: "USER" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("letter and one number");
    });

    // ── Validation: short password ────────────────────────────────
    it("should return 400 for password shorter than 8 chars", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "Valid Name", email: "v@test.com", password: "abc1", role: "USER" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("8 characters");
    });

    // ── Validation: invalid role ──────────────────────────────────
    it("should return 400 for invalid role", async () => {
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "Valid Name", email: "v@test.com", password: "pass1234", role: "SUPERUSER" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("role");
    });

});

// ══════════════════════════════════════════════════════════════════
// LOGIN TESTS
// ══════════════════════════════════════════════════════════════════
describe("POST /api/auth/login", () => {

    // ── Happy path ────────────────────────────────────────────────
    it("should login successfully and return a JWT token", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: testEmail, password: testPassword });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toBe("Login successful");

        // Token must be a non-empty string
        expect(typeof res.body.token).toBe("string");
        expect(res.body.token.length).toBeGreaterThan(0);

        // Save the token for use in other test files later
        authToken = res.body.token;

        // User info must be returned without the password hash
        expect(res.body.user).toBeDefined();
        expect(res.body.user.password).toBeUndefined();
    });

    // ── Wrong password ────────────────────────────────────────────
    it("should return 401 for wrong password", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: testEmail, password: "WrongPassword1" });

        expect(res.statusCode).toBe(401);
        // Must NOT reveal whether it's the email or password that's wrong
        expect(res.body.error).toBe("Invalid email or password");
    });

    // ── Non-existing user ─────────────────────────────────────────
    it("should return 401 for non-existing email", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: "nobody@nowhere.com", password: "password1" });

        expect(res.statusCode).toBe(401);
        // Same message as wrong password — prevents user enumeration
        expect(res.body.error).toBe("Invalid email or password");
    });

    // ── Missing fields ────────────────────────────────────────────
    it("should return 400 when email or password is missing", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: testEmail });  // missing password

        expect(res.statusCode).toBe(400);
    });

});
