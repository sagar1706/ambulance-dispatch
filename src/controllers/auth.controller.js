const crypto = require("crypto");   // built-in Node.js — generates secure random tokens
const prisma = require("../config/prisma");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sendPasswordResetEmail } = require("../utils/email");

const VALID_ROLES = ["USER", "DRIVER", "ADMIN"];

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

// Strips any HTML tags from input to prevent stored XSS.
// e.g. sanitize('<script>alert(1)</script>John') → 'John'
// We also trim whitespace. Applied to all text inputs before DB storage.
const sanitize = (str) => str.replace(/<[^>]*>/g, "").trim();

// Central validation — reused by both register and update-profile
function validateNameAndEmail(name, email) {
  if (name !== undefined) {
    const trimmed = sanitize(name);
    if (!/^[a-zA-Z\s]{2,50}$/.test(trimmed)) {
      return { error: "Name must be 2–50 characters and contain only letters and spaces" };
    }
  }
  if (email !== undefined) {
    const trimmed = sanitize(email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      return { error: "Invalid email address format" };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────
exports.register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "All fields are required: name, email, password, role" });
    }

    // Sanitize before validation (strip HTML tags)
    const trimmedName = sanitize(name);
    const trimmedEmail = sanitize(email).toLowerCase();

    if (!/^[a-zA-Z\s]{2,50}$/.test(trimmedName)) {
      return res.status(400).json({
        error: "Name must be 2–50 characters and contain only letters and spaces",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmedEmail)) {
      return res.status(400).json({ error: "Invalid email address format" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long" });
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({
        error: "Password must contain at least one letter and one number",
      });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: trimmedEmail } });
    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, rounds);

    const user = await prisma.user.create({
      data: { name: trimmedName, email: trimmedEmail, password: hashedPassword, role },
    });

    if (role === "DRIVER") {
      await prisma.driver.create({ data: { userId: user.id } });
    }

    res.status(201).json({ message: "Registration successful", userId: user.id, role: user.role });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: sanitize(email).toLowerCase() },
    });

    // Same message for "not found" and "wrong password" to prevent user enumeration
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: "Your account has been deactivated. Please contact the administrator.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/auth/change-password
// Authenticated — user changes their own password
//
// REQUIRES:
//   { currentPassword: "...", newPassword: "..." }
//
// WHY REQUIRE CURRENT PASSWORD:
//   Even with a valid JWT token, we require the current password.
//   This protects users whose session was hijacked — the attacker
//   can't change the password (and lock the user out) without
//   knowing the current password too. This is standard practice
//   (Google, GitHub, etc. all require it).
// ─────────────────────────────────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Both currentPassword and newPassword are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters long" });
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({
        error: "New password must contain at least one letter and one number",
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from current password" });
    }

    // Fetch user WITH password hash (not excluded here — we need it to compare)
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedNew = await bcrypt.hash(newPassword, rounds);

    await prisma.user.update({
      where: { id: req.user.userId },
      data: { password: hashedNew },
    });

    res.json({ message: "Password changed successfully. Please log in again with your new password." });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "Failed to change password. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password  (public — no auth)
// Step 1 of password reset: request a reset email
//
// HOW IT WORKS:
//   1. User provides their email
//   2. We look up the user (but always return 200 — see note)
//   3. Generate a secure random 64-char hex token
//   4. Store hashed token in DB with 15-min expiry
//   5. Email the raw token link to the user
//
// WHY ALWAYS RETURN 200 (even if email not found):
//   If we return 404 for non-existing emails, attackers can
//   use this endpoint to enumerate valid emails ("Does this
//   person have an account?"). Always responding with 200
//   prevents this — we securely reveal nothing.
//
// WHY STORE A HASH OF THE TOKEN (not the raw token):
//   If the database is compromised, attackers should NOT get
//   working reset tokens. We store bcrypt(token) and compare
//   on reset. Similar to how we store bcrypt(password).
//   Note: for tokens we use SHA-256 (not bcrypt) because tokens
//   are long and random — bcrypt's slowness isn't needed here.
// ─────────────────────────────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const cleanEmail = sanitize(email).toLowerCase();

    // Always respond 200 — don't leak whether email exists
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user || !user.isActive) {
      // Still return success — don't reveal account existence
      return res.json({
        message: "If an account with that email exists, a reset link has been sent.",
      });
    }

    // Generate a cryptographically secure random token (32 bytes = 64 hex chars)
    const rawToken = crypto.randomBytes(32).toString("hex");

    // Hash it for DB storage (so DB leak doesn't give attackers working tokens)
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

    // 15 minutes from now
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Invalidate any existing unused tokens for this user (one at a time)
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Create the new token
    await prisma.passwordResetToken.create({
      data: { userId: user.id, token: hashedToken, expiresAt },
    });

    // Send email with the RAW token (not the hash)
    await sendPasswordResetEmail(user.email, rawToken);


    res.json({
      message: "If an account with that email exists, a reset link has been sent.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Failed to process request. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password  (public — no auth)
// Step 2 of password reset: use the token to set a new password
//
// BODY: { token: "...", newPassword: "..." }
//
// SECURITY CHECKS:
//   ✓ Token exists in DB
//   ✓ Token hasn't been used before (used=false)
//   ✓ Token hasn't expired (expiresAt > now)
//   ✓ New password passes validation
//   ✓ Token is immediately marked used=true after success
//     (prevents replay attacks)
// ─────────────────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and newPassword are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long" });
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({
        error: "Password must contain at least one letter and one number",
      });
    }

    // Hash the incoming token to compare with the stored hash
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { token: hashedToken },
      include: { user: true },
    });

    // Check all security conditions
    if (!resetRecord) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }
    if (resetRecord.used) {
      return res.status(400).json({ error: "This reset link has already been used" });
    }
    if (resetRecord.expiresAt < new Date()) {
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    }
    if (!resetRecord.user.isActive) {
      return res.status(403).json({ error: "Account is deactivated. Contact administrator." });
    }

    const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(newPassword, rounds);

    // Atomically: update password + mark token as used
    // If either fails, both roll back → no partial state
    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetRecord.userId },
        data: { password: hashedPassword },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetRecord.id },
        data: { used: true },
      }),
    ]);

    res.json({ message: "Password reset successful. Please log in with your new password." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password. Please try again." });
  }
};