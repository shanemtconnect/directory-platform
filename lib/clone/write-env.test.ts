import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEnv, writeEnv } from "./write-env";

const EXAMPLE = [
  "# --- Required at build ---",
  "NEXT_PUBLIC_SITE_URL=",
  "",
  "DATABASE_URL=",
  "BETTER_AUTH_URL=",
  "",
  "# Staging: set to \"staging\" to force noindex on everything.",
  "SITE_ENV=",
  "",
].join("\n");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clone-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("renderEnv", () => {
  it("fills the keys it knows and leaves the rest for the operator", () => {
    const out = renderEnv(EXAMPLE, { siteUrl: "https://x.test", siteEnv: "staging" });
    expect(out).toContain("NEXT_PUBLIC_SITE_URL=https://x.test");
    expect(out).toContain("SITE_ENV=staging");
    expect(out).toContain("DATABASE_URL=");
    expect(out).not.toContain("DATABASE_URL=http");
  });

  it("fills BETTER_AUTH_URL too, because it is the site URL and a wrong one breaks sign-in quietly", () => {
    expect(renderEnv(EXAMPLE, { siteUrl: "https://x.test", siteEnv: "staging" }))
      .toContain("BETTER_AUTH_URL=https://x.test");
  });

  it("keeps the comments and the ordering of the example", () => {
    const out = renderEnv(EXAMPLE, { siteUrl: "https://x.test", siteEnv: "staging" });
    expect(out.split("\n")[0]).toBe("# --- Required at build ---");
    expect(out).toContain("# Staging: set to");
  });

  it("does not touch a key that already carries a value", () => {
    const out = renderEnv("SITE_ENV=production\n", { siteUrl: "https://x.test", siteEnv: "staging" });
    expect(out).toContain("SITE_ENV=production");
  });
});

describe("writeEnv", () => {
  it("writes .env beside the example it was built from", () => {
    writeFileSync(join(dir, ".env.example"), EXAMPLE);
    const result = writeEnv({ targetDir: dir, siteUrl: "https://x.test", siteEnv: "staging" });
    expect(result.written).toBe(true);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("NEXT_PUBLIC_SITE_URL=https://x.test");
  });

  it("never overwrites an existing .env — those hold real secrets", () => {
    writeFileSync(join(dir, ".env.example"), EXAMPLE);
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://real\n");
    const result = writeEnv({ targetDir: dir, siteUrl: "https://x.test", siteEnv: "staging" });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/already/);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("postgres://real");
  });

  it("writes nothing in dry-run mode", () => {
    writeFileSync(join(dir, ".env.example"), EXAMPLE);
    const result = writeEnv({ targetDir: dir, siteUrl: "https://x.test", siteEnv: "staging", dryRun: true });
    expect(result.written).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(result.source).toContain("NEXT_PUBLIC_SITE_URL=https://x.test");
  });

  it("falls back to this repo's .env.example when the target has none", () => {
    const result = writeEnv({ targetDir: dir, siteUrl: "https://x.test", siteEnv: "staging" });
    expect(result.written).toBe(true);
    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(written).toContain("NEXT_PUBLIC_SITE_URL=https://x.test");
    expect(written).toContain("PAYPAL_CLIENT_ID=");
  });
});
