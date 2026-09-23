/**
 * The node-only half of the boot check, kept out of `instrumentation.ts`.
 *
 * Turbopack compiles `instrumentation.ts` for BOTH runtimes and statically
 * analyses the edge copy, so a literal `process.exit` in that file produced
 *
 *   Warning: A Node.js API is used (process.exit at line: 29) which is not
 *   supported in the Edge Runtime.
 *
 * on every build — even though the call sat behind `NEXT_RUNTIME === "nodejs"`
 * and could never run there. The guard satisfies the runtime; it does not
 * satisfy the analyser, which does not follow the branch. Moving the call into
 * a module reached only by a dynamic `import()` inside that branch is what
 * takes it out of the edge graph.
 *
 * Behaviour is unchanged: print the reason, exit 1.
 */
export function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}
