# Wave E screenshots — signed-in and staff screens, before and after

Eleven screens at two widths, captured before and after the Task 42 polish.
Every file is `<screen>-<width>-<phase>.png`: width is `mobile` (390×844,
1×) or `desktop` (1280×800), phase is `before` or `after`. All are full-page
PNGs under 300 KB.

| Screen | Route | What changed |
|---|---|---|
| `account` | `/account` | Page header with purpose line; listing cards carry status and tier pills, a views sparkline where there are views, and one next action; empty state links to search; claim outcome is a Notice |
| `account-listing` | `/account/listings/[id]` | Header with back link, status/tier pills and the page's links under it |
| `account-billing` | `/account/billing` | Header with back link; plan, payment history and verification as sections; empty plan and unconfigured billing as EmptyState and Notice; invoices become cards on a phone |
| `account-settings` | `/account/settings` | Same header and section rhythm as billing; forms use the shared submit button and Notice |
| `claim` | `/claim/[listing]` | Four-step indicator, back link in the header, one primary button, "what happens next" in the sent state |
| `leave-review` | `/leave-review/[id]` | Three-step indicator, back link, "what happens next" in the sent state |
| `forgot-password` | `/forgot-password` | Three-step indicator, back to sign in, "what happens next" in the sent state |
| `admin` | `/admin` | Queue counts as badges in the sub-nav; the nav scrolls in one row on a phone |
| `admin-submissions` | `/admin/submissions` | Table becomes cards under 640px; pagination as buttons; empty state |
| `admin-submission-detail` | `/admin/submissions/[id]` | Header with back link and status pill; key/value rows; one primary and one secondary decision button |
| `admin-reports` | `/admin/reports` | Empty state; with rows, a sticky action bar on phones and live outcome notices |

## Reproduce

The capture is a Playwright spec beside this file that reuses
`playwright.config.ts` (same build, database and environment as the e2e
suite). It signs up a throwaway admin, lends it one seeded listing, files one
pending submission, shoots every screen, and puts everything back.

```sh
bash scripts/e2e-db.sh
SHOT_PHASE=after E2E_PORT=3242 REDIS_URL=redis://localhost:6380/4 \
  corepack pnpm exec playwright test --config docs/screenshots/wave-e/capture.config.ts
```

`SHOT_PHASE=before` names the files for a baseline run.
