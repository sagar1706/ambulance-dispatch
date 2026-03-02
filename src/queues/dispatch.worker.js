// ─────────────────────────────────────────────────────────────────
// Dispatch Worker — processes jobs from the dispatch queue
//
// WHAT IS A WORKER?
//   The queue is just the "waiting room."
//   The worker is the "staff" that processes each person in the room.
//
//   Queue:  [ booking_1, booking_2, booking_3 ]  (stored in Redis)
//   Worker: picks up one job at a time, tries to assign a driver
//
// HOW BULLMQ WORKER WORKS:
//   1. Worker connects to Redis and polls the queue
//   2. Picks up the next job (or waits if queue is empty)
//   3. Calls our processJob() function with the job data
//   4. If processJob() returns → job marked as COMPLETED ✓
//   5. If processJob() throws → job marked as FAILED, scheduled for retry
//   6. After MAX_ATTEMPTS failures → job goes to "failed" state permanently
//
// CONCURRENCY = 1:
//   We process ONE job at a time. Why?
//   If two jobs run simultaneously, they might pick the SAME driver
//   and cause a race condition. The atomic transaction handles this,
//   but it's cleaner to process sequentially.
//
// WHAT TRIGGERS PROCESSING:
//   1. New job added (booking with no driver)
//   2. "driver-available" priority job added (driver just freed up)
// ─────────────────────────────────────────────────────────────────

const { Worker } = require("bullmq");
const { getRedis, isRedisAvailable } = require("../config/redis");
const prisma = require("../config/prisma");
const { findNearestDriver, assignDriverToBooking } = require("../utils/driverAssignment");
const logger = require("../utils/logger");

const QUEUE_NAME = "ambulance-dispatch";
let dispatchWorker = null;

// ─────────────────────────────────────────────────────────────────
// Main job processor — called for every job in the queue
// ─────────────────────────────────────────────────────────────────
async function processJob(job) {
    const { name, data } = job;

    logger.info("Dispatch worker: Processing job", {
        jobId: job.id,
        jobName: name,
        attempt: job.attemptsMade + 1,
        data,
    });

    // ── Job type: "driver-available" ─────────────────────────────
    // A driver just became free. Process ALL waiting bookings in order.
    // This is like "next patient please" at a reception desk.
    if (name === "driver-available") {
        return await processAllPendingBookings(job, data.driverId);
    }

    // ── Job type: "find-driver" ──────────────────────────────────
    // A specific booking is waiting for a driver.
    if (name === "find-driver") {
        return await processSingleBooking(job, data);
    }

    logger.warn("Dispatch worker: Unknown job type", { jobName: name });
}

// ─────────────────────────────────────────────────────────────────
// Process a single "find-driver" job
// Called when a booking was created with no available driver
// ─────────────────────────────────────────────────────────────────
async function processSingleBooking(job, data) {
    const { bookingId, pickupLat, pickupLng } = data;

    // ── Step 1: Re-check booking status ─────────────────────────
    // The booking might have been cancelled or manually assigned
    // between when it was queued and when we process it.
    // No point finding a driver for a booking that's no longer pending.
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { id: true, status: true, driverId: true, userId: true },
    });

    if (!booking) {
        logger.warn("Dispatch worker: Booking not found — skipping", { bookingId });
        return { skipped: true, reason: "booking deleted" };
    }

    if (booking.status !== "REQUESTED") {
        logger.info("Dispatch worker: Booking no longer pending — skipping", {
            bookingId,
            currentStatus: booking.status,
        });
        return { skipped: true, reason: `booking status is ${booking.status}` };
    }

    // ── Step 2: Find nearest available driver ─────────────────
    const driver = await findNearestDriver(pickupLat, pickupLng);

    if (!driver) {
        // No driver available yet — throw to trigger BullMQ retry
        // BullMQ will retry after RETRY_DELAY_MS (30 seconds by default)
        const attemptsLeft = (job.opts.attempts || 20) - job.attemptsMade - 1;
        logger.info("Dispatch worker: No driver available — will retry", {
            bookingId,
            attemptsLeft,
            retryIn: "30s",
        });
        throw new Error(`No available drivers for booking ${bookingId}`);
    }

    // ── Step 3: Assign driver atomically ─────────────────────
    const { booking: updatedBooking } = await assignDriverToBooking(bookingId, driver);

    // ── Step 4: Emit Socket.IO notification ──────────────────
    // The worker doesn't have access to req.app.get("io")
    // so we stored io on the global app instance
    const io = global._io;
    if (io) {
        io.to(`user_${booking.userId}`).emit("driver_assigned", {
            message: "A driver has been assigned to your request! They're on the way.",
            booking: updatedBooking,
            distanceKm: driver.distanceKm,
            queueWait: true,  // tell frontend this was a queued assignment
        });
        io.to(`driver_${driver.id}`).emit("new_assignment", {
            message: "You have been assigned a new booking",
            booking: updatedBooking,
        });
        io.to("admins").emit("driver_assigned", {
            bookingId,
            driverId: driver.id,
            fromQueue: true,
        });
    }

    logger.info("Dispatch worker: Booking assigned from queue", {
        bookingId,
        driverId: driver.id,
        distanceKm: driver.distanceKm,
    });

    return { assigned: true, bookingId, driverId: driver.id };
}

// ─────────────────────────────────────────────────────────────────
// Process all pending bookings when a driver becomes available
// Called when a driver completes/cancels their current booking
// ─────────────────────────────────────────────────────────────────
async function processAllPendingBookings(job, freedDriverId) {
    // Find the oldest unassigned booking (FIFO - fairness)
    const oldestPending = await prisma.booking.findFirst({
        where: { status: "REQUESTED" },
        orderBy: { createdAt: "asc" },     // oldest first = fair queue order
        select: { id: true, pickupLat: true, pickupLng: true, userId: true },
    });

    if (!oldestPending) {
        logger.info("Dispatch worker: No pending bookings — driver freed but nothing to assign", {
            driverId: freedDriverId,
        });
        return { assigned: false, reason: "no pending bookings" };
    }

    // Find nearest driver (could be different from the one just freed
    // if a closer driver is also now available)
    const driver = await findNearestDriver(oldestPending.pickupLat, oldestPending.pickupLng);

    if (!driver) {
        logger.info("Dispatch worker: Driver became available but already taken", {
            freedDriverId,
        });
        return { assigned: false, reason: "driver already taken" };
    }

    try {
        const { booking: updatedBooking } = await assignDriverToBooking(oldestPending.id, driver);

        const io = global._io;
        if (io) {
            io.to(`user_${oldestPending.userId}`).emit("driver_assigned", {
                message: "A driver has been found for your request! They're on the way.",
                booking: updatedBooking,
                distanceKm: driver.distanceKm,
                queueWait: true,
            });
            io.to(`driver_${driver.id}`).emit("new_assignment", {
                message: "You have been assigned a new booking",
                booking: updatedBooking,
            });
            io.to("admins").emit("driver_assigned", {
                bookingId: oldestPending.id,
                driverId: driver.id,
                fromQueue: true,
            });
        }

        logger.info("Dispatch worker: Pending booking auto-assigned on driver free", {
            bookingId: oldestPending.id,
            driverId: driver.id,
            distanceKm: driver.distanceKm,
        });

        return { assigned: true, bookingId: oldestPending.id, driverId: driver.id };
    } catch (err) {
        if (err.message.includes("RACE_CONDITION")) {
            logger.warn("Dispatch worker: Race condition on driver-available — retrying not needed", {
                bookingId: oldestPending.id,
            });
            return { assigned: false, reason: "race condition" };
        }
        throw err;
    }
}

// ─────────────────────────────────────────────────────────────────
// Initialize the worker — call at server startup
// ─────────────────────────────────────────────────────────────────
function initDispatchWorker() {
    if (!isRedisAvailable()) {
        logger.warn("Dispatch worker: Redis not available — worker not started");
        return null;
    }

    dispatchWorker = new Worker(QUEUE_NAME, processJob, {
        connection: getRedis(),
        concurrency: 1,   // process ONE job at a time (prevents race conditions)

        // Stalled job timeout: if a job runs > 30s, mark it as stalled
        // (protects against worker crash mid-job)
        stalledInterval: 30_000,
    });

    // ── Worker event handlers ─────────────────────────────────────
    dispatchWorker.on("completed", (job, result) => {
        logger.info("Dispatch worker: Job completed", {
            jobId: job.id,
            result,
        });
    });

    dispatchWorker.on("failed", (job, err) => {
        const attemptsLeft = (job.opts.attempts || 20) - job.attemptsMade;
        if (attemptsLeft > 0) {
            logger.warn("Dispatch worker: Job failed — will retry", {
                jobId: job.id,
                bookingId: job.data.bookingId,
                error: err.message,
                attemptsLeft,
            });
        } else {
            logger.error("Dispatch worker: Job exhausted all retries", {
                jobId: job.id,
                bookingId: job.data.bookingId,
                error: err.message,
            });
            // In a real system, you'd alert the admin here:
            // sendAdminAlert(`Booking ${job.data.bookingId} could not be auto-assigned after 20 tries`)
        }
    });

    dispatchWorker.on("error", (err) => {
        logger.error("Dispatch worker: Worker error", { error: err.message });
    });

    logger.info("Dispatch worker: Started", { queue: QUEUE_NAME, concurrency: 1 });
    return dispatchWorker;
}

// ─────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────
async function closeDispatchWorker() {
    if (dispatchWorker) {
        // graceful: finish current job, then stop
        await dispatchWorker.close();
        logger.info("Dispatch worker: Closed gracefully");
    }
}

module.exports = { initDispatchWorker, closeDispatchWorker };
