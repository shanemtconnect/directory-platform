import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/server";
import { limitPublicWrite } from "@/lib/spam/write-limit";

/**
 * A function, not the auth object: `toNextJsHandler(auth)` reads `auth.handler`
 * as this module is evaluated, and building the auth instance opens a database
 * connection. Passing a closure defers both to the first request, so this route
 * costs nothing to build. `toNextJsHandler` accepts either shape.
 */
const betterAuth = toNextJsHandler((request: Request) => getAuth().handler(request));

/**
 * 20 POSTs per 10 minutes per client.
 *
 * This is the one public write path on the site that was not behind a counter
 * of ours. Everything a stranger can POST here is an attempt at somebody's
 * account — sign-in, sign-up, forgot-password, reset-password — so the budget
 * is sized for a person who mistypes a password and asks for a reset, not for
 * a script working through a credential list.
 *
 * One bucket for every auth POST on purpose: a budget spent per endpoint would
 * let a client multiply it by rotating between sign-in, sign-up and
 * forgot-password, which is exactly what credential stuffing does.
 *
 * This sits IN FRONT OF Better Auth's own limiter rather than replacing it.
 * Better Auth's is in-memory and therefore per instance (lib/auth/server.ts),
 * so behind several replicas it lets through a multiple of its cap; this one
 * counts in Redis, shared across replicas, and falls back to a per-process map
 * only while Redis is down.
 */
export const AUTH_RATE_LIMIT = { limit: 20, windowSeconds: 600 } as const;

/**
 * GET is deliberately unmetered: `get-session` is read by every server render
 * on the site, so a counter in front of it would rate-limit ordinary browsing
 * rather than an attacker. It reads a session cookie and writes nothing.
 */
export const GET = betterAuth.GET;

export async function POST(request: Request): Promise<Response> {
  const limit = await limitPublicWrite("auth", request.headers, AUTH_RATE_LIMIT);

  if (!limit.allowed) {
    // No detail about the budget, the subject or which endpoint tripped it:
    // an attacker enumerating accounts should learn nothing from being
    // blocked that they did not already know.
    return Response.json(
      { message: "Too many attempts from this connection. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(limit.retryAfterSeconds),
          // Never let a 429 be cached and served to somebody else.
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return betterAuth.POST(request);
}
