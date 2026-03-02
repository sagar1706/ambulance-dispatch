const express = require("express");
const rateLimit = require("express-rate-limit");
const { register, login, changePassword, forgotPassword, resetPassword } = require("../controllers/auth.controller");
const { authenticateToken } = require("../middleware/auth.middleware");

const router = express.Router();

const makeRateLimiter = (max, windowMs, message) => rateLimit({
    windowMs, max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: { error: message },
});

const loginLimiter = makeRateLimiter(
    parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
    parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    "Too many login attempts from this IP. Please try again after 15 minutes."
);
const registerLimiter = makeRateLimiter(
    parseInt(process.env.REGISTER_RATE_LIMIT_MAX) || 20,
    parseInt(process.env.REGISTER_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
    "Too many registration attempts from this IP. Please try again after an hour."
);
// Tight limit on password reset to prevent abuse (token flooding)
const resetLimiter = makeRateLimiter(
    parseInt(process.env.RESET_RATE_LIMIT_MAX) || 5,
    parseInt(process.env.RESET_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
    "Too many password reset attempts. Please try again after an hour."
);

// ── Routes ────────────────────────────────────────────────────────
router.post("/register", registerLimiter, register);
router.post("/login", loginLimiter, login);
router.patch("/change-password", authenticateToken, changePassword);   // requires JWT
router.post("/forgot-password", resetLimiter, forgotPassword);    // public
router.post("/reset-password", resetLimiter, resetPassword);     // public

module.exports = router;