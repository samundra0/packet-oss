# syntax=docker/dockerfile:1

# =============================================================================
# GPU Cloud Dashboard — Multi-stage Dockerfile
#
# Stages:
#   base       — pinned Node + pnpm
#   deps       — dev install (needed for Next.js build + esbuild)
#   builder    — Next.js build + esbuild the WebSocket server
#   prod-deps  — production-only install with hoisted (flat) node_modules so
#                native packages (ssh2, prisma engines) can be copied without
#                dealing with pnpm's virtual-store symlink structure
#   runner     — minimal production image
#
# Build args (set in docker-compose or via --build-arg):
#   NEXT_PUBLIC_APP_URL   — public-facing URL, baked into the JS bundle
#   NEXT_PUBLIC_EDITION   — always "oss" for this repo
#   NEXT_PUBLIC_BRAND_NAME, NEXT_PUBLIC_PRIMARY_COLOR, NEXT_PUBLIC_ACCENT_COLOR
# =============================================================================

ARG NODE_VERSION=22

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
RUN npm install -g pnpm@latest --silent

# ── deps (all deps — dev included, needed for build) ─────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── builder ──────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_EDITION=oss
ARG NEXT_PUBLIC_BRAND_NAME=
ARG NEXT_PUBLIC_PRIMARY_COLOR=
ARG NEXT_PUBLIC_ACCENT_COLOR=
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_EDITION=$NEXT_PUBLIC_EDITION \
    NEXT_PUBLIC_BRAND_NAME=$NEXT_PUBLIC_BRAND_NAME \
    NEXT_PUBLIC_PRIMARY_COLOR=$NEXT_PUBLIC_PRIMARY_COLOR \
    NEXT_PUBLIC_ACCENT_COLOR=$NEXT_PUBLIC_ACCENT_COLOR

RUN pnpm prisma generate
RUN pnpm build

# Bundle the SSH WebSocket server. ssh2 and cpu-features use native .node addons
# that esbuild cannot bundle — mark them external and supply them from prod-deps.
RUN node_modules/.bin/esbuild src/server/ssh-websocket.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --external:ssh2 \
      --external:cpu-features \
      --outfile=ws-server.js

# Bundle the Prisma seed script so it runs with plain node (no tsx in runner).
# @prisma/client is already in the runner's node_modules — keep it external.
RUN node_modules/.bin/esbuild prisma/seed.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --external:@prisma/client \
      --outfile=seed.js

# ── prod-deps (flat / hoisted node_modules — no pnpm symlinks) ───────────────
# node-linker=hoisted produces a standard flat node_modules layout that can be
# selectively copied into the runner without knowing pnpm's virtual store paths.
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN echo "node-linker=hoisted" > .npmrc && \
    pnpm install --prod --frozen-lockfile

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# ── Next.js standalone output ──
COPY --from=builder --chown=appuser:appgroup /app/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/.next/static     ./.next/static
COPY --from=builder --chown=appuser:appgroup /app/public           ./public

# ── Prisma CLI + engines for db push ──
# The standalone output includes @prisma/client but not the CLI or migration
# engines. Copy them from the flat prod-deps node_modules.
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/prisma           ./node_modules/prisma
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/@prisma          ./node_modules/@prisma
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/.prisma          ./node_modules/.prisma
COPY --from=builder   --chown=appuser:appgroup /app/prisma                        ./prisma

# ── Seed script ──
COPY --from=builder --chown=appuser:appgroup /app/seed.js ./seed.js

# ── WebSocket server + native deps ──
# ssh2 / cpu-features and their pure-JS deps (asn1, bcrypt-pbkdf) are external
# in the esbuild bundle; supply them from the flat prod-deps install.
# The binaries compiled in prod-deps are alpine-compatible with the runner.
COPY --from=builder   --chown=appuser:appgroup /app/ws-server.js                      ./ws-server.js
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/ssh2                 ./node_modules/ssh2
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/cpu-features         ./node_modules/cpu-features
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/asn1                 ./node_modules/asn1
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules/bcrypt-pbkdf         ./node_modules/bcrypt-pbkdf

# ── Runtime writable directories (volume-mounted in production) ──
RUN mkdir -p data public/branding && chown -R appuser:appgroup data public/branding

COPY --chown=appuser:appgroup docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER appuser

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["app"]
