// ─────────────────────────────────────────────────────────────────
// Dispatch Queue — the "waiting room" for bookings with no driver
//
// WHAT IS A QUEUE?
//   A queue is like a line at a hospital reception desk.
//   Patients (bookings) arrive. If a doctor (driver) is free,
//   they get seen immediately. If all doctors are busy, the
//   patient waits in line and gets the next available doctor.
//
// WHY BULLMQ?
//   BullMQ is a production-grade job queue built on Redis.
//   It gives us:
//     - Persistence: jobs survive server restarts (stored in Redis)
//     - Retries: if assignment fails (no driver), retry later
//     - Delayed jobs: retry in 30s, not immediately
//     - Visibility: see all waiting/failed/completed jobs
//     - Concurrency control: only process one job at a time
//     - Job events: emit Socket.IO notifications on completion
//
// HOW IT WORKS:
//   1. createBooking → no driver available
//   2. Add job to this queue: { bookingId, pickupLat, pickupLng }
//   3. Worker (dispatch.worker.js) picks up the job
//   4. Worker finds nearest available driver
//   5. If found: assign → emit Socket.IO → job done ✓
//   6. If not found: throw error → BullMQ retries after RETRY_DELAY
//   7. After MAX_RETRIES failures: job goes to "failed" state
//      Booking stays REQUESTED — admin can manually assign
//
// QUEUE SETTINGS:
//   - attempts: 20 retries = 20 × 30s = 10 minutes of waiting
//   - removeOnComplete: true = don't clog Redis with old done jobs
//   - removeOnFail: keep last 100 failed jobs for debugging
// ─────────────────────────────────────────────────────────────────

const { Queue } = require("bullmq");
const { getRedis, isRedisAvailable } = require("../config/redis");
const logger = require("../utils/logger");

const QUEUE_NAME = "ambulance-dispatch";

// How long to wait before retrying (30 seconds)
// Why 30s? Short enough to feel responsive, long enough to not spam DB
const RETRY_DELAY_MS = parseInt(process.env.QUEUE_RETRY_DELAY_MS) || 30_000;

// Max retries: 20 × 30s = 10 minutes of persistence
const MAX_ATTEMPTS = parseInt(process.env.QUEUE_MAX_ATTEMPTS) || 20;

let dispatchQueue = null;

// ── Initialize the queue ──────────────────────────────────────────
// Called once at server startup (from server.js)
function initDispatchQueue() {
    if (!isRedisAvailable()) {
        logger.warn("Dispatch queue: Redis not available — queue disabled");
        return null;
    }

    // BullMQ requires its own dedicated ioredis connection
    // (separate from the connection used by the Worker)
    // We pass the connection directly so BullMQ doesn't create a new one
    dispatchQueue = new Queue(QUEUE_NAME, {
        connection: getRedis(),
        defaultJobOptions: {
            // ── Retry policy ────────────────────────────────────────
            // attempts: total tries including the first one
            attempts: MAX_ATTEMPTS,

            backoff: {
                // "fixed" = always wait the same amount between retries
                // "exponential" would be: 30s, 60s, 120s... (grows fast)
                // Fixed is better here: rider wants consistent check intervals
                type: "fixed",
                delay: RETRY_DELAY_MS,
            },

            // Remove the job from Redis after success (save memory)
            removeOnComplete: true,

            // Keep last 100 failed jobs so we can debug why assignment failed
            removeOnFail: { count: 100 },
        },
    });

    logger.info("Dispatch queue: Initialized", {
        queue: QUEUE_NAME,
        maxRetries: MAX_ATTEMPTS,
        retryDelay: `${RETRY_DELAY_MS / 1000}s`,
    });

    return dispatchQueue;
}

// ── Add booking to queue ──────────────────────────────────────────
// Called by booking.controller.js when no driver is available
async function addToDispatchQueue(booking) {
    if (!dispatchQueue) {
        logger.warn("Dispatch queue: Cannot queue — queue not initialized", {
            bookingId: booking.id,
        });
        return null;
    }

    // Job name: "find-driver" — describes what the worker should do
    const job = await dispatchQueue.add("find-driver", {
        bookingId: booking.id,
        userId: booking.userId,
        pickupLat: booking.pickupLat,
        pickupLng: booking.pickupLng,
        queuedAt: new Date().toISOString(),
    });

    logger.info("Dispatch queue: Booking added to queue", {
        bookingId: booking.id,
        jobId: job.id,
    });

    return job;
}

// ── Trigger queue processing ──────────────────────────────────────
// Called when a driver becomes available (booking completed/cancelled)
// Adds a one-time "process-queue" job that runs immediately
// This wakes up the worker to assign the freed driver to a waiting job
async function triggerQueueProcessing(driverId) {
    if (!dispatchQueue) return;

    // Add a high-priority job that will run immediately
    // This "wakes up" the queue to try assignment with the newly free driver
    await dispatchQueue.add(
        "driver-available",
        { driverId, triggeredAt: new Date().toISOString() },
        {
            priority: 1,     // 1 = highest priority (lower number = higher priority)
            attempts: 1,     // only try once — if no pending bookings, that's fine
            removeOnComplete: true,
            removeOnFail: true,
        }
    );

    logger.info("Dispatch queue: Triggered queue processing", { driverId });
}

// ── Get queue stats ───────────────────────────────────────────────
// Used by GET /api/admin/queue to show current queue state
async function getQueueStats() {
    if (!dispatchQueue) {
        return { available: false, reason: "Redis not connected" };
    }

    const [waiting, active, failed, delayed, completed] = await Promise.all([
        dispatchQueue.getWaitingCount(),
        dispatchQueue.getActiveCount(),
        dispatchQueue.getFailedCount(),
        dispatchQueue.getDelayedCount(),
        dispatchQueue.getCompletedCount(),
    ]);

    const waitingJobs = await dispatchQueue.getWaiting(0, 9);   // first 10 waiting
    const failedJobs = await dispatchQueue.getFailed(0, 9);    // first 10 failed

    return {
        available: true,
        counts: { waiting, active, failed, delayed, completed },
        waitingBookings: waitingJobs.map((j) => ({
            jobId: j.id,
            bookingId: j.data.bookingId,
            queuedAt: j.data.queuedAt,
            attempts: j.attemptsMade,
            nextRetry: j.opts.delay
                ? new Date(Date.now() + j.opts.delay).toISOString()
                : "soon",
        })),
        recentFailures: failedJobs.map((j) => ({
            jobId: j.id,
            bookingId: j.data.bookingId,
            failReason: j.failedReason,
        })),
    };
}

// ── Graceful shutdown ─────────────────────────────────────────────
async function closeDispatchQueue() {
    if (dispatchQueue) {
        await dispatchQueue.close();
        logger.info("Dispatch queue: Closed");
    }
}

module.exports = {
    initDispatchQueue,
    addToDispatchQueue,
    triggerQueueProcessing,
    getQueueStats,
    closeDispatchQueue,
};
