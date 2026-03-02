// ─────────────────────────────────────────────────────────────────
// Health Check Endpoint
// GET /api/health
//
// WHY THIS EXISTS:
//   The simple GET / health check only tells you "process is running."
//   It doesn't tell you if the DATABASE is reachable, which is the
//   most common production failure point.
//
//   /api/health does a REAL DB query to confirm end-to-end health.
//
// WHO USES THIS:
//   1. Docker — HEALTHCHECK instruction in Dockerfile
//      (Docker restarts the container if this fails)
//
//   2. Kubernetes — livenessProbe + readinessProbe
//      (K8s removes unhealthy pod from load balancer)
//
//   3. PM2 — health monitoring dashboard
//
//   4. UptimeRobot / Pingdom — external uptime monitoring
//      (alerts you at 3am when the server goes down)
//
//   5. You — when debugging a production issue, hit /api/health
//      first to know if the problem is the server or the DB.
//
// RESPONSE STRUCTURE:
//   status: "healthy" | "degraded" | "unhealthy"
//   - healthy   → everything works
//   - degraded  → server is up but DB is unreachable
//   - unhealthy → server itself has issues
//
// HTTP STATUS CODES:
//   200 → healthy (load balancer keeps sending traffic)
//   503 → degraded/unhealthy (load balancer stops sending traffic)
//   This is intentional — allows automatic failover.
// ─────────────────────────────────────────────────────────────────

const express = require("express");
const prisma = require("../config/prisma");
const logger = require("../utils/logger");

const router = express.Router();

// Record when the server started — used for uptime calculation
const SERVER_START_TIME = Date.now();

// ─────────────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
    const checks = {};
    let overallStatus = "healthy";

    // ── 1. Database check ─────────────────────────────────────────
    // We run a trivial query ($queryRaw SELECT 1) instead of a real
    // table query. Why?
    //   - Fast: no table scan
    //   - Always works: doesn't depend on your schema
    //   - Proves: connection pool is alive AND DB responds
    // Timeout after 3 seconds — if DB takes longer it's unhealthy anyway
    const dbStart = Date.now();
    try {
        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("DB timeout after 3s")), 3000)
            ),
        ]);
        checks.database = {
            status: "healthy",
            responseMs: Date.now() - dbStart,
        };
    } catch (err) {
        logger.error("Health check: DB unreachable", { error: err.message });
        checks.database = {
            status: "unhealthy",
            error: err.message,
            responseMs: Date.now() - dbStart,
        };
        overallStatus = "degraded";  // server is up, DB is not → degraded
    }

    // ── 2. Memory check ──────────────────────────────────────────
    // Node.js has a V8 heap limit (default ~1.5GB on 64-bit).
    // If heap usage gets very close to the limit, the process
    // will eventually crash with "JavaScript heap out of memory".
    // We warn when usage exceeds 85% of the limit.
    const mem = process.memoryUsage();
    const heapUsed = Math.round(mem.heapUsed / 1024 / 1024); // MB
    const heapTotal = Math.round(mem.heapTotal / 1024 / 1024); // MB
    const rss = Math.round(mem.rss / 1024 / 1024); // MB (total process memory)
    const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

    checks.memory = {
        status: heapPct > 85 ? "warning" : "healthy",
        heapUsedMB: heapUsed,
        heapTotalMB: heapTotal,
        rssMB: rss,
        heapUsagePct: heapPct,
    };

    if (heapPct > 85) {
        logger.warn("Health check: high memory usage", { heapPct, heapUsed, heapTotal });
    }

    // ── 3. Uptime ────────────────────────────────────────────────
    // How long the server has been running.
    // Short uptime after a recent deploy = expected
    // Short uptime at random times = crash loop (alarm!)
    const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    const uptimeStr = formatUptime(uptimeSeconds);

    checks.uptime = {
        status: "healthy",
        seconds: uptimeSeconds,
        human: uptimeStr,
    };

    // ── Build response ────────────────────────────────────────────
    const response = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || "1.0.0",
        environment: process.env.NODE_ENV || "development",
        checks,
    };

    // Return 503 if degraded — load balancers will stop routing to this instance
    // Return 200 if healthy — load balancers keep routing to this instance
    const statusCode = overallStatus === "healthy" ? 200 : 503;
    return res.status(statusCode).json(response);
});

// ─────────────────────────────────────────────────────────────────
// Helper — format seconds into human-readable uptime string
// e.g. 90061 → "1d 1h 1m 1s"
// ─────────────────────────────────────────────────────────────────
function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);

    return parts.join(" ");
}

module.exports = router;
