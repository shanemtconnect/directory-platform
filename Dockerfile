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
# SITE_ENV is a BUILD-time switch, not a runtime one, and it has to be here for
# two separate reasons:
#
#  - `next build` runs `validateProductionConfig` (config/validate.ts), which is
#    waived only by the literal `SITE_ENV=staging`. Without this ARG a staging
#    image on a real subdomain cannot be built at all: the guard sees a
#    reachable origin and `legalEntity: "TBC"` and fails the build.
#  - `next.config.ts` `headers()` is evaluated during the build and frozen into
#    `routes-manifest.json`, so the staging `X-Robots-Tag: noindex` is baked in.
#    Setting SITE_ENV at boot cannot add or remove that header.
#
# Flipping staging -> production is therefore a REBUILD, not an env change. It
# is also declared on the runner below, because lib/site-env.ts reads it per
# request for robots.txt and the sitemap.
#
# NO DEFAULT, deliberately. `siteEnv()` treats anything that is not the literal
# "production" as staging, so an image built without this arg is noindex — which
# is the failure that is recoverable. The other way round, a staging image built
# without the arg gets indexed, and a de-indexing takes months.
ARG SITE_ENV
ENV SITE_ENV=$SITE_ENV
# SITE_FLAGS_OVERRIDE is a build arg for the same reason: `lib/features/flags.ts`
# freezes `resolveFeatures()` at build time so disabled routes are tree-shaken
# and 404. A staging deploy passes `on` so every module renders for review;
# `config/flag-variants.ts` ignores it under SITE_ENV=production, so it cannot
# flip a flag on a real site however it is set.
ARG SITE_FLAGS_OVERRIDE
ENV SITE_FLAGS_OVERRIDE=$SITE_FLAGS_OVERRIDE
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
# Same value the builder was given, for the same reason: `lib/site-env.ts` reads
# SITE_ENV per request (robots.txt is force-dynamic, the sitemap is empty on
# staging), so the runtime and the build must not disagree about which this is.
# The platform may override it at boot, but only for those per-request reads —
# the X-Robots-Tag header baked into routes-manifest.json will not follow it.
ARG SITE_ENV
ENV SITE_ENV=$SITE_ENV
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
# Turbopack's hashed externals. Packages it leaves external (sharp, the S3
# client, Sentry's *-in-the-middle hooks) are imported at runtime as
# `sharp-<hash>`, resolved from `.next/node_modules/`, where `next build` writes
# one symlink per package — into the BUILDER's pnpm layout,
# `../../node_modules/.pnpm/sharp@<ver>_<peers>/node_modules/sharp`. The hoisted
# tree above has no `.pnpm/<pkg>@<ver>_<peers>` path, so every one of those
# links dangles and every page whose import graph reaches sharp or S3 (a city,
# a listing, /advertise/sponsor) is a 500 with `Failed to load external module
# sharp-<hash>`. Re-point each dangling link at the hoisted package, and refuse
# to build if a package has no hoisted counterpart: a missing alias is a page
# that renders in `next start` and 500s only in the image.
RUN set -eu; \
  [ -d .next/node_modules ] || exit 0; \
  find .next/node_modules -type l | while IFS= read -r link; do \
    [ -e "$link" ] && continue; \
    rel=${link#.next/node_modules/}; \
    pkg=$(printf '%s' "$rel" | sed -E 's/-[0-9a-f]{16}$//'); \
    case "$rel" in */*) up=../../..;; *) up=../..;; esac; \
    [ -e "node_modules/$pkg" ] \
      || { echo "runner: hashed external $rel has no package at node_modules/$pkg" >&2; exit 1; }; \
    ln -sfn "$up/node_modules/$pkg" "$link" && chown -h nextjs:nodejs "$link"; \
    [ -e "$link" ] || { echo "runner: $link still dangles after relinking" >&2; exit 1; }; \
    echo "runner: $rel -> $up/node_modules/$pkg"; \
  done

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

# `node -e`, not curl or wget: this image is node:24-alpine plus the standalone
# server and nothing else, and adding a package to the runner just to ask it a
# question is a package to patch forever. Node 24 has a global fetch.
#
# The exit code follows the endpoint's status, which is 503 when the database is
# unreachable — so a container that is listening but cannot serve is marked
# unhealthy instead of being left in the load balancer answering 500s. That is
# the whole point; a TCP check on the port cannot tell the difference.
#
# start-period 60s because docker-entrypoint.sh may run migrations before the
# server starts (MIGRATE_ON_BOOT), and a failure during the start period is not
# counted against the retries.
#
# Coolify: set the health check path to /api/health on the web service. It does
# not read this instruction — it runs its own check — so the two are configured
# separately and should agree.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]

# Same image, different entrypoint. Run with WORKER_ENABLED=true.
#
# tsx, not `node --experimental-strip-types`: the worker imports `@/lib/db/client`
# and only tsx resolves the tsconfig `paths` alias. It comes from the full
# (dev-inclusive) dependency tree, which also replaces the runner's prod-only one.
FROM runner AS worker
# Inherited from `runner` otherwise, and the worker serves no HTTP: every check
# would fail and the container would sit permanently unhealthy while working
# perfectly. Its liveness signal is the five-minute heartbeat in worker/index.ts
# — watch that with UPTIME_PUSH_URL or a log alert, not with a port check.
#
# Not `HEALTHCHECK NONE`, though: Coolify sees a HEALTHCHECK instruction and
# waits for Docker to say "healthy", and a container with no check never does
# — every worker deploy failed after three minutes with the old container left
# running. So the check is the liveness file worker/index.ts touches at boot and
# on every five-minute heartbeat (lib/boot/liveness.ts): stale for fifteen
# minutes means the event loop is wedged, which a process check would miss.
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD sh -c 'find /tmp/worker-alive -mmin -15 2>/dev/null | grep -q .'
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
