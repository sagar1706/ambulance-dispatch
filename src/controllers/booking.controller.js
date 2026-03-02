const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { findNearestDriver, assignDriverToBooking } = require("../utils/driverAssignment");
const { addToDispatchQueue, triggerQueueProcessing } = require("../queues/dispatch.queue");

// Helper — get Socket.IO instance attached to app
const getIO = (req) => req.app.get("io");

// ─────────────────────────────────────────────
// POST /api/booking
// USER: Request an ambulance
// ─────────────────────────────────────────────
exports.createBooking = async (req, res) => {
    try {
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                error: "Request body is missing. Set Content-Type: application/json in your request headers.",
            });
        }

        const { pickupLat, pickupLng } = req.body;

        if (pickupLat === undefined || pickupLng === undefined) {
            return res.status(400).json({ error: "pickupLat and pickupLng are required" });
        }

        const lat = parseFloat(pickupLat);
        const lng = parseFloat(pickupLng);

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({ error: "pickupLat and pickupLng must be valid numbers" });
        }

        if (lat < -90 || lat > 90) {
            return res.status(400).json({ error: "pickupLat must be between -90 and 90" });
        }

        if (lng < -180 || lng > 180) {
            return res.status(400).json({ error: "pickupLng must be between -180 and 180" });
        }

        // Prevent duplicate active bookings per user
        const activeBooking = await prisma.booking.findFirst({
            where: {
                userId: req.user.userId,
                status: { in: ["REQUESTED", "ASSIGNED", "EN_ROUTE", "ARRIVED"] },
            },
        });

        if (activeBooking) {
            return res.status(409).json({
                error: "You already have an active booking. Please wait or cancel it first.",
                bookingId: activeBooking.id,
            });
        }

        const booking = await prisma.booking.create({
            data: {
                userId: req.user.userId,
                pickupLat: lat,
                pickupLng: lng,
                status: "REQUESTED",
            },
            include: {
                user: { select: { id: true, name: true, email: true } },
            },
        });

        const io = getIO(req);

        // ── Try immediate auto-assign ─────────────────────────────
        // Instead of making the user wait for admin to manually assign,
        // we immediately try to find the nearest available driver.
        // If found    → assign right now, return 201 with driver info
        // If not found → add to queue, return 202 (accepted, being processed)
        const nearestDriver = await findNearestDriver(lat, lng);

        if (nearestDriver) {
            try {
                const { booking: assignedBooking } = await assignDriverToBooking(booking.id, nearestDriver);

                // Real-time notifications
                if (io) {
                    io.to("admins").emit("new_booking", { booking: assignedBooking });
                    io.to(`user_${req.user.userId}`).emit("driver_assigned", {
                        message: "Driver found and is on the way!",
                        booking: assignedBooking,
                        distanceKm: nearestDriver.distanceKm,
                    });
                    io.to(`driver_${nearestDriver.id}`).emit("new_assignment", {
                        message: "You have a new booking",
                        booking: assignedBooking,
                    });
                    io.to("admins").emit("driver_assigned", {
                        bookingId: booking.id,
                        driverId: nearestDriver.id,
                    });
                }

                logger.info("Booking created and immediately assigned", {
                    bookingId: booking.id,
                    driverId: nearestDriver.id,
                    distanceKm: nearestDriver.distanceKm,
                });

                return res.status(201).json({
                    message: `Ambulance assigned and on the way! Driver is ${nearestDriver.distanceKm} km away.`,
                    booking: assignedBooking,
                    assigned: true,
                });
            } catch (assignErr) {
                // Race condition — another booking grabbed the driver between
                // our check and the assignment. Fall through to queue.
                logger.warn("Immediate assignment failed (race condition) — falling back to queue", {
                    bookingId: booking.id,
                });
            }
        }

        // ── No driver available — add to queue ────────────────────
        // Notify admins about the new booking
        if (io) {
            io.to("admins").emit("new_booking", {
                message: "New ambulance request — no driver currently available",
                booking,
            });
        }

        // Add to dispatch queue — worker will auto-assign when a driver frees up
        const job = await addToDispatchQueue(booking);

        // Get current queue position for user feedback
        let queueMessage = "No drivers available right now. You've been added to the queue.";
        if (job) {
            // Count bookings ahead in queue
            const queuePosition = await prisma.booking.count({
                where: {
                    status: "REQUESTED",
                    createdAt: { lt: booking.createdAt },
                },
            });
            queueMessage = `No drivers available. You're #${queuePosition + 1} in the queue. We'll assign a driver as soon as one is available.`;
        }

        logger.info("Booking created and added to dispatch queue", { bookingId: booking.id });

        // 202 Accepted = request received and being processed (not yet fulfilled)
        return res.status(202).json({
            message: queueMessage,
            booking,
            assigned: false,
            queued: !!job,
        });
    } catch (error) {
        logger.error("Create booking error", { error: error.message });
        res.status(500).json({ error: "Failed to create booking. Please try again." });
    }
};

// ─────────────────────────────────────────────────────────────────
// GET /api/booking/my
// USER: Get own booking history with filters + pagination
//
// QUERY PARAMS (all optional):
//   ?status=COMPLETED     → filter by one status
//   ?from=2026-01-01      → bookings on or after this date
//   ?to=2026-02-28        → bookings on or before this date
//   ?sort=newest          → newest first (default)
//   ?sort=oldest          → oldest first
//   ?page=1               → page number (default: 1)
//   ?limit=10             → items per page (default: 10, max: 50)
//
// HOW FILTERING WORKS:
//   We build a Prisma `where` object dynamically.
//   Each query param that's provided adds a condition to `where`.
//   Params that aren't provided are simply skipped.
//
// HOW PAGINATION WORKS:
//   - skip = (page - 1) * limit  → how many records to skip
//   - take = limit               → how many records to return
//   - Both count + findMany run in parallel via Promise.all = faster
//
// WHY RETURN METADATA:
//   Frontend needs: are there more pages?
//   So we return: total, page, totalPages, hasNextPage
// ─────────────────────────────────────────────────────────────────
exports.getMyBookings = async (req, res) => {
    try {
        const {
            status,
            from,
            to,
            sort = "newest",
            page = "1",
            limit = "10",
        } = req.query;

        // ── Validate status ──
        const VALID_STATUSES = ["REQUESTED", "ASSIGNED", "EN_ROUTE", "ARRIVED", "COMPLETED", "CANCELLED"];
        if (status && !VALID_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Use one of: ${VALID_STATUSES.join(", ")}`,
            });
        }

        // ── Validate sort ──
        if (!["newest", "oldest"].includes(sort)) {
            return res.status(400).json({ error: "Invalid sort. Use 'newest' or 'oldest'" });
        }

        // ── Validate + clamp pagination ──
        // Math.max(1, ...) → minimum page 1
        // Math.min(50, ...) → limit capped at 50, prevents fetching 10000 records at once
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 10));
        const skip = (pageNum - 1) * limitNum;

        // ── Build WHERE clause dynamically ──
        const where = { userId: req.user.userId };

        if (status) {
            where.status = status;
        }

        // Date range: "from" and "to" are YYYY-MM-DD strings
        if (from || to) {
            where.createdAt = {};
            if (from) {
                const fromDate = new Date(from);
                if (isNaN(fromDate)) {
                    return res.status(400).json({ error: "Invalid 'from' date. Use YYYY-MM-DD" });
                }
                where.createdAt.gte = fromDate;  // gte = greater than or equal
            }
            if (to) {
                const toDate = new Date(to);
                if (isNaN(toDate)) {
                    return res.status(400).json({ error: "Invalid 'to' date. Use YYYY-MM-DD" });
                }
                // Set to end of the "to" day so the full day is included
                toDate.setHours(23, 59, 59, 999);
                where.createdAt.lte = toDate;    // lte = less than or equal
            }
        }

        // ── Run count + findMany in parallel (faster than sequential) ──
        const [bookings, total] = await Promise.all([
            prisma.booking.findMany({
                where,
                skip,
                take: limitNum,
                orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
                include: {
                    driver: {
                        select: {
                            id: true,
                            isAvailable: true,
                            vehicleNumber: true,
                            currentLat: true,
                            currentLng: true,
                            user: { select: { name: true, email: true } },
                        },
                    },
                },
            }),
            prisma.booking.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limitNum);

        res.json({
            // Pagination metadata
            total,
            page: pageNum,
            totalPages,
            hasNextPage: pageNum < totalPages,
            limit: limitNum,
            // Echo back applied filters so frontend knows what's active
            filters: {
                status: status || null,
                from: from || null,
                to: to || null,
                sort,
            },
            bookings,
        });
    } catch (error) {
        console.error("Get my bookings error:", error);
        res.status(500).json({ error: "Failed to fetch bookings." });
    }
};

// ─────────────────────────────────────────────
// GET /api/booking/:id
// USER / DRIVER / ADMIN: View single booking
// ─────────────────────────────────────────────
exports.getBookingById = async (req, res) => {
    try {
        const { id } = req.params;

        const booking = await prisma.booking.findUnique({
            where: { id },
            include: {
                user: { select: { id: true, name: true, email: true } },
                driver: {
                    include: { user: { select: { name: true, email: true } } },
                },
            },
        });

        if (!booking) {
            return res.status(404).json({ error: "Booking not found" });
        }

        // USERs can only see their own bookings
        if (req.user.role === "USER" && booking.userId !== req.user.userId) {
            return res.status(403).json({ error: "You are not authorized to view this booking" });
        }

        res.json({ booking });
    } catch (error) {
        console.error("Get booking error:", error);
        res.status(500).json({ error: "Failed to fetch booking." });
    }
};

// ─────────────────────────────────────────────
// PATCH /api/booking/:id/cancel
// USER: Cancel their own booking (only if REQUESTED or ASSIGNED)
// ─────────────────────────────────────────────
exports.cancelBooking = async (req, res) => {
    try {
        const { id } = req.params;

        const booking = await prisma.booking.findUnique({ where: { id } });

        if (!booking) {
            return res.status(404).json({ error: "Booking not found" });
        }

        if (booking.userId !== req.user.userId) {
            return res.status(403).json({ error: "You can only cancel your own bookings" });
        }

        if (!["REQUESTED", "ASSIGNED"].includes(booking.status)) {
            return res.status(400).json({
                error: `Cannot cancel a booking with status: ${booking.status}`,
            });
        }

        const updated = await prisma.booking.update({
            where: { id },
            data: { status: "CANCELLED" },
        });

        // Free up the driver if they were assigned
        if (booking.driverId) {
            await prisma.driver.update({
                where: { id: booking.driverId },
                data: { isAvailable: true },
            });
            // A driver just became free — wake up the queue to assign them
            // to the next waiting booking
            await triggerQueueProcessing(booking.driverId);
        }

        const io = getIO(req);
        if (io) {
            io.to("admins").emit("booking_cancelled", { bookingId: id });
            if (booking.driverId) {
                io.to(`driver_${booking.driverId}`).emit("booking_cancelled", {
                    message: "Booking was cancelled by the user",
                    bookingId: id,
                });
            }
        }

        res.json({ message: "Booking cancelled successfully", booking: updated });
    } catch (error) {
        console.error("Cancel booking error:", error);
        res.status(500).json({ error: "Failed to cancel booking." });
    }
};

// ─────────────────────────────────────────────
// PATCH /api/booking/:id/status
// DRIVER: Progress booking status along the lifecycle
// ASSIGNED → EN_ROUTE → ARRIVED → COMPLETED
// ─────────────────────────────────────────────
exports.updateBookingStatus = async (req, res) => {
    try {
        const { id } = req.params;

        // Guard against missing Content-Type: application/json
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                error: "Request body is missing. Set Content-Type: application/json in your request headers.",
            });
        }

        const { status } = req.body;

        const ALLOWED_TRANSITIONS = {
            ASSIGNED: "EN_ROUTE",
            EN_ROUTE: "ARRIVED",
            ARRIVED: "COMPLETED",
        };

        if (!status) {
            return res.status(400).json({ error: "status is required in the request body" });
        }

        const booking = await prisma.booking.findUnique({ where: { id } });

        if (!booking) {
            return res.status(404).json({ error: "Booking not found" });
        }

        // Verify this driver owns the booking
        const driver = await prisma.driver.findUnique({ where: { userId: req.user.userId } });

        if (!driver) {
            return res.status(404).json({ error: "Driver profile not found for your account" });
        }

        if (booking.driverId !== driver.id) {
            return res.status(403).json({
                error: "You are not the assigned driver for this booking",
                assignedDriverId: booking.driverId,
                yourDriverId: driver.id,
            });
        }

        // Validate status transition
        const allowedNext = ALLOWED_TRANSITIONS[booking.status];
        if (!allowedNext) {
            return res.status(400).json({
                error: `Booking is in '${booking.status}' status which cannot be progressed further`,
            });
        }
        if (status !== allowedNext) {
            return res.status(400).json({
                error: `Invalid transition. From '${booking.status}' you can only move to '${allowedNext}'`,
            });
        }

        const updated = await prisma.booking.update({
            where: { id },
            data: { status },
        });

        // When completed, mark the driver as available again
        // AND wake up the queue to assign them to a waiting booking
        if (status === "COMPLETED") {
            await prisma.driver.update({
                where: { id: driver.id },
                data: { isAvailable: true },
            });
            // Trigger queue: this driver is now free, assign to next waiting booking
            await triggerQueueProcessing(driver.id);
        }

        const io = getIO(req);
        if (io) {
            io.to(`user_${booking.userId}`).emit("booking_status_updated", {
                message: `Your booking status changed to: ${status}`,
                bookingId: id,
                status,
            });
            io.to("admins").emit("booking_status_updated", { bookingId: id, status });
        }

        res.json({ message: `Booking updated to ${status}`, booking: updated });
    } catch (error) {
        console.error("Update booking status error:", error);
        res.status(500).json({ error: "Failed to update booking status." });
    }
};
