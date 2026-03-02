// ─────────────────────────────────────────────────────────────────
// Redis Connection — shared ioredis client
//
// WHY A SHARED CONNECTION:
//   BullMQ requires ioredis. Creating a new connection per file
//   wastes resources (each connection is a TCP socket to Redis).
//   This file exports ONE shared connection for the entire app.
//
// WHY IOREDIS OVER node-redis:
//   BullMQ is built on ioredis — they share the same connection
//   type. Using ioredis everywhere keeps things consistent.
//
// GRACEFUL DEGRADATION:
//   If Redis is not configured (no REDIS_URL), the app still boots.
//   The queue system is disabled, and bookings work as before.
//   This prevents Redis from being a hard dependency that crashes
//   the entire API if Redis goes down.
//
// HOW TO USE:
//   const { getRedis, isRedisAvailable } = require('./redis');
//   if (isRedisAvailable()) { const client = getRedis(); }
// ─────────────────────────────────────────────────────────────────

const Redis = require("ioredis");
const logger = require("../utils/logger");

let redisClient = null;
let redisReady = false;

function createRedisConnection() {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

    const client = new Redis(redisUrl, {
        // ── Reconnection strategy ────────────────────────────────────
        // Redis can go down temporarily (restarts, network blip).
        // This strategy tells ioredis how long to wait before retrying.
        //
        // retryStrategy(times) is called on each failed connect attempt.
        // Return:
        //   - number (ms) → wait this long and try again
        //   - null/Error  → give up and emit 'error' event
        //
        // Our strategy: exponential backoff up to 30 seconds max.
        // After 10 failures, give up — Redis is really down.
        retryStrategy(times) {
            if (times > 10) {
                logger.error("Redis: Max reconnect attempts reached — giving up");
                return null;  // stop retrying
            }
            const delay = Math.min(times * 500, 30_000);  // 500ms, 1s, 1.5s... max 30s
            logger.warn(`Redis: Reconnecting in ${delay}ms (attempt ${times})`);
            return delay;
        },

        // Lazy connect: don't connect immediately on require().
        // Only connect when we first use the client.
        // This prevents startup failures if Redis isn't up yet.
        lazyConnect: true,

        // If a command fails because of a lost connection, automatically
        // re-send it once the connection is restored.
        enableOfflineQueue: true,

        // Connection timeout: if we can't connect in 5s, fail fast
        connectTimeout: 5000,

        // Max number of commands to hold in the offline queue
        // (when Redis is temporarily unreachable)
        maxRetriesPerRequest: null,  // null = needed by BullMQ
    });

    // ── Event Handlers ─────────────────────────────────────────────
    client.on("connect", () => {
        logger.info("Redis: Connected successfully");
        redisReady = true;
    });

    client.on("ready", () => {
        logger.info("Redis: Ready to accept commands");
    });

    client.on("error", (err) => {
        // Don't crash the app — just log and let the reconnect strategy handle it
        logger.error("Redis: Connection error", { error: err.message });
        redisReady = false;
    });

    client.on("close", () => {
        logger.warn("Redis: Connection closed");
        redisReady = false;
    });

    client.on("reconnecting", () => {
        logger.info("Redis: Attempting to reconnect...");
    });

    return client;
}

// ─────────────────────────────────────────────────────────────────
// Initialize — call this once at server startup
// ─────────────────────────────────────────────────────────────────
async function initRedis() {
    if (process.env.NODE_ENV === "test") {
        logger.info("Redis: Skipped in test environment");
        return;
    }

    try {
        redisClient = createRedisConnection();
        await redisClient.connect();
        logger.info("Redis: Initialization complete");
    } catch (err) {
        // Redis failure is NOT fatal — queue simply won't work
        // The rest of the API (auth, booking creation, etc.) still works
        logger.error("Redis: Failed to initialize — queue system disabled", {
            error: err.message,
        });
        redisClient = null;
        redisReady = false;
    }
}

// ─────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────

// Use this before any Redis operation to check if it's available
function isRedisAvailable() {
    return redisClient !== null && redisReady;
}

// Get the shared connection (for BullMQ and other uses)
function getRedis() {
    return redisClient;
}

// Graceful disconnect
async function closeRedis() {
    if (redisClient) {
        await redisClient.quit();
        logger.info("Redis: Connection closed gracefully");
    }
}

module.exports = { initRedis, getRedis, isRedisAvailable, closeRedis };
