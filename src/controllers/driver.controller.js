const prisma = require("../config/prisma");

// ─────────────────────────────────────────────
// GET /api/driver/me
// DRIVER: View own profile + current stats
// ─────────────────────────────────────────────
exports.getMyProfile = async (req, res) => {
  try {
    const driver = await prisma.driver.findUnique({
      where: { userId: req.user.userId },
      include: {
        user: { select: { id: true, name: true, email: true, createdAt: true } },
        _count: { select: { bookings: true } },
      },
    });

    if (!driver) {
      return res.status(404).json({ error: "Driver profile not found for this account" });
    }

    res.json({ driver });
  } catch (error) {
    console.error("Get driver profile error:", error);
    res.status(500).json({ error: "Failed to fetch driver profile." });
  }
};

// ─────────────────────────────────────────────
// GET /api/driver/bookings?status=&page=&limit=
// DRIVER: View all bookings assigned to me
// ─────────────────────────────────────────────
exports.getMyAssignedBookings = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // First get the driver record
    const driver = await prisma.driver.findUnique({
      where: { userId: req.user.userId },
    });

    if (!driver) {
      return res.status(404).json({ error: "Driver profile not found for this account" });
    }

    const VALID_STATUSES = ["REQUESTED", "ASSIGNED", "EN_ROUTE", "ARRIVED", "COMPLETED", "CANCELLED"];

    const where = { driverId: driver.id };
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: `Invalid status filter. Use one of: ${VALID_STATUSES.join(", ")}`,
        });
      }
      where.status = status;
    }

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);

    res.json({
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      driver: { id: driver.id, isAvailable: driver.isAvailable },
      bookings,
    });
  } catch (error) {
    console.error("Get assigned bookings error:", error);
    res.status(500).json({ error: "Failed to fetch assigned bookings." });
  }
};

// ─────────────────────────────────────────────
// PATCH /api/driver/availability
// ─────────────────────────────────────────────
exports.updateAvailability = async (req, res) => {
  try {
    // Guard against missing Content-Type: application/json header
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        error: "Request body is missing. Make sure to set Content-Type: application/json",
      });
    }

    const { isAvailable } = req.body;

    // ── Input Validation ──
    if (typeof isAvailable !== "boolean") {
      return res.status(400).json({
        error: "isAvailable must be a boolean value (true or false)",
      });
    }

    // ── Check driver profile exists ──
    const existingDriver = await prisma.driver.findUnique({
      where: { userId: req.user.userId },
    });

    if (!existingDriver) {
      return res.status(404).json({
        error: "Driver profile not found for this account",
      });
    }

    // ── Update availability ──
    const driver = await prisma.driver.update({
      where: { userId: req.user.userId },
      data: { isAvailable },
      select: {
        id: true,
        userId: true,
        isAvailable: true,
        currentLat: true,
        currentLng: true,
        updatedAt: true,
      },
    });

    res.json({
      message: `Driver is now marked as ${isAvailable ? "available" : "unavailable"}`,
      driver,
    });
  } catch (error) {
    console.error("Driver availability update error:", error);
    res.status(500).json({ error: "Failed to update availability. Please try again." });
  }
};

// ─────────────────────────────────────────────
// PATCH /api/driver/location
// ─────────────────────────────────────────────
exports.updateLocation = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    // ── Input Validation ──
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: "lat and lng are required" });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: "lat and lng must be valid numbers" });
    }

    if (latitude < -90 || latitude > 90) {
      return res.status(400).json({ error: "lat must be between -90 and 90" });
    }

    if (longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: "lng must be between -180 and 180" });
    }

    // ── Check driver profile exists ──
    const existingDriver = await prisma.driver.findUnique({
      where: { userId: req.user.userId },
    });

    if (!existingDriver) {
      return res.status(404).json({ error: "Driver profile not found for this account" });
    }

    // ── Update location ──
    const driver = await prisma.driver.update({
      where: { userId: req.user.userId },
      data: { currentLat: latitude, currentLng: longitude },
      select: {
        id: true,
        userId: true,
        isAvailable: true,
        currentLat: true,
        currentLng: true,
        updatedAt: true,
      },
    });

    res.json({
      message: "Location updated successfully",
      driver,
    });
  } catch (error) {
    console.error("Driver location update error:", error);
    res.status(500).json({ error: "Failed to update location. Please try again." });
  }
};