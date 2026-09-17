import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import {
  AUTH_TOKEN_TTL_SECONDS,
  NOTIFY_AUTH_RESET,
  NOTIFY_AUTH_VERIFY,
  notifyAuthEmail,
} from "@/lib/email/notify";

/**
 * Self-hosted auth: sessions live in our own Postgres, so a site can be sold or
 * moved with a pg_dump and a DNS change. No external auth dependency.
 *
 * Google is registered only when both credentials are present — a half-set
 * provider would render a sign-in button that always fails.
 */
const googleConfigured =
  Boolean(process.env.GOOGLE_CLIENT_ID) && Boolean(process.env.GOOGLE_CLIENT_SECRET);

/**
 * Built on FIRST USE, not on import.
 *
 * `drizzleAdapter(db, ...)` reads the database handle as it is constructed, so
 * a module-scope `betterAuth({...})` opened a connection the moment anything
 * imported this file — including `next build` collecting page data for /admin,
 * which needs no database at all. Deferring it is what lets the image be built
 * without one; `instrumentation.ts` still refuses to boot a server that has no
 * DATABASE_URL, BETTER_AUTH_SECRET or BETTER_AUTH_URL.
 */
let instance: ReturnType<typeof build> | null = null;

/**
 * The link we put in the email, built here rather than used as handed over.
 *
 * Better Auth composes the URL from its own baseURL and whatever `callbackURL`
 * or `redirectTo` the CALLER supplied — which, for anything that can POST to
 * /api/auth, is a stranger. Rebuilding it from the token alone means both
 * links always land on our own two pages, whoever started the flow.
 *
 * `/api/auth` is Better Auth's default basePath and matches the route at
 * app/api/auth/[...all]. Both move together or neither does.
 */
function authLink(path: string): string {
  const base = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  return `${base.replace(/\/$/, "")}/api/auth${path}`;
}

/**
 * Neither callback sends anything. Both write a job row and return — see
 * lib/email/notify.ts. Better Auth calls them inside the request that asked
 * for the reset, and a request that waits on a mail provider is a sign-up form
 * that hangs when Resend is slow and a lost email when it is down.
 */
async function queueAuthEmail(
  kind: typeof NOTIFY_AUTH_RESET | typeof NOTIFY_AUTH_VERIFY,
  userId: string,
  url: string,
): Promise<void> {
  await notifyAuthEmail(db, PUBLIC_VIEWER, kind, { userId, url });
}

function build() {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    appName: siteConfig.name,

    emailAndPassword: {
      enabled: true,
      // Owners claim a business, so a working address matters more than a fast
      // signup. Phase 4's claim ladder leans on the address being real.
      requireEmailVerification: false,
      minPasswordLength: 10,

      /**
       * Stated in the email body too, from the same constant — a message that
       * promises an hour for a token that lasted fifteen minutes is a support
       * ticket nobody can answer.
       */
      resetPasswordTokenExpiresIn: AUTH_TOKEN_TTL_SECONDS,

      /**
       * A reset is what somebody does when they think the account may not be
       * theirs alone any more. Leaving every other session signed in would
       * defeat the point of the exercise.
       */
      revokeSessionsOnPasswordReset: true,

      sendResetPassword: async ({ user, token }) => {
        await queueAuthEmail(
          NOTIFY_AUTH_RESET,
          user.id,
          authLink(`/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`),
        );
      },
    },

    /**
     * Verification is sent, but not required: `requireEmailVerification` above
     * stays false on purpose. An owner who has just paid attention to a claim
     * must not be locked out by a verification email that went to spam, and
     * the claim ladder has its own proof of ownership — a verified signup
     * address proves nothing about the business anyway. What verification buys
     * us is a working address to reach them on, so the consequence of not
     * doing it is a banner, not a wall.
     */
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: AUTH_TOKEN_TTL_SECONDS,
      /**
       * The person clicking the link is, in the overwhelming case, already
       * signed in on the device they signed up on. Minting a session from a
       * link in an email for anyone who is not is a bigger door than this
       * feature needs.
       */
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, token }) => {
        await queueAuthEmail(
          NOTIFY_AUTH_VERIFY,
          user.id,
          authLink(
            `/verify-email?token=${token}&callbackURL=${encodeURIComponent("/verify-email")}`,
          ),
        );
      },
    },

    socialProviders: googleConfigured
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          },
        }
      : {},

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      /**
       * Sixty seconds, not the five minutes it used to be. The cache is a
       * signed copy of the session in the cookie, and while it is fresh
       * `currentViewer()` believes it without reading the `session` table —
       * so a session deleted by `revokeSessionsOnPasswordReset` or
       * `revokeOtherSessions` keeps working for up to `maxAge` more. That is
       * the revocation window. A person resetting their password because
       * they suspect somebody else is signed in is promised those sessions
       * end "within a minute" (reset and change-password copy), and this
       * number is what makes the promise true. One DB read a minute per
       * signed-in visitor is the price.
       */
      cookieCache: { enabled: true, maxAge: 60 },
    },

    /**
     * Set explicitly because the default is `enabled: isProduction` — i.e. OFF
     * in development and in any container that does not set NODE_ENV, which is
     * the opposite of what you want from a security default you cannot see.
     *
     * Storage stays "memory", which means PER INSTANCE: behind several
     * replicas this cap is multiplied by the replica count, and it resets on
     * every deploy. That is why it is not the only limiter on the path — the
     * route handler in app/api/auth/[...all]/route.ts counts POSTs in Redis,
     * shared across replicas, and is the cap that actually binds. This one is
     * the per-process floor beneath it, and it also covers the paths Better
     * Auth gives stricter custom rules of its own.
     *
     * "database" storage was not chosen: it writes a row per request per
     * subject to the auth database, which is a write amplifier on exactly the
     * traffic pattern a limiter exists to survive.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "memory",
    },

    advanced: {
      // Cookies are already same-site; this keeps the prefix predictable across
      // the many domains this codebase gets cloned onto.
      cookiePrefix: "dir",
    },
  });
}

export function getAuth(): ReturnType<typeof build> {
  instance ??= build();
  return instance;
}

export type Auth = ReturnType<typeof build>;
