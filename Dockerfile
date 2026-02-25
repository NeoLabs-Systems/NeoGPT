# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Native addon build deps (bcrypt, better-sqlite3 require node-gyp)
RUN apk add --no-cache python3 py3-setuptools make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine

# Non-root user for least privilege
RUN addgroup -S neogpt && adduser -S -G neogpt neogpt

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source (see .dockerignore for exclusions)
COPY --chown=neogpt:neogpt . .

# Persistent data directory (SQLite databases + session store)
RUN mkdir -p /app/data && chown neogpt:neogpt /app/data
VOLUME ["/app/data"]

USER neogpt

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
