// ─────────────────────────────────────────────────────────────────
// Password Flow Tests
//   - PATCH /api/auth/change-password
//   - POST  /api/auth/forgot-password
//   - POST  /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────

require("dotenv").config();
const request = require("supertest");
const crypto = require("crypto");
const { app } = require("../src/server");
const prisma = require("../src/config/prisma");

const ts = Date.now();
const userEmail = `test_pwd_${ts}@example.com`;
const userPassword = "OriginalPass1";
let userToken = null;

beforeAll(async () => {
    await request(app)
        .post("/api/auth/register")
        .send({ name: "Password Test User", email: userEmail, password: userPassword, role: "USER" });

    const res = await request(app)
        .post("/api/auth/login")
        .send({ email: userEmail, password: userPassword });

    userToken = res.body.token;
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: "test_pwd_" } } });
    await prisma.$disconnect();
});

// ══════════════════════════════════════════════════════════════════
// CHANGE PASSWORD (authenticated)
// ══════════════════════════════════════════════════════════════════
describe("PATCH /api/auth/change-password", () => {

    it("should return 401 without auth token", async () => {
        const res = await request(app)
            .patch("/api/auth/change-password")
            .send({ currentPassword: userPassword, newPassword: "NewPass5678" });
        expect(res.statusCode).toBe(401);
    });

    it("should return 400 when body fields are missing", async () => {
        const res = await request(app)
            .patch("/api/auth/change-password")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ currentPassword: userPassword });  // missing newPassword
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("required");
    });

    it("should return 401 for wrong current password", async () => {
        const res = await request(app)
            .patch("/api/auth/change-password")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ currentPassword: "WrongPass1", newPassword: "NewPass5678" });
        expect(res.statusCode).toBe(401);
        expect(res.body.error).toContain("incorrect");
    });

    it("should return 400 if new password is same as current", async () => {
        const res = await request(app)
            .patch("/api/auth/change-password")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ currentPassword: userPassword, newPassword: userPassword });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("different");
    });

    it("should return 400 for weak new password", async () => {
        const res = await request(app)
            .patch("/api/auth/change-password")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ currentPassword: userPassword, newPassword: "onlyletters" });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("letter and one number");
    });

    it("should change password successfully with valid inputs", async () => {
        const res = await request(app)
            .patch("/api/auth/change-password")
            .set("Authorization", `Bearer ${userToken}`)
            .send({ currentPassword: userPassword, newPassword: "NewPass5678" });
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain("successfully");

        // Verify old password no longer works
        const loginOld = await request(app)
            .post("/api/auth/login")
            .send({ email: userEmail, password: userPassword });
        expect(loginOld.statusCode).toBe(401);

        // Verify new password works
        const loginNew = await request(app)
            .post("/api/auth/login")
            .send({ email: userEmail, password: "NewPass5678" });
        expect(loginNew.statusCode).toBe(200);

        // Update token for subsequent tests
        userToken = loginNew.body.token;
    });

});

// ══════════════════════════════════════════════════════════════════
// FORGOT PASSWORD (public)
// ══════════════════════════════════════════════════════════════════
describe("POST /api/auth/forgot-password", () => {

    it("should return 400 when email is missing", async () => {
        const res = await request(app)
            .post("/api/auth/forgot-password")
            .send({});
        expect(res.statusCode).toBe(400);
    });

    it("should always return 200 even for non-existing email (prevent enumeration)", async () => {
        const res = await request(app)
            .post("/api/auth/forgot-password")
            .send({ email: "nobody_real@nowhere.com" });

        // CRITICAL: must NOT return 404 — that would leak account existence
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain("If an account");
    });

    it("should return 200 and create a DB token for a real email", async () => {
        const res = await request(app)
            .post("/api/auth/forgot-password")
            .send({ email: userEmail });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain("If an account");

        // Verify a token was actually created in the DB
        const user = await prisma.user.findUnique({ where: { email: userEmail } });
        const tokens = await prisma.passwordResetToken.findMany({
            where: { userId: user.id, used: false },
        });
        expect(tokens.length).toBeGreaterThanOrEqual(1);
    });

});

// ══════════════════════════════════════════════════════════════════
// RESET PASSWORD (public)
// ══════════════════════════════════════════════════════════════════
describe("POST /api/auth/reset-password", () => {

    it("should return 400 when token or newPassword is missing", async () => {
        const res = await request(app)
            .post("/api/auth/reset-password")
            .send({ token: "sometoken" });  // missing newPassword
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("required");
    });

    it("should return 400 for a fake/invalid token", async () => {
        const res = await request(app)
            .post("/api/auth/reset-password")
            .send({ token: "totallyfaketoken123", newPassword: "FreshPass1" });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Invalid");
    });

    it("should reset password successfully with a valid token", async () => {
        // Step 1: Create a real reset token directly in the DB (bypass email sending)
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);  // 15 min from now

        const user = await prisma.user.findUnique({ where: { email: userEmail } });
        await prisma.passwordResetToken.create({
            data: { userId: user.id, token: hashedToken, expiresAt },
        });

        // Step 2: Use the raw token to reset password
        const res = await request(app)
            .post("/api/auth/reset-password")
            .send({ token: rawToken, newPassword: "ResetPass9999" });

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain("successful");

        // Step 3: Verify new password works
        const loginRes = await request(app)
            .post("/api/auth/login")
            .send({ email: userEmail, password: "ResetPass9999" });
        expect(loginRes.statusCode).toBe(200);
    });

    it("should return 400 if the same token is used again (single-use)", async () => {
        // Create another token
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        const user = await prisma.user.findUnique({ where: { email: userEmail } });
        await prisma.passwordResetToken.create({
            data: { userId: user.id, token: hashedToken, expiresAt },
        });

        // First use — should succeed
        await request(app)
            .post("/api/auth/reset-password")
            .send({ token: rawToken, newPassword: "SecondReset1" });

        // Second use — should fail (token is now used=true)
        const res2 = await request(app)
            .post("/api/auth/reset-password")
            .send({ token: rawToken, newPassword: "ThirdReset99" });

        expect(res2.statusCode).toBe(400);
        expect(res2.body.error).toContain("already been used");
    });

    it("should return 400 for an expired token", async () => {
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

        const user = await prisma.user.findUnique({ where: { email: userEmail } });
        await prisma.passwordResetToken.create({
            data: {
                userId: user.id,
                token: hashedToken,
                expiresAt: new Date(Date.now() - 1000),  // 1 second in the PAST — already expired
            },
        });

        const res = await request(app)
            .post("/api/auth/reset-password")
            .send({ token: rawToken, newPassword: "FreshPass999" });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("expired");
    });

});
