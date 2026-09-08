import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_NAMESPACE,
  DEV_BUILD_ID,
  normalizeBuildId,
  selectBuildId,
  cacheKeyPrefix,
  buildIdFromKey,
  resolveCacheKeyPrefix,
} from "@/lib/cache/build-id.mjs";

describe("normalizeBuildId", () => {
  it("accepts a real Next build id", () => {
    expect(normalizeBuildId("8dhlIRUNLtpabNXf4Ajbu")).toBe("8dhlIRUNLtpabNXf4Ajbu");
  });

  it("trims the trailing newline `.next/BUILD_ID` may or may not carry", () => {
    expect(normalizeBuildId("  8dhlIRUNLtpabNXf4Ajbu\n")).toBe("8dhlIRUNLtpabNXf4Ajbu");
  });

  it("accepts the hyphens and underscores nanoid emits", () => {
    expect(normalizeBuildId("a-b_c")).toBe("a-b_c");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   \n"],
    // A colon would forge a second namespace segment, so `nextjs:a:b:/x` could
    // be read as belonging to build `a` — and purge-cache.sh would keep it.
    ["a colon", "a:b"],
    // These would turn a purge pattern into a wildcard that matches other
    // builds' keys, or a bracket expression redis-cli reads as a glob class.
    ["a glob star", "a*"],
    ["a glob question mark", "a?b"],
    ["a glob bracket", "a[b]"],
    ["a space", "a b"],
    ["a slash", "a/b"],
    ["a newline in the middle", "a\nb"],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeBuildId(raw)).toBeNull();
  });

  it("rejects an implausibly long id rather than key a cache on it", () => {
    expect(normalizeBuildId("a".repeat(129))).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeBuildId(null)).toBeNull();
    expect(normalizeBuildId(undefined)).toBeNull();
    expect(normalizeBuildId(42)).toBeNull();
  });
});

describe("selectBuildId", () => {
  it("prefers .next/BUILD_ID over the environment", () => {
    expect(selectBuildId({ fileContents: "fromfile", envBuildId: "fromenv" })).toBe("fromfile");
  });

  it("falls back to NEXT_BUILD_ID when the file is absent", () => {
    expect(selectBuildId({ fileContents: null, envBuildId: "fromenv" })).toBe("fromenv");
  });

  it("falls back to the environment when the file is unreadable garbage", () => {
    expect(selectBuildId({ fileContents: "not a build id!", envBuildId: "fromenv" })).toBe("fromenv");
  });

  it("falls back to dev when neither is usable", () => {
    expect(selectBuildId({ fileContents: null, envBuildId: undefined })).toBe(DEV_BUILD_ID);
    expect(selectBuildId({})).toBe("dev");
  });
});

describe("cacheKeyPrefix", () => {
  it("namespaces by build id with a trailing separator", () => {
    expect(cacheKeyPrefix("abc")).toBe("nextjs:abc:");
    expect(CACHE_NAMESPACE).toBe("nextjs");
  });

  it("round-trips through buildIdFromKey", () => {
    const key = `${cacheKeyPrefix("abc")}/manchester`;
    expect(buildIdFromKey(key)).toBe("abc");
  });

  it("reads no build id out of a pre-namespacing key", () => {
    // What every key looked like before this change: `nextjs:/manchester`.
    expect(buildIdFromKey("nextjs:/manchester")).toBeNull();
    expect(buildIdFromKey("nextjs:__sharedTags__")).toBeNull();
    expect(buildIdFromKey("other:abc:/x")).toBeNull();
  });

  it("refuses to build a prefix from an invalid id", () => {
    expect(() => cacheKeyPrefix("a:b")).toThrow(/build id/i);
  });
});

describe("resolveCacheKeyPrefix", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "build-id-"));
    dirs.push(d);
    return d;
  };
  const cleanup = () => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));

  it("reads .next/BUILD_ID relative to cwd", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, ".next"));
    writeFileSync(join(cwd, ".next", "BUILD_ID"), "8dhlIRUNLtpabNXf4Ajbu\n");
    expect(resolveCacheKeyPrefix({ cwd, env: {} })).toBe("nextjs:8dhlIRUNLtpabNXf4Ajbu:");
    cleanup();
  });

  it("uses NEXT_BUILD_ID when there is no build output under cwd", () => {
    const cwd = scratch();
    expect(resolveCacheKeyPrefix({ cwd, env: { NEXT_BUILD_ID: "envbuild" } })).toBe("nextjs:envbuild:");
    cleanup();
  });

  it("never throws its way out of a cache handler — it lands on dev", () => {
    const cwd = scratch();
    // A directory where the file should be: readFileSync throws EISDIR.
    mkdirSync(join(cwd, ".next", "BUILD_ID"), { recursive: true });
    expect(resolveCacheKeyPrefix({ cwd, env: {} })).toBe("nextjs:dev:");
    cleanup();
  });
});
