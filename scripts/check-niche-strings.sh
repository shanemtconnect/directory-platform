#!/usr/bin/env bash
# No niche string may be hardcoded in a component. Everything comes from
# siteConfig.entity, or the next clone ships a plumber directory saying "venue".
#
# The banned list is derived from the current niche. Regenerate it in the clone
# kit so a plumber site bans "plumber", not "venue".
set -uo pipefail
BANNED='venue|venues|wedding|weddings|couple|couples|bride|groom'

# Scanned as well as app/components/lib/worker: scripts/ (the seed default
# niche lived there) and content/ (posts are shipped source, not user data).
#
# `*.mjs` is in the include list because scripts/ is not all TypeScript any more:
# scripts/migrate.mjs is plain ESM so the prod-only runner image can execute it,
# and a file the image ships is a file this guard has to read.
DIRS='app components lib worker scripts content'

# Demo blog posts are niche-specific ON PURPOSE and load only under
# NEXT_PUBLIC_DEMO_MODE, so a clone ships without them. Nothing else in
# content/ gets a pass.
# This file names the banned words in order to ban them, so it exempts itself.
EXEMPT='^content/blog/demo/|^scripts/check-niche-strings\.sh:'

# The old version dropped any LINE containing "siteConfig", which let
# `` `${siteConfig.name} wedding venues` `` through untouched — the exact
# pattern this check exists to catch. Strip the config REFERENCE and keep the
# rest of the line, so only the literal text is judged. Line numbers survive
# because grep -n runs first and sed never adds or removes lines.
HITS=$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.md' \
        --include='*.mdx' --include='*.sh' --include='*.mjs' -e '' $DIRS 2>/dev/null \
      | grep -vE '\.test\.|\.spec\.' \
      | grep -vE "$EXEMPT" \
      | sed -E 's/siteConfig\.[A-Za-z.]+//g' \
      | grep -inE "$BANNED" \
      || true)

if [ -n "$HITS" ]; then
  echo "FAIL: hardcoded niche strings found. Use siteConfig.entity instead."
  # grep -i prepends its own line number from the piped stream; drop it so the
  # file:line the reader needs is the first thing on the line. The text after
  # that is still the siteConfig-stripped copy used for matching above — look
  # each match back up by file:line so what prints is the real source line.
  echo "$HITS" | sed -E 's/^[0-9]+://' | while IFS=: read -r file lineno _; do
    printf '%s:%s:%s\n' "$file" "$lineno" "$(sed -n "${lineno}p" "$file")"
  done
  exit 1
fi
echo "OK: no hardcoded niche strings in ${DIRS// /, }"
