# syntax=docker/dockerfile:1.7

# --- Build stage --------------------------------------------------------------
# We need python/make/g++ here because better-sqlite3 compiles a native binding.
# These tools are *not* installed in the runtime stage — kept small that way.
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Install deps first so they cache independently of source changes.
COPY package.json package-lock.json* ./
RUN npm ci

# Build client (vite) + server (esbuild bundle to dist/server.cjs).
COPY . .
RUN npm run build

# Prune dev deps for the runtime copy. better-sqlite3's compiled binding lives
# under node_modules/better-sqlite3/build, so we need node_modules at runtime.
RUN npm prune --omit=dev


# --- Runtime stage ------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards signals properly, which matters for graceful
# shutdown of the Express server when the container is stopped.
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# Copy what the runtime actually needs.
COPY --from=builder /app/dist           ./dist
COPY --from=builder /app/node_modules   ./node_modules
COPY --from=builder /app/package.json   ./package.json

# Persist user data outside the image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

LABEL org.opencontainers.image.source=https://github.com/Vitadek/chronicle
LABEL org.opencontainers.image.description="Chronicle: A robust, self-hosted manuscript workstation."
LABEL org.opencontainers.image.licenses=MIT

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.cjs"]
