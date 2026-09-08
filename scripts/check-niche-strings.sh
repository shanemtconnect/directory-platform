#!/usr/bin/env bash
# No niche string may be hardcoded in a component. Everything comes from
# siteConfig.entity, or the next clone ships a plumber directory saying "venue".
#
# The banned list is derived from the current niche. Regenerate it in the clone
# kit so a plumber site bans "plumber", not "venue".
set -uo pipefail
BANNED='venue|venues|wedding|weddings|couple|couples|bride|groom'

HITS=$(grep -rniE "$BANNED" app components lib worker \
        --include='*.ts' --include='*.tsx' \
        2>/dev/null \
      | grep -v '\.test\.' \
      | grep -v 'siteConfig' \
      || true)

if [ -n "$HITS" ]; then
  echo "FAIL: hardcoded niche strings found. Use siteConfig.entity instead."
  echo "$HITS"
  exit 1
fi
echo "OK: no hardcoded niche strings in app/, components/, lib/ or worker/"
