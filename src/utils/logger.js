// ─────────────────────────────────────────────────────────────────
// Structured Logger — Winston
//
// WHY WINSTON OVER console.log:
//
//   console.log("Login error:", error)
//   ↑ Produces a plain string — unsearchable, unstructured
//
//   logger.error("Login error", { error: error.message, userId })
//   ↑ Produces JSON — every field is searchable in log tools
//     { level: "error", message: "Login error", userId: "...",
//       timestamp: "2026-03-02T07:31:00Z", service: "ambulance-api" }
//
// IN PRODUCTION:
//   Log aggregation tools (Datadog, AWS CloudWatch, Grafana Loki)
//   can instantly filter: level:error, OR find all logs for a
//   specific requestId to trace a bug end-to-end.
//
// TWO FORMATS:
//   Development → colorful, human-readable (easier to read locally)
//   Production  → JSON (machine-readable, searchable at scale)
//
// LOG LEVELS (in order of severity):
//   error   → something broke, needs immediate attention
//   warn    → something unexpected but not broken
//   info    → normal operations (server started, request received)
//   http    → HTTP request logs (method, url, status, duration)
//   debug   → detailed info for debugging (DB queries, etc.)
//
//   In production: only error + warn + info are logged
//   In development: all levels including debug and http
// ─────────────────────────────────────────────────────────────────

const winston = require("winston");
const path = require("path");
const fs = require("fs");

const isDev = process.env.NODE_ENV !== "production";
const isTest = process.env.NODE_ENV === "test";

// ── Custom formats ────────────────────────────────────────────────

// Development format: colorized, easy to read in terminal
// OUTPUT: 2026-03-02 07:31:00 [ERROR] Login failed { userId: "abc" }
const devFormat = winston.format.combine(
    winston.format.colorize({ all: true }),        // colors by log level
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length
            ? " " + JSON.stringify(meta, null, 0)
            : "";
        return `${timestamp} [${level}] ${message}${metaStr}`;
    })
);

// Production format: pure JSON — one log entry per line
// OUTPUT: {"level":"error","message":"Login failed","userId":"abc","timestamp":"..."}
const prodFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),  // include full stack trace in errors
    winston.format.json()
);

// ── Transports (WHERE logs go) ────────────────────────────────────
// A "transport" is a destination for log messages.
// We use multiple transports simultaneously.
const transports = [];

// Always log to console (unless in test — keeps test output clean)
if (!isTest) {
    transports.push(
        new winston.transports.Console({
            format: isDev ? devFormat : prodFormat,
        })
    );
}

// In production: also write to files
if (!isDev && !isTest && process.env.LOG_TO_FILE === "true") {
    const logsDir = path.join(__dirname, "..", "..", "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    // All logs (info and above) go here
    transports.push(
        new winston.transports.File({
            filename: path.join(logsDir, "app.log"),
            format: prodFormat,
            maxsize: 10 * 1024 * 1024,  // rotate at 10MB
            maxFiles: 5,                  // keep last 5 rotated files
        })
    );

    // Only error logs go here (easy to find critical issues)
    transports.push(
        new winston.transports.File({
            filename: path.join(logsDir, "error.log"),
            level: "error",
            format: prodFormat,
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
        })
    );
}

// ── Create logger instance ────────────────────────────────────────
const logger = winston.createLogger({
    // In production: only log info and above (not debug/http noise)
    // In development: log everything including http and debug
    level: isDev ? "debug" : "info",

    // Default fields added to EVERY log entry automatically
    // You never have to manually add these — they're always there
    defaultMeta: {
        service: "ambulance-api",                    // useful when multiple services log to same place
        env: process.env.NODE_ENV || "development",
    },

    transports,
});

module.exports = logger;
