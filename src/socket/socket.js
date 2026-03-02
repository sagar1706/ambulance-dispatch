const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

/**
 * Initialize Socket.IO with JWT auth and room-based real-time events
 * @param {import("socket.io").Server} io
 */
function initSocketIO(io) {
    // ─────────────────────────────────────────────────────────────
    // Middleware: authenticate every socket connection
    //
    // Runs ONCE per connection (not on every message).
    // Two checks:
    //   1. Verify JWT signature and expiry
    //   2. Check isActive in DB — deactivated users blocked
    //      even if they have a valid (non-expired) token
    // ─────────────────────────────────────────────────────────────
    io.use(async (socket, next) => {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.split(" ")[1];

        if (!token) {
            return next(new Error("Authentication required. Pass token in handshake.auth.token"));
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return next(new Error("Invalid or expired token"));
        }

        // Check isActive — a deactivated user's token is still valid (not expired)
        // but they should be blocked from WebSocket connections just like HTTP routes
        try {
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: { isActive: true },
            });
            if (!user || !user.isActive) {
                return next(new Error("Account is deactivated. Connection refused."));
            }
        } catch (dbErr) {
            console.error("Socket isActive check failed:", dbErr.message);
            return next(new Error("Authentication check failed"));
        }

        socket.user = decoded; // { userId, role }
        next();
    });


    // ─────────────────────────────────────────────
    // On Connection
    // ─────────────────────────────────────────────
    io.on("connection", async (socket) => {
        const { userId, role } = socket.user;
        console.log(`🔌 Socket connected  | userId=${userId} | role=${role} | id=${socket.id}`);

        // ── Join role-based rooms ──
        if (role === "ADMIN") {
            socket.join("admins");
        }

        if (role === "USER") {
            socket.join(`user_${userId}`);
        }

        if (role === "DRIVER") {
            try {
                const driver = await prisma.driver.findUnique({ where: { userId } });
                if (driver) {
                    socket.driverId = driver.id;
                    socket.join(`driver_${driver.id}`);
                }
            } catch (err) {
                console.error("Socket: error fetching driver profile:", err.message);
            }
        }

        // ─────────────────────────────────────────────
        // Event: driver sends GPS location every few seconds
        // ─────────────────────────────────────────────
        socket.on("driver:location_update", async ({ lat, lng }) => {
            if (role !== "DRIVER" || !socket.driverId) {
                return socket.emit("error", { message: "Only drivers can emit location updates" });
            }

            const latitude = parseFloat(lat);
            const longitude = parseFloat(lng);

            if (isNaN(latitude) || isNaN(longitude)) {
                return socket.emit("error", { message: "Invalid lat/lng values" });
            }

            try {
                await prisma.driver.update({
                    where: { id: socket.driverId },
                    data: { currentLat: latitude, currentLng: longitude },
                });

                // Find active booking assigned to this driver
                const activeBooking = await prisma.booking.findFirst({
                    where: {
                        driverId: socket.driverId,
                        status: { in: ["ASSIGNED", "EN_ROUTE", "ARRIVED"] },
                    },
                });

                // Send live location to the assigned patient
                if (activeBooking) {
                    io.to(`user_${activeBooking.userId}`).emit("driver:location", {
                        driverId: socket.driverId,
                        lat: latitude,
                        lng: longitude,
                    });
                }

                // Always broadcast to admins for dashboard
                io.to("admins").emit("driver:location", {
                    driverId: socket.driverId,
                    lat: latitude,
                    lng: longitude,
                    bookingId: activeBooking?.id || null,
                });
            } catch (err) {
                console.error("Socket location update error:", err.message);
                socket.emit("error", { message: "Failed to update location" });
            }
        });

        // ─────────────────────────────────────────────
        // Disconnect
        // ─────────────────────────────────────────────
        socket.on("disconnect", (reason) => {
            console.log(`🔌 Socket disconnected | userId=${userId} | reason=${reason}`);
        });

        socket.on("error", (err) => {
            console.error(`[Socket Error] userId=${userId}:`, err.message);
        });
    });
}

module.exports = { initSocketIO };
