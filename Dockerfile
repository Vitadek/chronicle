# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# --- Build stage --------------------------------------------------------------
# We need python/make/g++ here because better-sqlite3 compiles a native binding.
# These tools are *not* installed in the runtime stage — kept small that way.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder

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
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

# tini reaps zombies and forwards signals properly, which matters for graceful
# shutdown of the Express server when the container is stopped.
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# Copy what the runtime actually needs.
COPY --chown=node:node --from=builder /app/dist           ./dist
COPY --chown=node:node --from=builder /app/node_modules   ./node_modules
COPY --chown=node:node --from=builder /app/package.json   ./package.json
COPY --chown=node:node --from=builder /app/scripts/storage-launcher.cjs ./scripts/storage-launcher.cjs

# Bundled plugin sources. On first boot the server copies any not-yet-installed
# one into /data/plugins and compiles it (esbuild ships as a runtime dep for
# exactly this), so a fresh or air-gapped install is fully featured with no
# network. They remain git-updatable afterwards.
COPY --chown=node:node --from=builder /app/plugins-seed   ./plugins-seed

# Persist user data outside the image.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null || exit 1

LABEL org.opencontainers.image.source=https://forgejo.lan/protoman/chronicle.git
LABEL org.opencontainers.image.description="Chronicle: A robust, self-hosted manuscript workstation."
LABEL org.opencontainers.image.licenses=MIT

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.cjs"]
