// ─────────────────────────────────────────────────────────────────
// PM2 Ecosystem Config
//
// PM2 is a production process manager for Node.js.
// It keeps your server running 24/7 — if it crashes, PM2 restarts
// it automatically. It also handles multiple CPU cores (cluster mode).
//
// USAGE:
//   npm install -g pm2          # install pm2 globally (once)
//   pm2 start ecosystem.config.js              # start in production
//   pm2 start ecosystem.config.js --env dev    # start in development
//   pm2 stop ambulance-dispatch                # stop the server
//   pm2 restart ambulance-dispatch             # restart the server
//   pm2 logs ambulance-dispatch                # view live logs
//   pm2 status                                 # see all running apps
//   pm2 monit                                  # real-time dashboard
//   pm2 save                                   # save process list
//   pm2 startup                                # auto-start on system boot
// ─────────────────────────────────────────────────────────────────

module.exports = {
    apps: [
        {
            // ── Identity ──────────────────────────────────────────────
            name: "ambulance-dispatch",   // Name shown in pm2 status
            script: "src/server.js",      // Entry point

            // ── Process Mode ──────────────────────────────────────────
            // "cluster" mode forks one process per CPU core, so all
            // cores handle requests in parallel (much better performance).
            // Use "fork" if you want a single process (easier to debug).
            instances: "max",             // Use all available CPU cores
            exec_mode: "cluster",         // Enable cluster mode

            // ── Restart Behavior ──────────────────────────────────────
            // If the server crashes, pm2 waits 1 second then restarts.
            // After 10 restarts in a row it stops (prevents infinite loops).
            autorestart: true,
            watch: false,                 // Don't restart on file changes in prod
            max_memory_restart: "500M",   // Restart if memory exceeds 500MB
            restart_delay: 1000,          // Wait 1s between restarts (ms)
            max_restarts: 10,             // Max consecutive restarts before giving up

            // ── Environment Variables ─────────────────────────────────
            // pm2 can inject env vars per environment.
            // These OVERRIDE your .env file values when using --env flag.
            env: {
                // Development: run with `pm2 start ecosystem.config.js --env dev`
                NODE_ENV: "development",
                PORT: 5000,
            },
            env_production: {
                // Production: run with `pm2 start ecosystem.config.js --env production`
                NODE_ENV: "production",
                PORT: 5000,
            },

            // ── Logging ───────────────────────────────────────────────
            // pm2 captures stdout/stderr and writes to these files.
            // Combined: all logs in one file
            // Error: only errors (crashes, uncaught exceptions)
            // Date format on each log line makes debugging easier.
            out_file: "logs/out.log",     // Standard output (console.log)
            error_file: "logs/error.log", // Standard error (console.error)
            merge_logs: true,             // Merge logs from all cluster instances
            log_date_format: "YYYY-MM-DD HH:mm:ss", // Timestamp format

            // ── Graceful Shutdown ─────────────────────────────────────
            // When pm2 stops/restarts the app, it sends SIGINT first.
            // Our server.js already handles SIGINT to close DB connections.
            // listen_timeout: how long to wait for the app to be ready
            // kill_timeout: how long to wait before force-killing
            listen_timeout: 10000,        // 10 seconds to start
            kill_timeout: 5000,           // 5 seconds to gracefully stop
        },
    ],
};
