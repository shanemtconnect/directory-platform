# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Built once in CI with no site secrets. Everything else is injected at boot.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The cache handler is loaded at RUNTIME and is not traced into standalone.
# Without these three lines the container boots with no shared cache and
# silently falls back to per-container LRU — every deploy then throws away
# thousands of regenerated pages.
COPY --from=builder /app/cache-handler.mjs ./cache-handler.mjs
COPY --from=builder /app/node_modules/@fortedigital ./node_modules/@fortedigital
COPY --from=builder /app/node_modules/@redis ./node_modules/@redis

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]

# Same image, different entrypoint. Run with WORKER_ENABLED=true.
FROM runner AS worker
USER root
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/config ./config
USER nextjs
CMD ["node", "--experimental-strip-types", "worker/index.ts"]
