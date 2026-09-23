/**
 * The two links Better Auth's emails carry, built from the token alone.
 *
 * Shared by lib/auth/server.ts (which used to build them) and the worker
 * (which builds them now), and deliberately free of imports: the worker must
 * be able to compose a link without pulling in Better Auth or a database
 * handle, and the site must be able to type-check the shape without a worker.
 *
 * Built from OUR origin and nothing else. Better Auth composes its own URL
 * from its baseURL plus whatever `callbackURL` or `redirectTo` the CALLER
 * supplied — which, for anything that can POST to /api/auth, is a stranger.
 * Rebuilding from the token means both links always land on our own two
 * pages, whoever started the flow, and a job payload never carries an href.
 *
 * `/api/auth` is Better Auth's default basePath and matches the route at
 * app/api/auth/[...all]. Both move together or neither does.
 */

/**
 * The origin the links point at: BETTER_AUTH_URL first, because that is what
 * Better Auth itself is configured with, then the public site URL. Null when
 * neither is a URL — a relative reset link in an email is a dead link.
 */
export function authOrigin(): string | null {
  for (const raw of [process.env.BETTER_AUTH_URL, process.env.NEXT_PUBLIC_SITE_URL]) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    try {
      return new URL(raw).origin;
    } catch {
      continue;
    }
  }
  return null;
}

function requireOrigin(): string {
  const origin = authOrigin();
  if (origin === null) {
    throw new Error("No site origin is configured (BETTER_AUTH_URL or NEXT_PUBLIC_SITE_URL)");
  }
  return origin;
}

export function passwordResetLink(token: string): string {
  const callback = encodeURIComponent("/reset-password");
  return `${requireOrigin()}/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=${callback}`;
}

export function verifyEmailLink(token: string): string {
  const callback = encodeURIComponent("/verify-email");
  return `${requireOrigin()}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${callback}`;
}
