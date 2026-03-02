// ─────────────────────────────────────────────────────────────────
// Shared Driver Assignment Logic
//
// WHY THIS FILE EXISTS:
//   The "find nearest driver + assign" logic was duplicated:
//     1. admin.controller.js → assignDriver()
//     2. dispatch.worker.js  → needs the same logic
//
//   DRY principle: Don't Repeat Yourself.
//   Extract it here so both can import it.
//
// THE HAVERSINE FORMULA:
//   Calculates the straight-line distance between two GPS points
//   on the surface of the Earth (accounts for Earth's curvature).
//   Result is in kilometers.
//
//   "As the crow flies" — not road distance, but good enough for
//   dispatch because we want to minimize travel time to the patient.
//
// WHY NOT USE GOOGLE MAPS API:
//   - Latency: API call adds 100-300ms per assignment
//   - Cost: Google charges per API call
//   - Offline: fails if API is unreachable
//   Haversine is instant, free, and reliable.
// ─────────────────────────────────────────────────────────────────

const prisma = require("../config/prisma");
const logger = require("./logger");

// ─────────────────────────────────────────────────────────────────
// Haversine distance between two GPS coordinates
// Returns distance in kilometers
// ─────────────────────────────────────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;            // Earth's radius in km
    const dLat = deg2rad(lat2 - lat1);
    const dLng = deg2rad(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) *
        Math.cos(deg2rad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// ─────────────────────────────────────────────────────────────────
// Find nearest available approved driver to a pickup location
// Returns the nearest driver or null if none available
// ─────────────────────────────────────────────────────────────────
async function findNearestDriver(pickupLat, pickupLng) {
    // Only consider drivers who are:
    //   - isAvailable: true      → not on a current job
    //   - isApproved: true       → admin has approved them
    //   - currentLat/Lng != null → have reported their location
    const drivers = await prisma.driver.findMany({
        where: {
            isAvailable: true,
            isApproved: true,
            currentLat: { not: null },
            currentLng: { not: null },
        },
        include: { user: { select: { name: true } } },
    });

    if (drivers.length === 0) return null;

    let nearest = null;
    let minDist = Infinity;

    for (const driver of drivers) {
        const dist = haversineDistance(pickupLat, pickupLng, driver.currentLat, driver.currentLng);
        if (dist < minDist) {
            minDist = dist;
            nearest = { ...driver, distanceKm: parseFloat(dist.toFixed(2)) };
        }
    }

    return nearest;
}

// ─────────────────────────────────────────────────────────────────
// Atomically assign a driver to a booking
// Returns: { booking, driver } on success
// Throws on race condition (driver was grabbed by another request)
// ─────────────────────────────────────────────────────────────────
async function assignDriverToBooking(bookingId, driver) {
    const [updatedBooking, driverUpdate] = await prisma.$transaction([
        prisma.booking.update({
            where: { id: bookingId },
            data: { driverId: driver.id, status: "ASSIGNED" },
            include: {
                user: { select: { id: true, name: true, email: true } },
                driver: { include: { user: { select: { name: true, email: true } } } },
            },
        }),
        // updateMany with WHERE isAvailable=true — race condition protection
        // If another request already grabbed the driver, count will be 0
        prisma.driver.updateMany({
            where: { id: driver.id, isAvailable: true },
            data: { isAvailable: false },
        }),
    ]);

    // Race condition: driver was grabbed by concurrent request
    if (driverUpdate.count === 0) {
        // Roll back the booking update
        await prisma.booking.update({
            where: { id: bookingId },
            data: { driverId: null, status: "REQUESTED" },
        });

        logger.warn("Driver assignment race condition detected", {
            bookingId,
            driverId: driver.id,
        });

        throw new Error("RACE_CONDITION: Driver was just assigned to another booking");
    }

    logger.info("Driver assigned to booking", {
        bookingId,
        driverId: driver.id,
        distanceKm: driver.distanceKm,
    });

    return { booking: updatedBooking, driver };
}

module.exports = { haversineDistance, findNearestDriver, assignDriverToBooking };
