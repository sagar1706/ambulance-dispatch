# ─────────────────────────────────────────────────────────────────
# Dockerfile
#
# Docker packages your app and ALL its dependencies into a single
# "image" that runs identically on any machine — your laptop,
# a VPS, AWS, GCP, Azure, whatever. No more "works on my machine".
#
# HOW IT WORKS:
#   1. Starts from the official Node.js image (already has Node installed)
#   2. Copies your package.json and installs dependencies
#   3. Generates Prisma client
#   4. Copies your source code
#   5. Exposes port 5000
#   6. Runs the server
#
# COMMANDS:
#   docker build -t ambulance-api .         # build the image
#   docker run -p 5000:5000 ambulance-api   # run it
#   docker-compose up --build               # start app + database together
#   docker-compose down                     # stop everything
# ─────────────────────────────────────────────────────────────────

# ── Stage 1: Use official Node LTS (Long Term Support) image ─────
# "alpine" is a tiny Linux distro (5MB vs 900MB for full Ubuntu).
# Using a specific version (20-alpine) instead of "latest" prevents
# surprise breaking changes when Node releases a new major version.
FROM node:20-alpine

# ── Set working directory inside the container ───────────────────
# All subsequent commands run from /app inside the container.
WORKDIR /app

# ── Copy only package files first ────────────────────────────────
# WHY: Docker caches each step. If you copy everything first and then
# run npm install, Docker re-installs all packages every time ANY file
# changes. By copying package.json first, npm install is only re-run
# when package.json actually changes — much faster rebuilds.
COPY package*.json ./
COPY prisma ./prisma/

# ── Install production dependencies only ─────────────────────────
# --omit=dev skips devDependencies (like nodemon) — not needed in prod.
RUN npm ci --omit=dev

# ── Generate Prisma client ────────────────────────────────────────
# Prisma generates a JavaScript client from your schema.prisma.
# This MUST run inside the container because it generates platform-
# specific binaries for the container's OS (Linux/alpine).
RUN npx prisma generate

# ── Copy the rest of the source code ─────────────────────────────
# The .dockerignore file prevents node_modules, .env, logs, etc.
# from being copied (like .gitignore but for Docker).
COPY src ./src

# ── Create logs directory ─────────────────────────────────────────
# Our server writes log files to ./logs — create it in advance.
RUN mkdir -p logs

# ── Expose the port ───────────────────────────────────────────────
# This documents which port the container listens on.
# It doesn't actually publish the port — that happens in docker-compose
# or `docker run -p 5000:5000`.
EXPOSE 5000

# ── Health check ──────────────────────────────────────────────────
# Docker periodically hits this URL to confirm the container is healthy.
# If it fails 3 times, Docker marks the container as "unhealthy".
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:5000/ || exit 1

# ── Start the server ──────────────────────────────────────────────
# Using array form (exec form) instead of string form.
# This makes SIGTERM/SIGINT signals reach Node directly
# (critical for graceful shutdown to work properly).
CMD ["node", "src/server.js"]
