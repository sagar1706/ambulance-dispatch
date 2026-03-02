const express = require("express");
const {
    getAllBookings,
    getAllUsers,
    getAllDrivers,
    assignDriver,
    overrideBookingStatus,
    deactivateUser,
    reactivateUser,
    changeUserRole,
    approveDriver,
    rejectDriver,
    getDriverPerformance,
} = require("../controllers/admin.controller");
const { authenticateToken, authorizeRoles } = require("../middleware/auth.middleware");

const router = express.Router();

// Every admin route requires JWT + ADMIN role
router.use(authenticateToken, authorizeRoles("ADMIN"));

// ── Bookings ──
router.get("/bookings", getAllBookings);                      // GET all bookings (filterable)
router.post("/bookings/:id/assign", assignDriver);           // Assign nearest driver
router.patch("/bookings/:id/status", overrideBookingStatus); // Override status

// ── Users ──
router.get("/users", getAllUsers);                            // GET all users (filterable by role)
router.patch("/users/:id/deactivate", deactivateUser);       // Ban/deactivate a user
router.patch("/users/:id/reactivate", reactivateUser);       // Unban/reactivate a user
router.patch("/users/:id/role", changeUserRole);             // Change user role

// ── Drivers ──
router.get("/drivers", getAllDrivers);                        // GET all drivers (filterable)
router.patch("/drivers/:id/approve", approveDriver);         // Approve a driver
router.patch("/drivers/:id/reject", rejectDriver);           // Reject/revoke a driver
router.get("/drivers/:id/performance", getDriverPerformance); // View driver stats

module.exports = router;
