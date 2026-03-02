const express = require("express");
const { getMyProfile, updateMyProfile } = require("../controllers/user.controller");
const { authenticateToken } = require("../middleware/auth.middleware");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// All user routes require authentication (valid JWT token)
// but do NOT require a specific role — any logged-in user
// (USER, DRIVER, or ADMIN) can view/edit their own profile.
//
// WHY NO authorizeRoles() HERE:
//   Unlike driver routes (DRIVER only) or admin routes (ADMIN only),
//   profile management is universal.  Every user should be able to
//   see and update their own name/email regardless of role.
// ─────────────────────────────────────────────────────────────────
router.use(authenticateToken);

// ─────────────────────────────────────────────────────────────────
// GET /api/user/me
//
// Returns the logged-in user's profile with:
//   - Basic info (name, email, role, createdAt)
//   - Driver profile (if they have one)
//   - Total booking count
//
// Uses the JWT token to identify WHICH user, so no need to pass
// a user ID in the URL — the server already knows who you are.
// ─────────────────────────────────────────────────────────────────
router.get("/me", getMyProfile);

// ─────────────────────────────────────────────────────────────────
// PATCH /api/user/me
//
// Updates the logged-in user's name and/or email.
//
// WHY PATCH (not PUT):
//   PUT means "replace the entire resource" — you'd need to send
//   ALL fields even if you only want to change one.
//   PATCH means "partial update" — send only what you want to change.
//
//   Example: To change just the name:
//     PATCH /api/user/me  { "name": "New Name" }
//   The email stays unchanged because you didn't include it.
//
// WHAT YOU CANNOT CHANGE HERE:
//   - role (only admins can change roles)
//   - password (use /api/auth/change-password instead — coming soon)
// ─────────────────────────────────────────────────────────────────
router.patch("/me", updateMyProfile);

module.exports = router;
