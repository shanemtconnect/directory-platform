import { readBuildIdFile, selectBuildId } from "@/lib/cache/build-id.mjs";

let cached: string | undefined;

/**
 * Which build this process is running, for `/api/health`.
 *
 * The same derivation `cache-handler.mjs` uses to namespace its Redis keys,
 * imported rather than reimplemented: after a deploy the number a human reads
 * off the health endpoint and the number in the cache keys have to be the same
 * number, or "is the new build actually live?" has two answers.
 *
 * Memoised because it reads a file, and `.next/BUILD_ID` cannot change under a
 * running process — a new build is a new container.
 */
export function currentBuildId(): string {
  cached ??= selectBuildId({
    fileContents: readBuildIdFile(process.cwd()),
    envBuildId: process.env.NEXT_BUILD_ID,
  });
  return cached;
}
