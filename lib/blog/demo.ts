import path from "node:path";

/**
 * Demo content is opt-in, so a clone ships with an empty blog.
 *
 * Three niche-specific posts used to sit directly in `content/blog/`, which
 * meant every clone of this repo started life publishing articles about a niche
 * it was not in — and the first job of anyone cloning it was to remember to
 * delete them. They now live in `content/blog/demo/` and are only loaded when
 * `NEXT_PUBLIC_DEMO_MODE=true`.
 *
 * The e2e suite sets that flag so it keeps its blog fixtures; production
 * deployments do not, so `/blog` is empty until real posts are written.
 */

export const POSTS_DIR = path.join(process.cwd(), "content", "blog");
export const DEMO_DIR = path.join(POSTS_DIR, "demo");

/**
 * Exact-match on `"true"`, not truthiness: `NEXT_PUBLIC_DEMO_MODE=false` in a
 * `.env` file is the string `"false"`, which is truthy, and a demo-content flag
 * that turns itself on when you set it to false is a trap worth closing here.
 */
export function includeDemoPosts(): boolean {
  return process.env["NEXT_PUBLIC_DEMO_MODE"] === "true";
}

/**
 * Every directory the posts loader should read, in precedence order.
 *
 * `lib/blog/posts.ts` should read from here rather than hard-coding a single
 * directory; a slug present in both wins from the real directory, because a
 * clone's own post must always beat a demo fixture of the same name.
 */
export function postDirectories(): string[] {
  return includeDemoPosts() ? [POSTS_DIR, DEMO_DIR] : [POSTS_DIR];
}
