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
# No DATABASE_URL. The build does not need one.
#
# `/`, `/cities` and `/categories` are still ISR pages that read Postgres, but
# they ask `prerenderingWithoutDatabase()` first (lib/db/build-phase.ts) and
# prerender their empty-state shell when there is nothing to read; ISR fills in
# the real page on the first request, where a database is guaranteed because
# instrumentation.ts refuses to boot a server without one. `lib/db/client.ts`
# and `lib/auth/server.ts` open their connection on first use rather than on
# import, so merely collecting page data no longer needs a database either.
#
# The two catch-all routes were already clear: their `generateStaticParams`
# return [] precisely so the image can be built without one.
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

# The migrations, and the one script that can apply them without drizzle-kit.
#
# Coolify's pre-deployment command runs in THIS image, and `drizzle-kit` is a
# devDependency that the prod-only tree above does not contain — so without
# these two the deploy has no way to migrate, and a container that starts ahead
# of its migration serves a site whose every enquiry form fails: the enquiry
# action inserts into `job_queue` inside its own transaction, so a missing
# column takes the form down and not merely the worker.
#
# `scripts/migrate.mjs` alone, not `scripts/`: everything else in there is
# TypeScript or bash that this image cannot run anyway. Its two imports,
# `drizzle-orm` and `postgres`, are runtime dependencies already present above.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs

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
# Seeding a fresh deployment happens here, not in the runner: `scripts/seed-cli.ts`
# is TypeScript and needs tsx, which only this stage's dev-inclusive tree has.
#
#   docker exec <worker> ./node_modules/.bin/tsx scripts/seed-cli.ts <niche>
#
# `<niche>` defaults to `slugify(siteConfig.entity.plural)`, which is also the
# name of the folder under seeds/ — so a clone renames one directory and the
# command keeps working with no argument. `drizzle.config.ts` rides along for
# `drizzle-kit` (studio, generate) run by hand against a live database.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/seeds ./seeds
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts
CMD ["./node_modules/.bin/tsx", "worker/index.ts"]
