const express = require("express");
const {
    createBooking,
    getMyBookings,
    getBookingById,
    cancelBooking,
    updateBookingStatus,
} = require("../controllers/booking.controller");
const { authenticateToken, authorizeRoles } = require("../middleware/auth.middleware");

const router = express.Router();

// All booking routes require a valid JWT
router.use(authenticateToken);

// ── USER ──
router.post("/", authorizeRoles("USER"), createBooking);                      // Request ambulance
router.get("/my", authorizeRoles("USER"), getMyBookings);                     // My booking history
router.patch("/:id/cancel", authorizeRoles("USER"), cancelBooking);           // Cancel my booking

// ── DRIVER ──
router.patch("/:id/status", authorizeRoles("DRIVER"), updateBookingStatus);   // Progress status

// ── SHARED ──
router.get("/:id", authorizeRoles("USER", "DRIVER", "ADMIN"), getBookingById); // View single booking

module.exports = router;
