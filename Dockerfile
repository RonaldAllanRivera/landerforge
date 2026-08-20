# syntax=docker/dockerfile:1

# Multi-stage build. The runner carries no toolchain, no source and no dev
# dependencies — only the standalone server Next emits.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# corepack installs the exact pnpm pinned by `packageManager` in package.json, so the
# image resolves dependencies identically to CI and to a developer's machine.
RUN corepack enable
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# git does not track empty directories, so a fresh checkout carries no `public/`
# and the runner's COPY of it would fail. Create it here so the runner stage is
# correct whether or not the repo has static assets yet.
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Run unprivileged.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
