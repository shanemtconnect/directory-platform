import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/server";

/**
 * A function, not the auth object: `toNextJsHandler(auth)` reads `auth.handler`
 * as this module is evaluated, and building the auth instance opens a database
 * connection. Passing a closure defers both to the first request, so this route
 * costs nothing to build. `toNextJsHandler` accepts either shape.
 */
export const { GET, POST } = toNextJsHandler((request: Request) => getAuth().handler(request));
