import type { Db } from "./client";

/**
 * The production handle type under the name the query/action modules and the
 * test helpers share.
 *
 * `Db` and the test transaction used to be two structurally different types,
 * which is why every call site once wrote `db as never`. One alias means the
 * real `db` and a `withTestDb` transaction are interchangeable and the casts
 * go away.
 *
 * It lives here, not in test/db.ts, so production modules never import from
 * the test harness: `import type` still has to resolve the module, and
 * `next build` type-checks the whole program inside the Docker image, where
 * test/ is not guaranteed to exist. test/db.ts re-exports this same alias.
 */
export type TestDb = Db;
