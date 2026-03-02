const express = require("express");
const {
    getMyProfile,
    getMyAssignedBookings,
    updateAvailability,
    updateLocation,
} = require("../controllers/driver.controller");
const { authenticateToken, authorizeRoles } = require("../middleware/auth.middleware");

const router = express.Router();

// All routes below require DRIVER role
router.use(authenticateToken, authorizeRoles("DRIVER"));

// ─────────────────────────────────────────────
// GET /api/driver/me
// View own profile + total booking count
// ─────────────────────────────────────────────
router.get("/me", getMyProfile);

// ─────────────────────────────────────────────
// GET /api/driver/bookings?status=&page=&limit=
// View all bookings assigned to me
// ─────────────────────────────────────────────
router.get("/bookings", getMyAssignedBookings);

// ─────────────────────────────────────────────
// PATCH /api/driver/availability
// ─────────────────────────────────────────────
router.patch("/availability", updateAvailability);

// ─────────────────────────────────────────────
// PATCH /api/driver/location
// ─────────────────────────────────────────────
router.patch("/location", updateLocation);

module.exports = router;