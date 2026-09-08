import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/server";
import { AUTH_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";

/**
 * A function, not the auth object: `toNextJsHandler(auth)` reads `auth.handler`
 * as this module is evaluated, and building the auth instance opens a database
 * connection. Passing a closure defers both to the first request, so this route
 * costs nothing to build. `toNextJsHandler` accepts either shape.
 */
const betterAuth = toNextJsHandler((request: Request) => getAuth().handler(request));

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
