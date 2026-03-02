const prisma = require("../config/prisma");

// Strip HTML tags from input to prevent stored XSS
// e.g. '<script>bad</script>John' → 'John'
const sanitize = (str) => str.replace(/<[^>]*>/g, "").trim();

// ─────────────────────────────────────────────────────────────────
// GET /api/user/me
// Any logged-in user can view their own profile
//
// HOW IT WORKS:
//   1. req.user.userId comes from the JWT token (set by auth middleware)
//   2. We fetch the user from the database using that ID
//   3. We EXCLUDE the password hash from the response (security!)
//   4. If the user is a DRIVER, we also include their driver profile
//   5. We count how many bookings they've made
//
// WHY SELECT SPECIFIC FIELDS:
//   Instead of returning everything (including password), we use
//   Prisma's `select` to pick only the fields we want — this is
//   called "projection" and it's a security best practice.
// ─────────────────────────────────────────────────────────────────
exports.getMyProfile = async (req, res) => {
    try {
        // req.user.userId was set by authenticateToken middleware
        // It comes from the decoded JWT: { userId: "...", role: "..." }
        const user = await prisma.user.findUnique({
            where: { id: req.user.userId },

            // Select ONLY the fields we want to expose
            // Notice: password is NOT included — never send password hashes!
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                createdAt: true,

                // If this user is a driver, include their driver profile too
                // This uses Prisma's relation loading — it JOINs the Driver table
                driver: {
                    select: {
                        id: true,
                        isAvailable: true,
                        currentLat: true,
                        currentLng: true,
                        updatedAt: true,
                    },
                },

                // Count how many bookings this user has made
                // _count is a Prisma feature that does COUNT(*) in SQL
                // Much faster than fetching all bookings and counting in JS
                _count: {
                    select: { bookings: true },
                },
            },
        });

        // This should never happen (user is authenticated) but just in case
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json({ user });
    } catch (error) {
        console.error("Get user profile error:", error);
        res.status(500).json({ error: "Failed to fetch profile." });
    }
};

// ─────────────────────────────────────────────────────────────────
// PATCH /api/user/me
// User updates their own name and/or email
//
// HOW IT WORKS:
//   1. User sends { name: "New Name" } or { email: "new@email.com" } or both
//   2. We validate the new values (same rules as registration)
//   3. If changing email, we check it's not already taken by someone else
//   4. We update ONLY the fields the user sent (partial update)
//   5. Return the updated profile (without password)
//
// WHY PARTIAL UPDATE:
//   The user might want to change only their name, not their email.
//   So we build a `data` object with only the fields they provided.
//   Prisma's update() will only modify the fields in `data`.
//
// SECURITY:
//   - Users CANNOT change their own role (only admins should do that)
//   - Users CANNOT change their password here (separate endpoint for that)
//   - Email uniqueness is enforced so no two users share an email
// ─────────────────────────────────────────────────────────────────
exports.updateMyProfile = async (req, res) => {
    try {
        // Guard against missing body (Postman without Content-Type: application/json)
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({
                error: "Request body is missing. Set Content-Type: application/json",
            });
        }

        const { name, email } = req.body;

        // At least one field must be provided — otherwise what are we updating?
        if (!name && !email) {
            return res.status(400).json({
                error: "Provide at least one field to update: name or email",
            });
        }

        // Build update data object — only include fields that were sent
        // This way, if user sends only { name: "..." }, email stays unchanged
        const data = {};

        // ── Validate & add name ──
        if (name !== undefined) {
            const trimmedName = sanitize(name);
            if (!/^[a-zA-Z\s]{2,50}$/.test(trimmedName)) {
                return res.status(400).json({
                    error: "Name must be 2–50 characters and contain only letters and spaces",
                });
            }
            data.name = trimmedName;
        }


        // ── Validate & add email ──
        if (email !== undefined) {
            const trimmedEmail = sanitize(email).toLowerCase();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
            if (!emailRegex.test(trimmedEmail)) {
                return res.status(400).json({ error: "Invalid email address format" });
            }

            // Check if this email is already used by ANOTHER user
            // We need to exclude the current user from the check —
            // otherwise changing your name while keeping same email would fail
            const existingUser = await prisma.user.findFirst({
                where: {
                    email: trimmedEmail,
                    // NOT: { id: currentUserId } → find anyone EXCEPT me with this email
                    NOT: { id: req.user.userId },
                },
            });

            if (existingUser) {
                return res.status(409).json({
                    error: "This email is already used by another account",
                });
            }

            data.email = trimmedEmail;
        }

        // ── Perform the update ──
        const updatedUser = await prisma.user.update({
            where: { id: req.user.userId },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                createdAt: true,
            },
            data,
        });

        res.json({
            message: "Profile updated successfully",
            user: updatedUser,
        });
    } catch (error) {
        console.error("Update user profile error:", error);
        res.status(500).json({ error: "Failed to update profile." });
    }
};
