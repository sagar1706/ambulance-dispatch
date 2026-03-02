// ─────────────────────────────────────────────────────────────────
// Email Utility — sends emails via SMTP (Nodemailer)
//
// HOW IT WORKS:
//   1. Reads SMTP config from environment variables
//   2. Creates a reusable transporter object (connection pool)
//   3. Exports helper functions for specific email types
//
// DEVELOPMENT MODE (no SMTP config):
//   If SMTP_HOST is not set, the email is NOT sent — instead
//   the reset link is printed to the console. This lets you test
//   the full flow without setting up a mail server.
//
// PRODUCTION:
//   Set the SMTP_* variables in your .env (or deployment platform).
//   You can use any SMTP service: Gmail, SendGrid, Mailgun, AWS SES,
//   Resend, etc. They all provide SMTP credentials.
//
// GMAIL EXAMPLE (.env):
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587
//   SMTP_USER=your@gmail.com
//   SMTP_PASS=your_app_password   ← use App Password, not account password
//   FROM_EMAIL=AmbulanceDispatch <your@gmail.com>
// ─────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");

// Create transporter once (not on every email send — that wastes connections)
let transporter = null;

function getTransporter() {
    if (transporter) return transporter;  // reuse existing connection

    if (!process.env.SMTP_HOST) {
        // No SMTP configured — return null and callers will log to console instead
        return null;
    }

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        // `secure: true` uses port 465 (SSL from start)
        // `secure: false` with port 587 uses STARTTLS (upgrades to SSL mid-connection)
        // 587 + STARTTLS is the modern standard
        secure: process.env.SMTP_PORT === "465",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    return transporter;
}

// ─────────────────────────────────────────────────────────────────
// sendPasswordResetEmail
//
// Sends a password reset link to the user's email address.
// If SMTP is not configured, logs the link to the console.
//
// @param {string} toEmail — recipient email
// @param {string} resetToken — the secure random token
// ─────────────────────────────────────────────────────────────────
async function sendPasswordResetEmail(toEmail, resetToken) {
    // The frontend URL that handles the reset form
    // In production, this is your deployed web app URL
    const frontendUrl = process.env.CLIENT_URL || "http://localhost:3000";
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

    const t = getTransporter();

    if (!t) {
        // Development fallback — display in server console
        // This lets you test the full flow without email
        console.log("\n==================================================");
        console.log("📧 PASSWORD RESET EMAIL (no SMTP configured)");
        console.log(`To: ${toEmail}`);
        console.log(`Reset link: ${resetLink}`);
        console.log("Token expires in 15 minutes");
        console.log("==================================================\n");
        return { preview: resetLink };
    }

    const info = await t.sendMail({
        from: process.env.FROM_EMAIL || "AmbulanceDispatch <noreply@ambulance.com>",
        to: toEmail,
        subject: "Reset Your Password — Ambulance Dispatch",
        // Plain text version (for email clients that don't render HTML)
        text: `
You requested a password reset for your Ambulance Dispatch account.

Click this link to reset your password (valid for 15 minutes):
${resetLink}

If you did not request this, please ignore this email. Your password will not change.
    `.trim(),
        // HTML version — clean, minimal design
        html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #f9f9f9; border-radius: 8px;">
        <h2 style="color: #e53e3e; margin-bottom: 8px;">🚑 Password Reset</h2>
        <p style="color: #333; font-size: 15px;">You requested a password reset for your Ambulance Dispatch account.</p>
        <p style="color: #333; font-size: 15px;">Click the button below to reset your password. This link is valid for <strong>15 minutes</strong>.</p>
        <a href="${resetLink}"
          style="display: inline-block; margin: 20px 0; padding: 14px 28px;
                 background: #e53e3e; color: #fff; text-decoration: none;
                 border-radius: 6px; font-size: 15px; font-weight: bold;">
          Reset Password
        </a>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          If you did not request this, ignore this email. Your password will not change.<br/>
          This link expires in 15 minutes.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin-top: 24px;" />
        <p style="color: #aaa; font-size: 12px;">Ambulance Dispatch API</p>
      </div>
    `,
    });

    return { messageId: info.messageId };
}

module.exports = { sendPasswordResetEmail };
