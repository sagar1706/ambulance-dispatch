# 🚑 Ambulance Dispatch Backend

A **production-ready REST API** for an ambulance dispatch system — built with **Node.js**, **Express**, **PostgreSQL**, **Prisma ORM**, and **Socket.IO** for real-time GPS tracking.

---

## 📋 Table of Contents
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [API Endpoints](#-api-endpoints)
- [Real-time Events (Socket.IO)](#-real-time-events-socketio)
- [Running Tests](#-running-tests)
- [Running in Production](#-running-in-production)
- [Docker](#-docker)

---

## ✨ Features

- **JWT Authentication** with role-based access control (USER, DRIVER, ADMIN)
- **Full Password Flow** — change password, forgot password, secure email reset
- **Booking lifecycle** — request → assign → en route → arrived → completed
- **Auto-assign nearest driver** using the Haversine distance formula
- **Real-time GPS tracking** via Socket.IO WebSockets
- **Admin dashboard** — manage users, drivers, bookings, approvals, performance stats
- **Driver approval workflow** — admins approve drivers before they can accept bookings
- **Rate limiting** — per-route + global API rate limiting
- **Security hardening** — Helmet headers, CORS, bcrypt, XSS sanitization, input validation
- **Database indexes** — optimized queries on all hot paths
- **Connection pooling** — configurable Prisma connection pool
- **Request size limits** — payload flood attack prevention
- **Automated tests** — 49 tests across 4 suites (Jest + Supertest)
- **Graceful shutdown** — closes DB connections on SIGINT/SIGTERM
- **Docker support** — run everything with `docker-compose up`

---

## 🛠 Tech Stack

| Technology | Purpose |
|---|---|
| Node.js + Express | HTTP server and API |
| PostgreSQL | Relational database |
| Prisma ORM | Database queries and migrations |
| Socket.IO | Real-time WebSocket events |
| JWT (jsonwebtoken) | Stateless authentication |
| bcrypt | Password hashing (12 rounds) |
| Nodemailer | Password reset emails |
| Helmet | Security HTTP headers |
| Morgan | HTTP request logging |
| express-rate-limit | Brute-force + DDoS protection |
| Jest + Supertest | Automated testing |
| PM2 | Production process manager |
| Docker | Containerization |

---

## 📁 Project Structure

```
ambulance-dispatch-backend/
├── __tests__/
│   ├── auth.test.js          # Register + login tests (12 tests)
│   ├── booking.test.js       # Booking CRUD + filter tests (15 tests)
│   ├── password.test.js      # Change/forgot/reset password (14 tests)
│   └── user.test.js          # User profile tests (8 tests)
├── src/
│   ├── server.js             # Entry point — Express + Socket.IO + middleware
│   ├── config/
│   │   └── prisma.js         # Prisma singleton with connection pooling
│   ├── controllers/
│   │   ├── auth.controller.js    # Register, login, change/forgot/reset password
│   │   ├── user.controller.js    # User profile view + update
│   │   ├── driver.controller.js  # Profile, bookings, availability, location
│   │   ├── booking.controller.js # Create, list (with filters), cancel, status
│   │   └── admin.controller.js   # Users, drivers, bookings, performance stats
│   ├── middleware/
│   │   └── auth.middleware.js    # JWT verification + role-based access
│   ├── routes/
│   │   ├── auth.routes.js        # /api/auth/*
│   │   ├── user.routes.js        # /api/user/*
│   │   ├── driver.routes.js      # /api/driver/*
│   │   ├── booking.routes.js     # /api/booking/*
│   │   └── admin.routes.js       # /api/admin/*
│   ├── utils/
│   │   └── email.js              # Nodemailer email utility
│   └── socket/
│       └── socket.js             # Socket.IO auth + GPS events
├── prisma/
│   ├── schema.prisma             # Database schema + indexes
│   └── migrations/               # Auto-generated migration history
├── .env.example                  # Template — copy to .env and fill in values
├── ecosystem.config.js           # PM2 production config
├── Dockerfile                    # Docker image build
├── docker-compose.yml            # App + DB orchestration
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- npm

### 1. Clone and install
```bash
git clone https://github.com/YOUR_USERNAME/ambulance-dispatch-backend.git
cd ambulance-dispatch-backend
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Edit .env with your database URL, JWT secret, and SMTP config
```

### 3. Set up the database
```bash
# Run migrations (creates all tables + indexes)
npm run db:migrate

# Optional: open Prisma Studio to view/edit data in browser
npm run db:studio
```

### 4. Start the server
```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

Server runs at: `http://localhost:5000`

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` and fill in your values.

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `5000` |
| `NODE_ENV` | `development` / `production` / `test` | `development` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_SECRET` | Secret key for signing JWTs (min 32 chars) | — |
| `JWT_EXPIRES_IN` | Token expiry duration | `1d` |
| `BCRYPT_ROUNDS` | Password hashing rounds (10–14) | `12` |
| `CLIENT_URL` | Frontend URL for CORS | `http://localhost:3000` |
| `SMTP_HOST` | SMTP server host (blank = console log in dev) | — |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username/email | — |
| `SMTP_PASS` | SMTP password or app password | — |
| `FROM_EMAIL` | From address for emails | — |
| `LOGIN_RATE_LIMIT_MAX` | Max login attempts per window | `10` |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | Rate limit window in ms | `900000` |
| `REGISTER_RATE_LIMIT_MAX` | Max register attempts per window | `20` |
| `GLOBAL_RATE_LIMIT_MAX` | Max requests (all routes) per window | `200` |
| `JSON_BODY_LIMIT` | Max JSON body size | `10kb` |
| `URL_BODY_LIMIT` | Max URL-encoded body size | `50kb` |
| `DB_POOL_SIZE` | Max DB connections in pool | `20` |
| `DB_POOL_TIMEOUT` | Seconds to wait for free connection | `30` |
| `LOG_TO_FILE` | `true` = write logs to `./logs/` | `false` |

---

## 📡 API Endpoints

All endpoints are prefixed with `http://localhost:5000`

### 🔓 Auth (Public)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `POST` | `/api/auth/register` | Register a new user |
| `POST` | `/api/auth/login` | Login and get JWT token |
| `POST` | `/api/auth/forgot-password` | Request a password reset email |
| `POST` | `/api/auth/reset-password` | Reset password using email token |

**Register Body:**
```json
{
  "name": "Rahul Sharma",
  "email": "rahul@example.com",
  "password": "secure1234",
  "role": "USER"
}
```
> `role` must be one of: `USER`, `DRIVER`, `ADMIN`

**Forgot Password Body:**
```json
{ "email": "rahul@example.com" }
```
> Always returns `200` (prevents email enumeration). If SMTP is not configured, the reset link is printed to the server console.

**Reset Password Body:**
```json
{
  "token": "the-64-char-hex-token-from-the-email",
  "newPassword": "NewSecure5678"
}
```
> Token expires in 15 minutes and is single-use.

---

### 🔐 Auth (Authenticated — any role)

| Method | Endpoint | Description |
|---|---|---|
| `PATCH` | `/api/auth/change-password` | Change own password (requires current password) |

**Body:**
```json
{
  "currentPassword": "OldPass1234",
  "newPassword": "NewPass5678"
}
```

---

### 👤 User Profile (Authenticated)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/user/me` | View own profile + booking count |
| `PATCH` | `/api/user/me` | Update name and/or email |

**Update Profile Body (all optional, send at least one):**
```json
{
  "name": "Updated Name",
  "email": "newemail@example.com"
}
```

---

### 🟡 Driver Routes
> **Authorization:** `Bearer <driver_token>`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/driver/me` | View own profile + stats |
| `GET` | `/api/driver/bookings` | View assigned bookings |
| `PATCH` | `/api/driver/availability` | Toggle available/unavailable |
| `PATCH` | `/api/driver/location` | Update current GPS coordinates |

**Driver Bookings — Query Params:**
```
?status=ASSIGNED     ← filter by status
?page=1&limit=10     ← pagination
```

**Update Availability:**
```json
{ "isAvailable": true }
```

**Update Location:**
```json
{ "lat": 19.0760, "lng": 72.8777 }
```

---

### 🔵 User Booking Routes
> **Authorization:** `Bearer <user_token>`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/booking` | Request an ambulance |
| `GET` | `/api/booking/my` | Get my booking history (with filters) |
| `GET` | `/api/booking/:id` | Get a specific booking |
| `PATCH` | `/api/booking/:id/cancel` | Cancel a booking |

**Request Ambulance:**
```json
{ "pickupLat": 19.0760, "pickupLng": 72.8777 }
```

**Booking History — Query Params (all optional):**
```
?status=COMPLETED         ← filter by status
?from=2024-01-01          ← filter from date
?to=2024-12-31            ← filter to date
?sort=newest              ← newest (default) | oldest
?page=1&limit=10          ← pagination (limit max 50)
```

**Response includes pagination metadata:**
```json
{
  "total": 25,
  "page": 1,
  "totalPages": 3,
  "hasNextPage": true,
  "limit": 10,
  "filters": { "status": "COMPLETED", "sort": "newest" },
  "bookings": [...]
}
```

---

### 🚗 Driver Booking Status
> **Authorization:** `Bearer <driver_token>`

| Method | Endpoint | Description |
|---|---|---|
| `PATCH` | `/api/booking/:id/status` | Progress booking status |

**Status must follow this order:**
```
ASSIGNED → EN_ROUTE → ARRIVED → COMPLETED
```
```json
{ "status": "EN_ROUTE" }
```

---

### 🔴 Admin Routes
> **Authorization:** `Bearer <admin_token>`

#### Bookings
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/bookings` | All bookings (filterable + paginated) |
| `POST` | `/api/admin/bookings/:id/assign` | Auto-assign nearest driver |
| `PATCH` | `/api/admin/bookings/:id/status` | Override booking status |

**Auto-assign (finds nearest available approved driver):**
```json
{}
```
**Or assign specific driver:**
```json
{ "driverId": "uuid-of-driver" }
```

#### Users
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/users` | All users (filter by `?role=DRIVER`) |
| `PATCH` | `/api/admin/users/:id/deactivate` | Deactivate a user account |
| `PATCH` | `/api/admin/users/:id/reactivate` | Reactivate a user account |
| `PATCH` | `/api/admin/users/:id/role` | Change a user's role |

**Change Role Body:**
```json
{ "role": "DRIVER" }
```
> Promoting to DRIVER automatically creates a Driver profile.

#### Drivers
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/drivers` | All drivers (filter by `?isApproved=true`) |
| `PATCH` | `/api/admin/drivers/:id/approve` | Approve a driver |
| `PATCH` | `/api/admin/drivers/:id/reject` | Revoke driver approval |
| `GET` | `/api/admin/drivers/:id/performance` | Driver stats (completions, response time) |

**Approve Driver Body (optional):**
```json
{ "vehicleNumber": "MH-01-AB-1234" }
```

**Performance Response:**
```json
{
  "driver": { "id": "...", "vehicleNumber": "MH-01-AB-1234" },
  "stats": {
    "totalBookings": 42,
    "completionRate": 95.2,
    "avgResponseTimeMin": 8.3,
    "breakdown": { "COMPLETED": 40, "CANCELLED": 2 }
  }
}
```

---

## 🔌 Real-time Events (Socket.IO)

**Connect with JWT:**
```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:5000", {
  auth: { token: "eyJhbGci..." }
});
```

### Server → Client Events

| Event | Who receives it | Payload |
|---|---|---|
| `new_booking` | Admins | `{ booking }` |
| `driver_assigned` | User who booked, Admins | `{ booking, distanceKm }` |
| `new_assignment` | Assigned Driver | `{ booking }` |
| `booking_status_updated` | User who booked, Admins | `{ bookingId, status }` |
| `booking_cancelled` | Admins, assigned Driver | `{ bookingId }` |
| `driver:location` | User (if assigned), Admins | `{ driverId, lat, lng }` |
| `driver_approved` | Driver | `{ message, driver }` |
| `driver_rejected` | Driver | `{ message }` |

### Client → Server Events

| Event | Who sends it | Payload |
|---|---|---|
| `driver:location_update` | Driver | `{ lat, lng }` |

---

## 🧪 Running Tests

```bash
# Run all 49 tests once
npm test

# Watch mode (re-runs on file save)
npm run test:watch

# With coverage report
npm run test:coverage
```

> Tests run against your real database. Test data is cleaned up in `afterAll` hooks.
> Set `NODE_ENV=test` — rate limiting is automatically disabled during tests.

---

## 🏭 Running in Production

### With PM2 (Recommended)
```bash
npm install -g pm2

# Start with all CPU cores
pm2 start ecosystem.config.js --env production

# View logs
pm2 logs ambulance-dispatch

# Monitor in real-time
pm2 monit

# Auto-start on system reboot
pm2 save && pm2 startup
```

---

## 🐳 Docker

### Run with Docker Compose (API + PostgreSQL)
```bash
# Build and start
docker-compose up --build

# Background
docker-compose up -d --build

# Stop
docker-compose down

# Stop + delete all data
docker-compose down -v
```

### API only (with your own DB)
```bash
docker build -t ambulance-api .
docker run -p 5000:5000 --env-file .env ambulance-api
```

---

## 📝 License

ISC
