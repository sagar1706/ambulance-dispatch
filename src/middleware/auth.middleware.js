const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

// ─────────────────────────────────────────────────────────────────
// Verify JWT Token
//
// HOW IT WORKS:
//   1. Extract the token from "Authorization: Bearer <token>" header
//   2. Verify + decode the JWT using the secret key
//   3. Check if the user's account is still ACTIVE in the database
//      (an admin may have deactivated it after the token was issued)
//   4. Attach decoded user data to req.user for controllers to use
//
// WHY CHECK isActive IN THE DATABASE:
//   JWT tokens are stateless — once issued, they're valid until they
//   expire. If an admin deactivates a user, the old JWT still works!
//   So we MUST check the database on every request to catch this.
//   This adds one small query per request, but it's essential for
//   security. It uses Prisma's select to only fetch the isActive
//   field, so it's very fast.
// ─────────────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  // Check header exists and has correct format
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Access denied. Please provide a valid Authorization header: Bearer <token>",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. Token is missing." });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      // Distinguish between expired and invalid tokens
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Token has expired. Please login again." });
      }
      return res.status(403).json({ error: "Invalid token. Authentication failed." });
    }

    // ── Check if account is still active ──────────────────────
    // Even though the JWT is valid, the admin might have
    // deactivated this account after the token was issued.
    try {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { isActive: true },
      });

      if (!user) {
        return res.status(401).json({ error: "User account no longer exists." });
      }

      if (!user.isActive) {
        return res.status(403).json({
          error: "Your account has been deactivated. Please contact the administrator.",
        });
      }
    } catch (dbError) {
      console.error("Auth middleware DB check error:", dbError);
      return res.status(500).json({ error: "Authentication check failed." });
    }

    req.user = decoded; // { userId, role, iat, exp }
    next();
  });
}

// ─────────────────────────────────────────────
// Role-Based Authorization
// ─────────────────────────────────────────────
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. This route requires one of these roles: ${roles.join(", ")}`,
      });
    }
    next();
  };
}

module.exports = { authenticateToken, authorizeRoles };