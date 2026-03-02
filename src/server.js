require("dotenv").config();

const express = require("express");
const http = require("http");
const fs = require("fs");      // File system — for creating log streams
const path = require("path");    // Path utilities — for log file paths
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");


const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const driverRoutes = require("./routes/driver.routes");
const bookingRoutes = require("./routes/booking.routes");
const adminRoutes = require("./routes/admin.routes");
const { initSocketIO } = require("./socket/socket");

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

// Attach io to app so controllers can access it via req.app.get("io")
app.set("io", io);

// Boot Socket.IO logic
initSocketIO(io);

// ─────────────────────────────────────────────
// Security Headers
// ─────────────────────────────────────────────
app.use(helmet());

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);

// ─────────────────────────────────────────────
// HTTP Request Logger (Morgan)
//
// HOW MORGAN WORKS:
//   Morgan is a middleware that runs on every request and logs
//   info like: method, URL, status code, response time, byte size.
//
// FORMATS:
//   "dev"      → colorful 1-line output, great for development
//   "combined" → Apache-style full log, standard for production
//
// FILE LOGGING (when LOG_TO_FILE=true in .env):
//   Logs are written to:
//   ├── logs/access.log  → all HTTP requests
//   └── logs/error.log   → only non-2xx responses (errors)
//
//   WHY TWO FILES:
//   access.log grows very fast. error.log lets you quickly find
//   problems without scrolling through thousands of 200 OK lines.
// ─────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  const isDev = process.env.NODE_ENV !== "production";
  const logToFile = process.env.LOG_TO_FILE === "true";

  if (logToFile) {
    // Ensure the logs directory exists
    const logsDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    // "flags: a" means append to file (don't overwrite on restart)
    const accessStream = fs.createWriteStream(path.join(logsDir, "access.log"), { flags: "a" });
    const errorStream = fs.createWriteStream(path.join(logsDir, "error.log"), { flags: "a" });

    // Log ALL requests to access.log
    app.use(morgan("combined", { stream: accessStream }));

    // Log ONLY error responses (4xx, 5xx) to error.log
    // The skip function returns true = skip this log entry.
    // So: skip = (req, res) => res.statusCode < 400 means
    // "skip logging if status is below 400" (i.e., only log errors)
    app.use(morgan("combined", {
      stream: errorStream,
      skip: (req, res) => res.statusCode < 400,
    }));

    console.log("📝 Logging HTTP requests to logs/access.log and logs/error.log");
  } else {
    // Development: colorful console output
    app.use(morgan(isDev ? "dev" : "combined"));
  }
}

// ─────────────────────────────────────────────────────────────────
// Global API Rate Limiter (Item 13)
//
// WHY A GLOBAL LIMIT ON TOP OF AUTH-SPECIFIC LIMITS:
//   Auth routes already have tight rate limits (e.g. 10 logins/15min).
//   But what about other routes? A malicious script could hammer
//   GET /api/booking/my thousands of times per second, overloading
//   your server and database — a Denial of Service (DoS) attack.
//
//   The global limiter is a last line of defense:
//     Auth routes:   tight limit (5–20 requests / 15 minutes)
//     ALL other routes: broad limit (200 requests / 15 minutes)
//
//   200 requests / 15 minutes is generous for real users but
//   completely stops bots and scrapers.
//
// SKIP HEALTH CHECK:
//   We skip GET / because monitoring tools like UptimeRobot hit it
//   every 30 seconds. We don't want them getting rate limited.
//
// CONFIG from .env:
//   GLOBAL_RATE_LIMIT_MAX          (default 200)
//   GLOBAL_RATE_LIMIT_WINDOW_MS    (default 900000 = 15 min)
// ─────────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip health check + skip entirely in test environment
  skip: (req) => req.path === "/" || process.env.NODE_ENV === "test",
  message: {
    error: "Too many requests from this IP. Please slow down and try again later.",
  },
});

app.use(globalLimiter);

// ─────────────────────────────────────────────────────────────────
// Body Parser + Request Size Limits (Item 14)
//
// WHY SIZE LIMITS:
//   Without a size limit, someone could POST a 500MB JSON body.
//   Your server would try to parse it, run out of memory, and crash.
//   This is called a "payload flood" attack.
//
// LIMITS CHOSEN:
//   JSON bodies:           10kb  — plenty for any legitimate API call
//                                  (a typical booking request is ~200 bytes)
//   URL-encoded forms:     50kb  — slightly more generous for form data
//
//   What if someone sends more? Express automatically returns:
//     413 Content Too Large
//   before even reaching your controller — zero work wasted.
//
// CONFIGURABLE via .env:
//   JSON_BODY_LIMIT (default "10kb")
//   URL_BODY_LIMIT  (default "50kb")
// ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "10kb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.URL_BODY_LIMIT || "50kb" }));

// ─────────────────────────────────────────────
// Safety net: ensure req.body is always an object
// Prevents crashes if client forgets Content-Type: application/json
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (["POST", "PATCH", "PUT"].includes(req.method) && !req.body) {
    req.body = {};
  }
  next();
});

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Ambulance Dispatch API is running",
    environment: process.env.NODE_ENV,
    version: "1.0.0",
  });
});

// ─────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/admin", adminRoutes);

// ─────────────────────────────────────────────
// 404 — Unknown Routes
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: `Route ${req.method} ${req.url} not found`,
  });
});

// ─────────────────────────────────────────────
// Global Error Handler
// ─────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

// ─────────────────────────────────────────────────────────────────
// Start Server
//
// WHY THIS PATTERN:
//   When you run `node src/server.js`, this block runs normally.
//   When tests do `require('./src/server')`, the module is loaded
//   BUT the server does NOT start listening on a port — Supertest
//   handles that itself by passing the app directly to its agent.
//
//   require.main === module  → true when run directly: node server.js
//                           → false when imported: require('./server.js')
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
if (require.main === module) {
  httpServer.listen(PORT, () => {
    console.log(`🚑 Server running on port ${PORT} [${process.env.NODE_ENV || "development"} mode]`);
    console.log(`🔌 Socket.IO ready`);
  });
}

// Export app so tests can import it via Supertest without starting a port listener
module.exports = { app, httpServer };