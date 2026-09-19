import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  QUESTIONS,
  answerTypeError,
  buildAnswers,
  coerceRaw,
  isAsked,
  resolveDefault,
  runValidate,
  type Answers,
  type PartialAnswers,
  type Question,
} from "@/lib/clone/questions";
import { writeSiteConfig } from "@/lib/clone/write-config";
import { scaffoldSeed } from "@/lib/clone/scaffold-seed";
import { writeEnv } from "@/lib/clone/write-env";

/**
 * The clone wizard.
 *
 *   corepack pnpm new-site
 *   corepack pnpm new-site --answers answers.json --dry-run
 *
 * Answer the questions and the directory is configured: config/site.config.ts,
 * the seed CSVs, and a .env with everything the answers already determine. The
 * answers file is the whole input, so a run is reproducible and reviewable.
 */

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface CliOptions {
  readonly answersPath?: string;
  readonly targetDir: string;
  readonly siteEnv: string;
  readonly dryRun: boolean;
  readonly keepDemo: boolean;
  readonly allowPlaceholders: boolean;
  readonly overwrite: boolean;
  readonly help: boolean;
}

const USAGE = `Usage: corepack pnpm new-site [options]

  --answers <file>       Answer non-interactively from a JSON file.
  --target <dir>         Where to write. Defaults to the current directory.
  --site-env <value>     SITE_ENV for the generated .env. Default "staging",
                         which forces noindex until you are ready to be found.
  --dry-run              Print what would be written; write nothing.
  --keep-demo            Keep the template's demo blog posts.
  --allow-placeholders   Accept legalEntity "TBC". A production build will not.
  --overwrite            Replace an existing config and seed CSVs.
  --help                 This.`;

const VALUE_FLAGS = new Set(["--answers", "--target", "--site-env"]);
const BOOL_FLAGS = new Set([
  "--dry-run",
  "--keep-demo",
  "--allow-placeholders",
  "--overwrite",
  "--help",
]);

export function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`${arg} needs a value.\n\n${USAGE}`);
      }
      values.set(arg, value);
      i++;
    } else if (BOOL_FLAGS.has(arg)) {
      flags.add(arg);
    } else {
      throw new CliError(`Unknown option "${arg}".\n\n${USAGE}`);
    }
  }

  const answersPath = values.get("--answers");
  return {
    ...(answersPath === undefined ? {} : { answersPath }),
    targetDir: values.get("--target") ?? process.cwd(),
    siteEnv: values.get("--site-env") ?? "staging",
    dryRun: flags.has("--dry-run"),
    keepDemo: flags.has("--keep-demo"),
    allowPlaceholders: flags.has("--allow-placeholders"),
    overwrite: flags.has("--overwrite"),
    help: flags.has("--help"),
  };
}

export interface NextStepsInput {
  readonly niche: string;
  readonly allowedPlaceholders: boolean;
}

/** The exact commands, in the only order that works. */
export function nextSteps(input: NextStepsInput): readonly string[] {
  const steps = [
    "Next:",
    "  1. Fill the secrets in .env — DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET,",
    "     PayPal, Resend, R2, Turnstile and MapTiler. validateEnv refuses to boot without them.",
    "  2. corepack pnpm db:up",
    "  3. DATABASE_URL=postgres://directory:directory@localhost:5433/directory_dev \\",
    "       corepack pnpm db:migrate",
    `  4. corepack pnpm seed ${input.niche}`,
    "  5. corepack pnpm dev",
    "",
    "Before you go live:",
    "  - Edit seeds/ and re-seed with real towns, categories and listings.",
    "  - A town page stays noindex until it clears seo.minListingsToIndex and has intro copy.",
    "  - SITE_ENV is \"staging\", which forces noindex site-wide. Set it to \"production\"",
    "    only when the content is real.",
    "  - Read docs/CLONING.md for the deploy, DNS and legal checklist.",
  ];
  if (input.allowedPlaceholders) {
    steps.push(
      "",
      "  ! legalEntity is still \"TBC\". A production build refuses it, and the terms,",
      "    privacy and invoice pages all name it. Set it before you deploy.",
    );
  }
  return steps;
}

// --- interactive ------------------------------------------------------------

interface Io {
  readonly out: (line: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
}

function describe(question: Question, fallback: unknown): string[] {
  const lines = [question.prompt];
  if (question.help !== undefined) lines.push(`  ${question.help}`);
  if (question.type === "choice") {
    lines.push(`  one of: ${question.choices.join(", ")}${question.allowOther === true ? ", or anything else" : ""}`);
  }
  if (question.type === "list") lines.push(`  format: ${question.itemHint} (blank line to finish)`);
  if (question.type !== "list" && fallback !== undefined && fallback !== "") {
    lines.push(`  default: ${fallback === null ? "unlimited" : String(fallback)}`);
  }
  return lines;
}

async function askList(question: Question, io: Io): Promise<unknown[] | undefined> {
  if (question.type !== "list") throw new Error("not a list question");
  const items: unknown[] = [];
  for (;;) {
    const line = (await io.ask("  > ")).trim();
    if (line.length === 0) break;
    items.push(question.parseItem(line));
  }
  return items.length === 0 ? undefined : items;
}

function setAnswer(answers: PartialAnswers, key: string, value: unknown): void {
  (answers as Record<string, unknown>)[key] = value;
}

async function askEverything(io: Io): Promise<Record<string, unknown>> {
  const supplied: Record<string, unknown> = {};
  const acc: PartialAnswers = {};

  for (const question of QUESTIONS) {
    if (!isAsked(question, acc)) continue;
    const fallback = resolveDefault(question, acc);

    for (;;) {
      io.out("");
      for (const line of describe(question, fallback)) io.out(line);

      const answered =
        question.type === "list"
          ? await askList(question, io)
          : await (async () => {
              const line = await io.ask("  > ");
              return line.trim().length === 0 ? undefined : coerceRaw(question, line);
            })();

      const value = answered === undefined ? fallback : answered;
      const typeProblem = answerTypeError(question, value);
      if (typeProblem !== null) {
        io.out(`  ✗ ${typeProblem}`);
        continue;
      }
      const problem = runValidate(question, value, acc);
      if (problem !== null) {
        io.out(`  ✗ ${problem}`);
        continue;
      }
      if (answered !== undefined) supplied[question.key] = value;
      setAnswer(acc, question.key, value);
      break;
    }
  }
  return supplied;
}

// --- the run ----------------------------------------------------------------

function readAnswersFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new CliError(`No answers file at ${path}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${path} must contain a JSON object of answers.`);
  }
  return parsed as Record<string, unknown>;
}

/** The template ships demo posts so the content hub is not an empty shell. They are not yours. */
function clearDemoContent(targetDir: string, out: (line: string) => void): void {
  const demo = join(targetDir, "content", "blog", "demo");
  if (existsSync(demo)) {
    rmSync(demo, { recursive: true, force: true });
    out(`  removed ${demo}`);
    return;
  }
  const blog = join(targetDir, "content", "blog");
  const leftovers = existsSync(blog)
    ? readdirSync(blog).filter((f) => f.endsWith(".mdx") || f.endsWith(".md"))
    : [];
  if (leftovers.length > 0) {
    out(
      `  note: ${blog} still holds ${leftovers.length} post(s) from the template ` +
        `(${leftovers.join(", ")}). Replace or delete them — they are about someone else's niche.`,
    );
  }
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) {
    io.out(USAGE);
    return 0;
  }

  const supplied =
    opts.answersPath === undefined
      ? await askEverything(io)
      : readAnswersFile(opts.answersPath);

  const built = buildAnswers(supplied);
  if ("errors" in built) {
    throw new CliError(`These answers cannot be used:\n  - ${built.errors.join("\n  - ")}`);
  }
  const answers: Answers = built.answers;

  // Everything is checked before anything is written: a half-configured clone
  // is harder to recover from than one that refused to start.
  scaffoldSeed(answers, { targetDir: opts.targetDir, dryRun: true });
  const preview = writeSiteConfig(answers, {
    targetDir: opts.targetDir,
    dryRun: true,
    allowPlaceholders: opts.allowPlaceholders,
  });

  if (opts.dryRun) {
    io.out(preview.source);
    io.out(`\n(dry run — nothing was written to ${opts.targetDir})`);
    return 0;
  }

  const config = writeSiteConfig(answers, {
    targetDir: opts.targetDir,
    overwrite: opts.overwrite,
    allowPlaceholders: opts.allowPlaceholders,
  });
  io.out(`  wrote ${config.path}`);

  const seed = scaffoldSeed(answers, { targetDir: opts.targetDir, overwrite: opts.overwrite });
  for (const file of seed.files) io.out(`  wrote ${file.path} (${file.rows} rows, ${file.source})`);
  for (const warning of seed.warnings) io.out(`  ! ${warning}`);

  const env = writeEnv({
    targetDir: opts.targetDir,
    siteUrl: `https://${answers.domain}`,
    siteEnv: opts.siteEnv,
  });
  io.out(env.written ? `  wrote ${env.path}` : `  skipped .env — ${env.reason ?? "unchanged"}`);

  if (!opts.keepDemo) clearDemoContent(opts.targetDir, io.out);

  io.out("");
  for (const line of nextSteps({
    niche: answers.niche,
    allowedPlaceholders: opts.allowPlaceholders,
  })) {
    io.out(line);
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const interactive = !argv.includes("--answers") && !argv.includes("--help");
  if (interactive && !process.stdin.isTTY) {
    process.stderr.write(
      "new-site needs a terminal to ask questions. Use --answers <file> instead.\n",
    );
    process.exitCode = 1;
    return;
  }

  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const io: Io = {
    out: (line) => process.stdout.write(`${line}\n`),
    ask: async (prompt) => (rl === undefined ? "" : rl.question(prompt)),
  };

  try {
    process.exitCode = await run(argv, io);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
