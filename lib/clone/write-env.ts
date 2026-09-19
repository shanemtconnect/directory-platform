import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ENV_EXAMPLE = fileURLToPath(new URL("../../.env.example", import.meta.url));

export interface EnvValues {
  readonly siteUrl: string;
  /** Anything other than "production" forces noindex site-wide. */
  readonly siteEnv: string;
}

/**
 * Fills only what the answers already determine. Everything else is a secret
 * the operator pastes in, and guessing at those would hide the fact that the
 * site cannot boot until they are real.
 */
export function renderEnv(example: string, values: EnvValues): string {
  const filled: Record<string, string> = {
    NEXT_PUBLIC_SITE_URL: values.siteUrl,
    // Same URL by definition. A wrong one fails sign-in with no visible error.
    BETTER_AUTH_URL: values.siteUrl,
    SITE_ENV: values.siteEnv,
  };
  return example
    .split("\n")
    .map((line) => {
      const match = /^([A-Z0-9_]+)=\s*$/.exec(line);
      const key = match?.[1];
      if (key === undefined) return line;
      const value = filled[key];
      return value === undefined ? line : `${key}=${value}`;
    })
    .join("\n");
}

export interface WriteEnvOptions extends EnvValues {
  readonly targetDir: string;
  readonly dryRun?: boolean;
}

export interface WriteEnvResult {
  readonly path: string;
  readonly source: string;
  readonly written: boolean;
  readonly reason?: string;
}

export function writeEnv(opts: WriteEnvOptions): WriteEnvResult {
  const targetExample = join(opts.targetDir, ".env.example");
  const examplePath = existsSync(targetExample) ? targetExample : REPO_ENV_EXAMPLE;
  const source = renderEnv(readFileSync(examplePath, "utf8"), opts);
  const path = join(opts.targetDir, ".env");

  if (opts.dryRun === true) return { path, source, written: false, reason: "dry run" };

  if (existsSync(path)) {
    return {
      path,
      source,
      written: false,
      reason: `${path} already exists and was left alone — a .env holds live secrets.`,
    };
  }

  writeFileSync(path, source, "utf8");
  return { path, source, written: true };
}
