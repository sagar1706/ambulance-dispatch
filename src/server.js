// ─────────────────────────────────────────────────────────────────
// STEP 1: Load .env FIRST — before any other require
// Why first? Other modules read process.env on require().
// If dotenv runs after them, they get undefined values.
// ─────────────────────────────────────────────────────────────────
require("dotenv").config();

// ─────────────────────────────────────────────────────────────────
// STEP 2: Validate environment — crash fast if config is wrong
// This runs before anything connects to DB or starts listening.
// ─────────────────────────────────────────────────────────────────
const { validateEnv } = require("./config/env");
validateEnv();

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const logger = require("./utils/logger");
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const driverRoutes = require("./routes/driver.routes");
const bookingRoutes = require("./routes/booking.routes");
const adminRoutes = require("./routes/admin.routes");
const healthRoutes = require("./routes/health.routes");
const prisma = require("./config/prisma");
const { initSocketIO } = require("./socket/socket");
const { initRedis, closeRedis } = require("./config/redis");
const { initDispatchQueue, closeDispatchQueue } = require("./queues/dispatch.queue");
const { initDispatchWorker, closeDispatchWorker } = require("./queues/dispatch.worker");

// ─────────────────────────────────────────────
// App + HTTP Server + Socket.IO
// ─────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);
global._io = io;   // make io available to the dispatch worker (outside req/res context)
initSocketIO(io);

// ─────────────────────────────────────────────────────────────────
// Middleware 1 — Security Headers (Helmet)
// Sets 15+ HTTP headers that browsers understand:
//   X-Content-Type-Options: nosniff  → prevents MIME sniffing
//   X-Frame-Options: DENY           → prevents clickjacking
//   Strict-Transport-Security       → forces HTTPS
//   Content-Security-Policy         → restricts script sources
// ─────────────────────────────────────────────────────────────────
app.use(helmet());

// ─────────────────────────────────────────────────────────────────
// Middleware 2 — CORS
// Only allows requests from CLIENT_URL (your frontend).
// Any other origin gets blocked with 403 — prevents CSRF.
// ─────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);

// ─────────────────────────────────────────────────────────────────
// Middleware 3 — Request ID
//
// WHAT IT DOES:
//   Attaches a unique UUID to every incoming request:
//     req.id = "a3f2c1b4-..."
//
// WHY THIS MATTERS (the key insight):
//   When you have thousands of log lines per minute, how do you
//   find all the logs from ONE specific request?
//   Without request IDs — you can't. You just scroll desperately.
//   With request IDs — filter by requestId in 2 seconds.
//
//   Example: A user reports "my booking failed at 2pm."
//   They send you their X-Request-ID header from the failed response.
//   You search your logs for that ID and instantly see:
//     [info]  POST /api/booking received        { requestId: "abc123" }
//     [info]  DB query: find available drivers  { requestId: "abc123" }
//     [error] No drivers available              { requestId: "abc123" }
//     [info]  Response: 400                     { requestId: "abc123" }
//
// HOW TO SEE IT:
//   In Postman, check the response headers for X-Request-ID.
// ─────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Use the ID from client if provided (useful for frontend correlation)
  // Otherwise generate a fresh one
  req.id = req.headers["x-request-id"] || crypto.randomUUID();

  // Send it back in the response so the client can report it
  res.setHeader("X-Request-ID", req.id);
  next();
});

// ─────────────────────────────────────────────────────────────────
// Middleware 4 — HTTP Request Logging (Winston)
//
// Logs every request with structured fields — replaces Morgan.
// Silent in test environment (keeps test output clean).
//
// Why include requestId, ip, userAgent?
//   - requestId → correlate with other log entries for same request
//   - ip → security auditing (who's hitting which routes?)
//   - userAgent → distinguish mobile app vs browser vs bots
//   - duration → performance monitoring (slow queries = slow routes)
// ─────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use((req, res, next) => {
    const start = Date.now();

    // `res.on("finish")` fires AFTER the response is sent
    // Only then do we know the statusCode and duration
    res.on("finish", () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? "error"
        : res.statusCode >= 400 ? "warn"
          : "http";

      logger.log(level, `${req.method} ${req.url}`, {
        requestId: req.id,
        statusCode: res.statusCode,
        durationMs: duration,
        ip: req.ip,
        userAgent: req.get("User-Agent"),
      });
    });

    next();
  });
}

// ─────────────────────────────────────────────────────────────────
// Middleware 5 — Global Rate Limiter
// Last line of defense against DoS attacks.
// Skips health endpoints and test environment.
// ─────────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/" ||
    req.path.startsWith("/api/health") ||
    process.env.NODE_ENV === "test",
  message: { error: "Too many requests from this IP. Please slow down and try again later." },
});
app.use(globalLimiter);

// ─────────────────────────────────────────────────────────────────
// Middleware 6 — Body Parsers with Size Limits
// Prevents payload flood attacks (e.g. 500MB POST body).
// ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "10kb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.URL_BODY_LIMIT || "50kb" }));

// Safety net: ensure req.body is always an object
app.use((req, res, next) => {
  if (["POST", "PATCH", "PUT"].includes(req.method) && !req.body) {
    req.body = {};
  }
  next();
});

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
// Simple ping — not rate-limited, used by monitoring tools
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Ambulance Dispatch API is running",
    environment: process.env.NODE_ENV,
    version: "1.0.0",
  });
});

// Detailed health check — checks DB, memory, uptime
app.use("/api/health", healthRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/admin", adminRoutes);

// ─────────────────────────────────────────────
// 404 — Unknown Routes
// ─────────────────────────────────────────────
app.use((req, res) => {
  logger.warn("Route not found", { requestId: req.id, method: req.method, url: req.url });
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
});

// ─────────────────────────────────────────────────────────────────
// Global Error Handler
// Catches any error thrown by a controller that wasn't caught
// locally. Logs it with the request ID so you can trace it.
// ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error("Unhandled error", {
    requestId: req.id,
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
  });
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    requestId: req.id,   // client can report this when they file a bug
  });
});

// ─────────────────────────────────────────────────────────────────
// Graceful Shutdown v2
//
// WHAT HAPPENS DURING DEPLOYMENT / CONTAINER RESTART:
//   1. OS sends SIGTERM to the process (Docker: `docker stop`)
//   2. We stop accepting NEW connections immediately
//   3. We wait up to 30 seconds for IN-FLIGHT requests to finish
//   4. We close Socket.IO connections cleanly
//   5. We disconnect the Prisma DB pool
//   6. Process exits with code 0 (clean exit)
//
// WHY THIS MATTERS:
//   Without graceful shutdown, killing the process mid-request means:
//     - A patient's booking gets half-written to DB (corrupted)
//     - Users get "connection reset" errors instead of proper responses
//     - DB connections aren't closed = PostgreSQL has stale connections
//   With graceful shutdown, all in-flight requests finish first.
// ─────────────────────────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;   // prevent double-shutdown
  isShuttingDown = true;

  logger.info(`${signal} received — starting graceful shutdown`);

  // Stop accepting new connections
  httpServer.close(async () => {
    logger.info("HTTP server closed — no new connections accepted");

    // Close Socket.IO connections
    io.close(() => {
      logger.info("Socket.IO closed — all WebSocket connections terminated");
    });

    // Close dispatch worker (lets current job finish)
    await closeDispatchWorker();

    // Close dispatch queue
    await closeDispatchQueue();

    // Disconnect Redis
    await closeRedis();

    // Close Prisma DB connection pool
    try {
      await prisma.$disconnect();
      logger.info("Prisma disconnected — DB connection pool closed");
    } catch (err) {
      logger.error("Error closing Prisma", { error: err.message });
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  });

  // Force exit after 30s if something hangs
  // (e.g., a request that never finishes)
  setTimeout(() => {
    logger.error("Graceful shutdown timed out (30s) — forcing exit");
    process.exit(1);
  }, 30_000);
}

// Remove old SIGINT/SIGTERM handlers from prisma.js (they'd conflict)
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Catch unhandled errors that would otherwise crash silently
process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception — shutting down", { error: err.message, stack: err.stack });
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Promise Rejection — shutting down", { reason: String(reason) });
  gracefulShutdown("unhandledRejection");
});

// ─────────────────────────────────────────────────────────────────
// Start Server
//
// WHY require.main === module:
//   node src/server.js  → require.main === module → TRUE  → starts server
//   require('./server') → require.main === module → FALSE → doesn't start
//   Tests use the second pattern — Supertest manages the port itself
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
if (require.main === module) {
  (async () => {
    // Initialize in order: Redis → Queue → Worker → HTTP
    await initRedis();
    initDispatchQueue();
    initDispatchWorker();

    httpServer.listen(PORT, () => {
      logger.info("🚑 Server started", {
        port: PORT,
        env: process.env.NODE_ENV || "development",
        version: "1.0.0",
      });
      logger.info("🔌 Socket.IO ready");
      logger.info("📦 Dispatch queue + worker ready");
    });
  })();
}

module.exports = { app, httpServer };