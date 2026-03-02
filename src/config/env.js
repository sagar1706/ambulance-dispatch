// ─────────────────────────────────────────────────────────────────
// Environment Variable Validation
//
// WHY THIS EXISTS:
//   Without this, if you forget to set JWT_SECRET in production,
//   the server starts fine — but crashes 3 hours later on the
//   first login with a confusing "Cannot read property of undefined"
//   error. Very hard to debug in production.
//
//   With this file, the server REFUSES to start if any required
//   variable is missing — and tells you EXACTLY which ones.
//
// WHERE IT'S CALLED:
//   First line of server.js — before anything else.
//   Fail fast, fail loud.
//
// TWO CATEGORIES:
//   REQUIRED — server literally cannot function without these
//   RECOMMENDED — server works but is insecure or degraded
// ─────────────────────────────────────────────────────────────────

// These variables MUST exist or we refuse to start
const REQUIRED_VARS = [
    "DATABASE_URL",   // Without this, no DB connection — everything breaks
    "JWT_SECRET",     // Without this, tokens can't be signed or verified
];

// These variables SHOULD exist in production but have safe defaults in dev
const RECOMMENDED_VARS = [
    "CLIENT_URL",     // Falls back to localhost — wrong in production
    "BCRYPT_ROUNDS",  // Falls back to 12 — acceptable default
    "JWT_EXPIRES_IN", // Falls back to 1d — acceptable default
];

function validateEnv() {
    const missing = [];
    const warnings = [];
    const isProduction = process.env.NODE_ENV === "production";

    // ── Check required vars ──────────────────────────────────────
    // If ANY are missing, we collect ALL of them before crashing.
    // This way the developer fixes all missing vars in one go,
    // instead of fixing one, restarting, finding the next, etc.
    for (const varName of REQUIRED_VARS) {
        if (!process.env[varName] || process.env[varName].trim() === "") {
            missing.push(varName);
        }
    }

    if (missing.length > 0) {
        console.error("\n" + "═".repeat(70));
        console.error("❌  STARTUP FAILED — Missing required environment variables:");
        console.error("─".repeat(70));
        missing.forEach((v) => console.error(`    ✗  ${v}`));
        console.error("─".repeat(70));
        console.error("    Fix: copy .env.example to .env and fill in these values.");
        console.error("    Command: cp .env.example .env");
        console.error("═".repeat(70) + "\n");
        process.exit(1); // Non-zero exit = something went wrong (Docker/PM2 will restart)
    }

    // ── JWT Secret strength check ────────────────────────────────
    // A weak JWT_SECRET is a critical security vulnerability.
    // Attackers can brute-force short secrets and forge tokens.
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length < 32) {
        if (isProduction) {
            // In production: REFUSE to start — too dangerous
            console.error("\n❌  STARTUP FAILED — JWT_SECRET must be at least 32 characters.");
            console.error("    Current length:", jwtSecret.length, "chars");
            console.error("    Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
            process.exit(1);
        } else {
            // In development: warn but continue (prevents annoying blockers during dev)
            warnings.push(`JWT_SECRET is only ${jwtSecret.length} chars (minimum 32 for production)`);
        }
    }

    // ── Recommended vars check ───────────────────────────────────
    if (isProduction) {
        for (const varName of RECOMMENDED_VARS) {
            if (!process.env[varName]) {
                warnings.push(`${varName} is not set — using default value`);
            }
        }
    }

    // ── Print warnings ───────────────────────────────────────────
    if (warnings.length > 0) {
        console.warn("\n" + "─".repeat(70));
        console.warn("⚠️   Environment warnings (server starting anyway):");
        warnings.forEach((w) => console.warn(`    !  ${w}`));
        console.warn("─".repeat(70) + "\n");
    }

    // ── Confirm environment ──────────────────────────────────────
    // Useful for debugging deployments — you can see exactly what
    // environment the server started in from the very first log line
    console.log(`✅  Environment validated [${process.env.NODE_ENV || "development"}]`);
}

module.exports = { validateEnv };
