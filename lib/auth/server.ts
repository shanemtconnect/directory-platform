import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";

/**
 * Self-hosted auth: sessions live in our own Postgres, so a site can be sold or
 * moved with a pg_dump and a DNS change. No external auth dependency.
 *
 * Google is registered only when both credentials are present — a half-set
 * provider would render a sign-in button that always fails.
 */
const googleConfigured =
  Boolean(process.env.GOOGLE_CLIENT_ID) && Boolean(process.env.GOOGLE_CLIENT_SECRET);

export const auth = betterAuth({
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
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  advanced: {
    // Cookies are already same-site; this keeps the prefix predictable across
    // the many domains this codebase gets cloned onto.
    cookiePrefix: "dir",
  },
});

export type Auth = typeof auth;
