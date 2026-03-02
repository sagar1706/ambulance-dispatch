// ─────────────────────────────────────────────────────────────────
// Prisma Client — shared singleton with connection pooling
//
// WHY A SINGLETON:
//   Each `new PrismaClient()` call opens a NEW connection pool.
//   If you call it in every file, you'd have 10+ pools running,
//   wasting DB connections and memory.
//   This file exports ONE instance that every module shares.
//
// CONNECTION POOLING:
//   Prisma uses a connection pool — a fixed set of DB connections
//   that are reused across requests instead of opening/closing one
//   per request (which is very slow).
//
//   Default pool size: min(num_physical_cores * 2 + 1, 10)
//   On most servers: 5–10 connections.
//
//   For an API server, we tune this based on expected concurrency.
//   Rules of thumb:
//     - Too few: requests queue up waiting for a free connection
//     - Too many: DB server runs out of max_connections
//     - Typical Postgres max_connections = 100–200
//     - Set pool to ~20–30 for most APIs (leaves room for admin tools)
//
//   Connection limit:  set via DATABASE_URL query param or env var
//   Pool timeout:      how long to wait for a free connection (seconds)
//
// GRACEFUL SHUTDOWN:
//   When the process exits (SIGINT/SIGTERM), we close the Prisma
//   connection cleanly. Without this, Postgres might keep the
//   connection open for a while (TCP timeout), wasting resources.
// ─────────────────────────────────────────────────────────────────

const { PrismaClient } = require("@prisma/client");

// Connection pool settings — configurable via .env
const connectionLimit = parseInt(process.env.DB_POOL_SIZE) || 20;
const poolTimeout = parseInt(process.env.DB_POOL_TIMEOUT) || 30;   // seconds

// Append connection pool params to the DB URL
// Prisma uses the PostgreSQL connection string's query params for this
function buildDatabaseUrl() {
    const url = process.env.DATABASE_URL || "";
    if (!url) return url;

    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`;
}

const prisma = new PrismaClient({
    datasources: {
        db: { url: buildDatabaseUrl() },
    },
    log:
        process.env.NODE_ENV === "development"
            ? ["query", "info", "warn", "error"]
            : ["error"],  // Only log errors in production — query logging is very noisy
});

// ── Graceful Shutdown ─────────────────────────────────────────────
// Called when the process receives a termination signal.
// Closes the Prisma connection pool cleanly so Postgres sees a
// proper disconnect (not a TCP timeout).
const shutdown = async (signal) => {
    console.log(`\n${signal} received. Closing Prisma connection pool...`);
    await prisma.$disconnect();
    process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C in terminal
process.on("SIGTERM", () => shutdown("SIGTERM"));  // Docker stop, PM2 reload

module.exports = prisma;