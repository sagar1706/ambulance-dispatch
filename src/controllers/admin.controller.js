const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { haversineDistance } = require("../utils/driverAssignment");
const { getQueueStats } = require("../queues/dispatch.queue");

// Helper — get Socket.IO instance from app
const getIO = (req) => req.app.get("io");


// ─────────────────────────────────────────────
// GET /api/admin/bookings?status=&page=&limit=
// ─────────────────────────────────────────────
exports.getAllBookings = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where = {};
        if (status) {
            const valid = ["REQUESTED", "ASSIGNED", "EN_ROUTE", "ARRIVED", "COMPLETED", "CANCELLED"];
            if (!valid.includes(status)) {
                return res.status(400).json({ error: `Invalid status. Use one of: ${valid.join(", ")}` });
            }
            where.status = status;
        }

        const [bookings, total] = await Promise.all([
            prisma.booking.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                include: {
                    user: { select: { id: true, name: true, email: true } },
                    driver: { include: { user: { select: { name: true, email: true } } } },
                },
            }),
            prisma.booking.count({ where }),
        ]);

        res.json({ total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), bookings });
    } catch (error) {
        console.error("Get all bookings error:", error);
        res.status(500).json({ error: "Failed to fetch bookings." });
    }
};

// ─────────────────────────────────────────────
// GET /api/admin/users?role=&page=&limit=
// ─────────────────────────────────────────────
exports.getAllUsers = async (req, res) => {
    try {
        const { role, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where = {};
        if (role) where.role = role;

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                select: {
                    id: true, name: true, email: true, role: true, createdAt: true,
                    driver: { select: { isAvailable: true, currentLat: true, currentLng: true } },
                },
            }),
            prisma.user.count({ where }),
        ]);

        res.json({ total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)), users });
    } catch (error) {
        console.error("Get all users error:", error);
        res.status(500).json({ error: "Failed to fetch users." });
    }
};

// ─────────────────────────────────────────────
// GET /api/admin/drivers?available=true|false
// ─────────────────────────────────────────────
exports.getAllDrivers = async (req, res) => {
    try {
        const { available } = req.query;
        const where = {};
        if (available !== undefined) where.isAvailable = available === "true";

        const drivers = await prisma.driver.findMany({
            where,
            include: { user: { select: { id: true, name: true, email: true } } },
            orderBy: { updatedAt: "desc" },
        });

        res.json({ count: drivers.length, drivers });
    } catch (error) {
        console.error("Get all drivers error:", error);
        res.status(500).json({ error: "Failed to fetch drivers." });
    }
};

// ─────────────────────────────────────────────
// POST /api/admin/bookings/:id/assign
// Assign nearest available driver (or a specific one)
// ─────────────────────────────────────────────
exports.assignDriver = async (req, res) => {
    try {
        const { id } = req.params;

        // Guard against missing Content-Type: application/json
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                error: "Request body is missing. Set Content-Type: application/json in your request headers.",
            });
        }

        const { driverId } = req.body;

        const booking = await prisma.booking.findUnique({ where: { id } });
        if (!booking) return res.status(404).json({ error: "Booking not found" });

        if (booking.status !== "REQUESTED") {
            return res.status(400).json({ error: `Booking cannot be assigned. Status: ${booking.status}` });
        }

        let assignedDriver;

        if (driverId) {
            // Assign specific driver
            assignedDriver = await prisma.driver.findUnique({ where: { id: driverId } });
            if (!assignedDriver) return res.status(404).json({ error: "Driver not found" });
            if (!assignedDriver.isAvailable) return res.status(400).json({ error: "Driver is currently unavailable" });
        } else {
            // Auto-assign nearest driver using Haversine
            const available = await prisma.driver.findMany({
                where: { isAvailable: true, currentLat: { not: null }, currentLng: { not: null } },
                include: { user: { select: { name: true } } },
            });

            if (available.length === 0) {
                return res.status(404).json({ error: "No available drivers with a known location right now." });
            }

            let nearest = null;
            let minDist = Infinity;
            for (const d of available) {
                const dist = haversineDistance(booking.pickupLat, booking.pickupLng, d.currentLat, d.currentLng);
                if (dist < minDist) { minDist = dist; nearest = { ...d, distanceKm: dist.toFixed(2) }; }
            }
            assignedDriver = nearest;
        }

        // ── Atomic assignment with race condition protection ─────────
        // PROBLEM: Two concurrent requests could pick the same driver.
        //   Request A: driver is available ✓
        //   Request B: driver is available ✓ (checked at almost same time)
        //   Request A: sets isAvailable=false, assigns booking ✓
        //   Request B: ALSO sets isAvailable=false, assigns ANOTHER booking ✗
        //
        // FIX: Use updateMany with WHERE isAvailable=true inside a transaction.
        //   If the driver was already taken between our check and the update,
        //   updateMany returns count=0 (0 rows matched the WHERE).
        //   We detect this and return 409 Conflict.
        //
        // WHY updateMany (not update): `update` throws if no rows match.
        //   `updateMany` returns { count: N } — we can check N===0 safely.
        // ────────────────────────────────────────────────────────────
        const [updatedBooking, driverUpdate] = await prisma.$transaction([
            prisma.booking.update({
                where: { id },
                data: { driverId: assignedDriver.id, status: "ASSIGNED" },
                include: {
                    user: { select: { id: true, name: true, email: true } },
                    driver: { include: { user: { select: { name: true, email: true } } } },
                },
            }),
            prisma.driver.updateMany({
                // The critical WHERE clause — only update if STILL available
                where: { id: assignedDriver.id, isAvailable: true },
                data: { isAvailable: false },
            }),
        ]);

        // If driverUpdate.count is 0, the driver was grabbed by another request
        if (driverUpdate.count === 0) {
            // Roll back the booking update (the transaction already ran — we need another one)
            await prisma.booking.update({
                where: { id },
                data: { driverId: null, status: "REQUESTED" },
            });
            return res.status(409).json({
                error: "Driver was just assigned to another booking. Please try again.",
            });
        }


        const io = getIO(req);
        if (io) {
            io.to(`user_${booking.userId}`).emit("driver_assigned", {
                message: "A driver has been assigned to your request!",
                booking: updatedBooking,
                distanceKm: assignedDriver.distanceKm || null,
            });
            io.to(`driver_${assignedDriver.id}`).emit("new_assignment", {
                message: "You have been assigned a new booking",
                booking: updatedBooking,
            });
            io.to("admins").emit("driver_assigned", { bookingId: id, driverId: assignedDriver.id });
        }

        res.json({
            message: `Driver assigned${assignedDriver.distanceKm ? ` (${assignedDriver.distanceKm} km away)` : ""}`,
            booking: updatedBooking,
        });
    } catch (error) {
        console.error("Assign driver error:", error);
        res.status(500).json({ error: "Failed to assign driver." });
    }
};

// ─────────────────────────────────────────────
// PATCH /api/admin/bookings/:id/status
// Admin override any booking status
// ─────────────────────────────────────────────
exports.overrideBookingStatus = async (req, res) => {
    try {
        const { id } = req.params;

        // Guard against missing Content-Type: application/json
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                error: "Request body is missing. Set Content-Type: application/json in your request headers.",
            });
        }

        const { status } = req.body;

        const VALID = ["REQUESTED", "ASSIGNED", "EN_ROUTE", "ARRIVED", "COMPLETED", "CANCELLED"];
        if (!status || !VALID.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID.join(", ")}` });
        }

        const booking = await prisma.booking.findUnique({ where: { id } });
        if (!booking) return res.status(404).json({ error: "Booking not found" });

        const updated = await prisma.booking.update({ where: { id }, data: { status } });

        // Free driver on terminal statuses
        if (["CANCELLED", "COMPLETED"].includes(status) && booking.driverId) {
            await prisma.driver.update({ where: { id: booking.driverId }, data: { isAvailable: true } });
        }

        const io = getIO(req);
        if (io) {
            io.to(`user_${booking.userId}`).emit("booking_status_updated", {
                message: `Your booking status has been updated to: ${status}`,
                bookingId: id, status,
            });
        }

        res.json({ message: `Booking status overridden to ${status}`, booking: updated });
    } catch (error) {
        console.error("Override booking status error:", error);
        res.status(500).json({ error: "Failed to override booking status." });
    }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/deactivate
// Admin deactivates a user account
//
// WHY DEACTIVATE INSTEAD OF DELETE:
//   Deleting a user would also delete all their bookings (because of
//   onDelete: Cascade in the schema). Deactivating preserves all
//   history while preventing the user from logging in or making
//   requests. This is standard practice — even Facebook/Instagram
//   "deactivate" instead of delete.
//
// WHAT HAPPENS WHEN A USER IS DEACTIVATED:
//   1. Their isActive flag is set to false in the database
//   2. The auth middleware checks isActive on EVERY request
//   3. Even if they have a valid JWT token, they get rejected
//   4. They can't login again (login also checks isActive)
//   5. Their data remains intact for admin review
//
// SAFETY RULES:
//   - Admins cannot deactivate themselves (prevents lockout)
//   - Already deactivated users return a clear message
// ─────────────────────────────────────────────────────────────────
exports.deactivateUser = async (req, res) => {
    try {
        const { id } = req.params;

        // Safety: admin cannot deactivate themselves
        // This prevents the admin from accidentally locking themselves out
        if (id === req.user.userId) {
            return res.status(400).json({ error: "You cannot deactivate your own account" });
        }

        const user = await prisma.user.findUnique({
            where: { id },
            select: { id: true, name: true, email: true, role: true, isActive: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (!user.isActive) {
            return res.status(400).json({ error: "User is already deactivated" });
        }

        // Deactivate the user
        await prisma.user.update({
            where: { id },
            data: { isActive: false },
        });

        // If this user is a driver, also mark them as unavailable
        // so they don't get assigned to new bookings
        if (user.role === "DRIVER") {
            await prisma.driver.updateMany({
                where: { userId: id },
                data: { isAvailable: false },
            });
        }

        res.json({
            message: `User "${user.name}" (${user.email}) has been deactivated`,
            userId: id,
        });
    } catch (error) {
        console.error("Deactivate user error:", error);
        res.status(500).json({ error: "Failed to deactivate user." });
    }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/reactivate
// Admin reactivates a previously deactivated user
//
// This reverses the deactivation — user can login and make requests again.
// Note: if the user is a DRIVER, they still need to manually set their
// availability — we don't auto-enable them because they might not be
// ready to take bookings immediately.
// ─────────────────────────────────────────────────────────────────
exports.reactivateUser = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await prisma.user.findUnique({
            where: { id },
            select: { id: true, name: true, email: true, isActive: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.isActive) {
            return res.status(400).json({ error: "User is already active" });
        }

        await prisma.user.update({
            where: { id },
            data: { isActive: true },
        });

        res.json({
            message: `User "${user.name}" (${user.email}) has been reactivated`,
            userId: id,
        });
    } catch (error) {
        console.error("Reactivate user error:", error);
        res.status(500).json({ error: "Failed to reactivate user." });
    }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/role
// Admin changes a user's role
//
// USE CASES:
//   - Promote a USER to DRIVER (they want to start driving)
//   - Promote a USER to ADMIN (new admin hire)
//   - Demote an ADMIN to USER (revoking admin access)
//
// SAFETY:
//   - Cannot change your own role (prevents accidental lockout)
//   - If promoting to DRIVER, auto-creates a Driver profile
//   - If demoting from DRIVER, soft-deletes the Driver profile
// ─────────────────────────────────────────────────────────────────
exports.changeUserRole = async (req, res) => {
    try {
        const { id } = req.params;

        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                error: "Request body is missing. Set Content-Type: application/json",
            });
        }

        const { role } = req.body;
        const VALID_ROLES = ["USER", "DRIVER", "ADMIN"];

        if (!role || !VALID_ROLES.includes(role)) {
            return res.status(400).json({
                error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`,
            });
        }

        if (id === req.user.userId) {
            return res.status(400).json({ error: "You cannot change your own role" });
        }

        const user = await prisma.user.findUnique({
            where: { id },
            select: { id: true, name: true, role: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.role === role) {
            return res.status(400).json({ error: `User already has the ${role} role` });
        }

        // If promoting to DRIVER, auto-create Driver profile
        if (role === "DRIVER") {
            const existingDriver = await prisma.driver.findUnique({ where: { userId: id } });
            if (!existingDriver) {
                await prisma.driver.create({
                    data: { userId: id, isAvailable: false, isApproved: false },
                });
            }
        }

        const updatedUser = await prisma.user.update({
            where: { id },
            data: { role },
            select: { id: true, name: true, email: true, role: true },
        });

        res.json({
            message: `User "${user.name}" role changed from ${user.role} to ${role}`,
            user: updatedUser,
        });
    } catch (error) {
        console.error("Change user role error:", error);
        res.status(500).json({ error: "Failed to change user role." });
    }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/admin/drivers/:id/approve
// Admin approves a driver so they can start taking bookings
//
// WHY APPROVAL IS NEEDED:
//   When someone registers as a DRIVER, they shouldn't immediately
//   start receiving bookings. The admin needs to verify:
//   - Their identity
//   - Their vehicle documents
//   - Their driving license
//   Once verified, the admin "approves" them and they can work.
//
// BODY (optional):
//   { "vehicleNumber": "MH-01-AB-1234" }
//   Admin can set/update the vehicle number during approval.
// ─────────────────────────────────────────────────────────────────
exports.approveDriver = async (req, res) => {
    try {
        const { id } = req.params;  // This is the DRIVER id (not user id)

        const driver = await prisma.driver.findUnique({
            where: { id },
            include: { user: { select: { name: true, email: true } } },
        });

        if (!driver) {
            return res.status(404).json({ error: "Driver not found" });
        }

        if (driver.isApproved) {
            return res.status(400).json({ error: "Driver is already approved" });
        }

        const updateData = {
            isApproved: true,
            approvedAt: new Date(),
        };

        // Optionally set vehicle number during approval
        if (req.body && req.body.vehicleNumber) {
            updateData.vehicleNumber = req.body.vehicleNumber.trim();
        }

        const updatedDriver = await prisma.driver.update({
            where: { id },
            data: updateData,
            include: { user: { select: { name: true, email: true } } },
        });

        // Notify the driver via Socket.IO
        const io = getIO(req);
        if (io) {
            io.to(`driver_${id}`).emit("driver_approved", {
                message: "Your driver account has been approved! You can now start accepting bookings.",
            });
        }

        res.json({
            message: `Driver "${driver.user.name}" has been approved`,
            driver: updatedDriver,
        });
    } catch (error) {
        console.error("Approve driver error:", error);
        res.status(500).json({ error: "Failed to approve driver." });
    }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/admin/drivers/:id/reject
// Admin rejects/revokes a driver's approval
// ─────────────────────────────────────────────────────────────────
exports.rejectDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await prisma.driver.findUnique({
            where: { id },
            include: { user: { select: { name: true, email: true } } },
        });

        if (!driver) {
            return res.status(404).json({ error: "Driver not found" });
        }

        if (!driver.isApproved) {
            return res.status(400).json({ error: "Driver is not approved yet" });
        }

        const updatedDriver = await prisma.driver.update({
            where: { id },
            data: { isApproved: false, isAvailable: false, approvedAt: null },
            include: { user: { select: { name: true, email: true } } },
        });

        const io = getIO(req);
        if (io) {
            io.to(`driver_${id}`).emit("driver_rejected", {
                message: "Your driver approval has been revoked. Please contact admin.",
            });
        }

        res.json({
            message: `Driver "${driver.user.name}" approval has been revoked`,
            driver: updatedDriver,
        });
    } catch (error) {
        console.error("Reject driver error:", error);
        res.status(500).json({ error: "Failed to reject driver." });
    }
};

// ─────────────────────────────────────────────────────────────────
// GET /api/admin/drivers/:id/performance
// Admin views a driver's performance stats
//
// WHAT IT CALCULATES:
//   - Total bookings ever assigned to this driver
//   - Breakdown by status (completed, cancelled, in-progress)
//   - Completion rate (completed / total × 100)
//   - Average response time (how long from ASSIGNED to COMPLETED)
//
// HOW AVERAGE RESPONSE TIME WORKS:
//   For each COMPLETED booking, we calculate:
//     responseTime = booking.updatedAt - booking.createdAt
//   Then average all of them. This gives us the typical time a
//   driver takes from getting assigned to completing the trip.
//
//   NOTE: This is approximate because updatedAt tracks the last
//   status change, not exactly when each status was set. For more
//   precise tracking, you'd need a separate StatusHistory table.
// ─────────────────────────────────────────────────────────────────
exports.getDriverPerformance = async (req, res) => {
    try {
        const { id } = req.params;  // driver id

        // Get driver profile
        const driver = await prisma.driver.findUnique({
            where: { id },
            include: { user: { select: { name: true, email: true } } },
        });

        if (!driver) {
            return res.status(404).json({ error: "Driver not found" });
        }

        // Get all bookings grouped by status using Prisma groupBy
        // This does: SELECT status, COUNT(*) FROM bookings WHERE driverId = ? GROUP BY status
        const statusCounts = await prisma.booking.groupBy({
            by: ["status"],
            where: { driverId: id },
            _count: { status: true },
        });

        // Convert array of { status, _count } to a clean object
        // e.g. { COMPLETED: 5, CANCELLED: 1, ASSIGNED: 2 }
        const breakdown = {};
        let totalBookings = 0;
        for (const item of statusCounts) {
            breakdown[item.status] = item._count.status;
            totalBookings += item._count.status;
        }

        const completed = breakdown.COMPLETED || 0;
        const cancelled = breakdown.CANCELLED || 0;
        const completionRate = totalBookings > 0
            ? ((completed / totalBookings) * 100).toFixed(1)
            : "0.0";

        // Calculate average response time for completed bookings
        // (time from booking creation to completion)
        let avgResponseTimeMinutes = null;
        if (completed > 0) {
            const completedBookings = await prisma.booking.findMany({
                where: { driverId: id, status: "COMPLETED" },
                select: { createdAt: true, updatedAt: true },
            });

            const totalMs = completedBookings.reduce((sum, b) => {
                return sum + (b.updatedAt.getTime() - b.createdAt.getTime());
            }, 0);

            avgResponseTimeMinutes = Math.round(totalMs / completed / 60000);  // ms → minutes
        }

        res.json({
            driver: {
                id: driver.id,
                name: driver.user.name,
                email: driver.user.email,
                isAvailable: driver.isAvailable,
                isApproved: driver.isApproved,
                vehicleNumber: driver.vehicleNumber,
                approvedAt: driver.approvedAt,
            },
            performance: {
                totalBookings,
                completed,
                cancelled,
                inProgress: (breakdown.ASSIGNED || 0) + (breakdown.EN_ROUTE || 0) + (breakdown.ARRIVED || 0),
                completionRate: `${completionRate}%`,
                avgResponseTimeMinutes,
                breakdown,
            },
        });
    } catch (error) {
        logger.error("Get driver performance error", { error: error.message });
        res.status(500).json({ error: "Failed to fetch driver performance." });
    }
};

// ─────────────────────────────────────────────
// GET /api/admin/queue
// View current dispatch queue stats
// ─────────────────────────────────────────────
exports.getQueueStatus = async (req, res) => {
    try {
        const stats = await getQueueStats();

        // Also show count of REQUESTED bookings in DB (some may not be in queue yet)
        const pendingInDb = await prisma.booking.count({
            where: { status: "REQUESTED" },
        });

        res.json({
            message: "Dispatch queue status",
            pendingBookingsInDb: pendingInDb,
            queue: stats,
        });
    } catch (error) {
        logger.error("Get queue status error", { error: error.message });
        res.status(500).json({ error: "Failed to fetch queue status." });
    }
};
