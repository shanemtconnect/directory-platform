# syntax=docker/dockerfile:1

# `node-linker=hoisted` produces a real, npm-shaped node_modules. pnpm's default
# layout is a tree of symlinks into node_modules/.pnpm; copy a slice of that into
# an image and the links dangle, which is exactly how `cache-handler.mjs` used to
# fail its import in silence and drop every container back to a per-process LRU.
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted

# The same, minus devDependencies, for the runner. The cache handler is loaded at
# runtime and is therefore not traced into the standalone output, so its own
# dependency tree has to be present in the image on its own account.
FROM node:24-alpine AS prod-deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --config.node-linker=hoisted

FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Built once in CI. Nothing here is a per-site secret; everything else is
# injected at boot.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# NEXT_PUBLIC_ vars are inlined at BUILD time, so these must be present here or
# the map and the media CDN ship disabled however the container is later
# configured. Both are optional: `validateEnv` warns rather than failing.
ARG NEXT_PUBLIC_MAPTILER_KEY
ENV NEXT_PUBLIC_MAPTILER_KEY=$NEXT_PUBLIC_MAPTILER_KEY
ARG NEXT_PUBLIC_MEDIA_URL
ENV NEXT_PUBLIC_MEDIA_URL=$NEXT_PUBLIC_MEDIA_URL
# The build really does need a reachable database, because `next build`
# prerenders ISR pages that query it. Per .next/prerender-manifest.json those
# are `app/cities/page.tsx`, `app/page.tsx` and `app/categories/page.tsx` —
# each imports `@/lib/db/client` and exports `revalidate` without opting out of
# static generation. (The review brief names only app/cities/page.tsx; the
# manifest says otherwise, and all three have to be decoupled before this ARG
# can go away. Decoupling them belongs to another task.)
#
# The two catch-all routes are already clear: their `generateStaticParams`
# return [] precisely so the image can be built without a database.
#
# No default value on purpose. A placeholder URL here would let the build get
# all the way to prerendering before dying on ECONNREFUSED against an address
# nobody chose; the explicit check below names the missing build arg instead.
ARG DATABASE_URL
RUN test -n "$DATABASE_URL" || ( \
      echo "DATABASE_URL build arg is required." >&2; \
      echo "/, /cities and /categories prerender from the database, so 'next build'" >&2; \
      echo "needs one that is reachable from this build container." >&2; \
      echo "e.g. --build-arg DATABASE_URL=postgres://user:pw@host.docker.internal:5433/db" >&2; \
      exit 1 )
ENV DATABASE_URL=$DATABASE_URL
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Baked in as a default as well as inlined into the client bundle, so the value
# the server reads can never disagree with the one the browser was given. The
# platform may still override it at boot.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# The entrypoint may have to write a volume Docker created as root, so it runs
# as root and hands the server to an unprivileged user itself.
RUN apk add --no-cache su-exec
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY --from=builder /app/cache-handler.mjs ./cache-handler.mjs
# The handler's own imports, copied explicitly. Next's file tracer does pick
# them up today — but the handler is loaded at runtime, not traced from the
# entrypoint (see the prod-deps stage above), so tracing is not something to
# rely on for it. A missed file here is silent: the import fails and every
# container drops back to a per-process LRU.
COPY --from=builder --chown=nextjs:nodejs /app/lib/cache/*.mjs ./lib/cache/
# The standalone output ships a traced node_modules of its own, in pnpm's
# symlinked shape. Replace it wholesale rather than merging: the hoisted tree is
# a strict superset of the same lockfile, and merging a real directory onto a
# dangling symlink is what BuildKit refuses to do.
RUN rm -rf node_modules
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]

# Same image, different entrypoint. Run with WORKER_ENABLED=true.
#
# tsx, not `node --experimental-strip-types`: the worker imports `@/lib/db/client`
# and only tsx resolves the tsconfig `paths` alias. It comes from the full
# (dev-inclusive) dependency tree, which also replaces the runner's prod-only one.
FROM runner AS worker
RUN rm -rf node_modules
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/config ./config
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
CMD ["./node_modules/.bin/tsx", "worker/index.ts"]
