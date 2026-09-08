import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { includeDemoPosts, postDirectories, DEMO_DIR } from "./demo";

const original = process.env["NEXT_PUBLIC_DEMO_MODE"];

afterEach(() => {
  if (original === undefined) delete process.env["NEXT_PUBLIC_DEMO_MODE"];
  else process.env["NEXT_PUBLIC_DEMO_MODE"] = original;
});

describe("includeDemoPosts", () => {
  it("is on only for the exact string 'true'", () => {
    process.env["NEXT_PUBLIC_DEMO_MODE"] = "true";
    expect(includeDemoPosts()).toBe(true);

    for (const value of ["", "false", "TRUE", "1", "yes"]) {
      process.env["NEXT_PUBLIC_DEMO_MODE"] = value;
      expect(includeDemoPosts(), `"${value}" must not enable demo mode`).toBe(false);
    }
  });

  it("is off when the variable is unset", () => {
    delete process.env["NEXT_PUBLIC_DEMO_MODE"];
    expect(includeDemoPosts()).toBe(false);
  });
});

describe("postDirectories", () => {
  it("lists only the real post directory by default", () => {
    delete process.env["NEXT_PUBLIC_DEMO_MODE"];
    const dirs = postDirectories();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(path.join(process.cwd(), "content", "blog"));
  });

  it("appends the demo directory in demo mode", () => {
    process.env["NEXT_PUBLIC_DEMO_MODE"] = "true";
    const dirs = postDirectories();
    expect(dirs).toHaveLength(2);
    expect(dirs[1]).toBe(DEMO_DIR);
  });

  it("points at a directory that holds the shipped demo posts", () => {
    const files = fs.readdirSync(DEMO_DIR).filter((f) => f.endsWith(".mdx"));
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("the clone contract", () => {
  it("keeps content/blog free of posts a clone would have to delete", () => {
    const root = path.join(process.cwd(), "content", "blog");
    const strays = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".mdx"))
      .map((d) => d.name);
    expect(strays, "demo posts belong under content/blog/demo/").toEqual([]);
  });
});
