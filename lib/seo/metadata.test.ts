import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

const APP_DIR = path.join(process.cwd(), "app");

/**
 * Every `app/**` file that exports a plain, statically-known `metadata`
 * object — as opposed to a `generateMetadata` function, whose title depends
 * on request data we cannot evaluate here.
 */
function findStaticMetadataFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findStaticMetadataFiles(full));
      continue;
    }
    // Only leaf pages: the root layout legitimately sets `title.default` to
    // the site name and a `%s | ${name}` template — that IS the site name,
    // declared once, not a page repeating it back into itself.
    if (!/^page\.tsx?$/.test(entry.name)) continue;
    const source = fs.readFileSync(full, "utf8");
    if (/export\s+const\s+metadata\s*[:=]/.test(source)) out.push(full);
  }
  return out;
}

/** `app/foo/bar/page.tsx` -> `@/app/foo/bar/page`, importable via the vitest alias. */
function toImportSpecifier(file: string): string {
  return `@/${path.relative(process.cwd(), file).replace(/\.tsx?$/, "")}`;
}

beforeAll(() => {
  // Importing a page module pulls in lib/db/client.ts (throws without a
  // DATABASE_URL) and lib/auth/server.ts (warns without a secret). Neither
  // is ever queried just by importing the module for its `metadata` export,
  // so a placeholder value that satisfies the presence check is enough.
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use";
});

/**
 * Regression guard for the "Advertise on Which Wedding Venue | Which Wedding
 * Venue" bug: the root layout's title template already appends
 * ` | ${siteConfig.name}`, so a page-level title that also spells out the
 * site name renders it twice. `{ absolute: ... }` is the one legitimate
 * exception — it opts out of the template entirely, so repeating the name
 * there (the homepage) is a deliberate, singular choice, not a mistake.
 */
describe("static page titles never duplicate the site name", () => {
  const files = findStaticMetadataFiles(APP_DIR);

  it("found app/ files with a static metadata export to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);

    it(`${rel} does not repeat "${siteConfig.name}" in its title`, async () => {
      const mod = (await import(/* @vite-ignore */ toImportSpecifier(file))) as {
        metadata?: Metadata;
      };
      const title = mod.metadata?.title;

      // No title at all: the page inherits the layout's default/template.
      if (title === undefined || title === null) return;

      // `{ absolute: ... }` bypasses the template deliberately.
      if (typeof title === "object" && "absolute" in title) return;

      expect(typeof title).toBe("string");
      expect(title as string).not.toContain(siteConfig.name);
    });
  }
});
