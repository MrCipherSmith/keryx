// `keryx learn promote` (W3 spec "Promotion rule" + "Cross-project evidence";
// plan module table; flow 312 T10). A `scope: "project"`, `status: "accepted"`
// record is eligible when `~/.keryx/learning/index.json` has entries for the
// same `id` from `>=2` distinct `project.identity` values, each at (indexed,
// accept-time) `confidence >= 0.8` — never the source record's live
// confidence (that is the whole point of the index: `accept.ts` snapshots it,
// `accept --refresh` is the only way to move it forward). Requires interactive
// confirmation (no bypass flag — same D2 rule `accept.ts` enforces) and, on
// confirmation, writes a new `scope: "user"`, `status: "candidate"` record
// under `~/.keryx/learning/patterns/` — never `"accepted"`; promotion
// re-enters Review/Consent at the new scope.
import { spawnSync } from "node:child_process";
import { appendDecision } from "./decisions";
import { scanLearnedText } from "./scan";
import { createPattern, readIndex, readPattern, type StoreEnvOptions } from "./store";
import type { LearnedPattern } from "./types";

export class LearningPromoteError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningPromoteError";
  }
}

export interface PromotePatternOptions {
  /** No bypass flag exists for this command (W3 spec "Promotion rule" #2) — refuses outright without a terminal. */
  isTerminal: boolean;
  /** Typed confirmation (e.g. "type the pattern id to confirm"), read by the CLI layer. */
  confirm: () => Promise<boolean>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface PromoteResult {
  id: string;
  scope: "user";
  status: "candidate";
}

const GIT_SPAWN_TIMEOUT_MS = 2000;
const PROMOTE_TTL_DAYS = 30;
const INDEXED_CONFIDENCE_THRESHOLD = 0.8;
const MIN_DISTINCT_IDENTITIES = 2;

/**
 * Best-effort `git config user.email` in `root`. Never throws. Duplicated
 * from `accept.ts` rather than imported/shared — `accept.ts` does not export
 * it, and this is a two-line pure lookup, not worth a cross-file dependency
 * inside the same feature module (same reasoning `paths.ts`'s own header
 * gives for duplicating `resolveHookHomeDir`).
 */
function tryGitUserEmail(root: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", root, "config", "user.email"], {
      timeout: GIT_SPAWN_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const email = result.stdout.trim();
      return email.length > 0 ? email : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveActor(root: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.KERYX_ACTOR?.trim();
  if (fromEnv) return fromEnv;
  return tryGitUserEmail(root) ?? "unknown";
}

function storeOptionsOf(opts: { env?: NodeJS.ProcessEnv; homeDir?: string }): StoreEnvOptions {
  return {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
}

/**
 * `status: candidate` (project, accepted) -> `status: candidate` (user, new
 * record). See module header. Throws `LearningPromoteError` for every
 * refusal, with a named `reason`:
 *  - `promote-requires-terminal` — checked FIRST, before any read.
 *  - `learning-record-not-found` — no project-scope record for `id`.
 *  - `learning-not-accepted` — the project-scope record is not `status: accepted`.
 *  - `insufficient-project-identities` — fewer than 2 distinct indexed
 *    `project.identity` entries at (indexed) `confidence >= 0.8`.
 *  - `learning-text-refused` — the security scan found something in
 *    `trigger`/`action`.
 *  - `already-promoted` — a `scope: user` record for `id` already exists at
 *    `status: candidate` or `status: accepted`.
 *  - `promote-cancelled` — `confirm()` resolved `false`. Writes nothing.
 */
export async function promotePattern(root: string, id: string, opts: PromotePatternOptions): Promise<PromoteResult> {
  if (!opts.isTerminal) {
    throw new LearningPromoteError(
      "promote-requires-terminal",
      "keryx learn promote needs an interactive terminal; there is no bypass flag or environment variable.",
    );
  }

  const env = opts.env ?? process.env;
  const storeOptions = storeOptionsOf(opts);

  const record = await readPattern(root, id, "project", storeOptions);
  if (record === undefined) {
    throw new LearningPromoteError("learning-record-not-found", `no project-scope learned-pattern record "${id}"`);
  }
  if (record.status !== "accepted") {
    throw new LearningPromoteError(
      "learning-not-accepted",
      `record "${id}" (project) is status "${record.status}", not "accepted"; only an accepted record can be promoted`,
    );
  }

  const index = await readIndex(storeOptions);
  const entries = index[id] ?? [];
  const distinctIdentities = new Set(
    entries.filter((entry) => entry.confidence >= INDEXED_CONFIDENCE_THRESHOLD).map((entry) => entry.projectIdentity),
  );
  if (distinctIdentities.size < MIN_DISTINCT_IDENTITIES) {
    throw new LearningPromoteError(
      "insufficient-project-identities",
      `only ${distinctIdentities.size} distinct project identity at confidence >= ${INDEXED_CONFIDENCE_THRESHOLD}; promotion requires >= ${MIN_DISTINCT_IDENTITIES}`,
    );
  }

  const scan = await scanLearnedText(root, [record.trigger, record.action]);
  if (scan.findings.length > 0) {
    throw new LearningPromoteError("learning-text-refused", `record "${id}" refused by the security scan: ${scan.findings.join(", ")}`);
  }

  const existingUser = await readPattern(root, id, "user", storeOptions);
  if (existingUser !== undefined && (existingUser.status === "candidate" || existingUser.status === "accepted")) {
    throw new LearningPromoteError(
      "already-promoted",
      `a scope:"user" record "${id}" already exists at status "${existingUser.status}"`,
    );
  }

  const confirmed = await opts.confirm();
  if (!confirmed) {
    throw new LearningPromoteError("promote-cancelled", "promotion cancelled: confirmation did not match. Nothing was written.");
  }

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + PROMOTE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const promoted: LearnedPattern = {
    ...record,
    scope: "user",
    status: "candidate",
    supersededBy: null,
    graduation: null,
    ttl: { expiresAt },
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // `status: "candidate"` — never "accepted" — so this write needs no accept
  // capability. R1-F1/R1-F7: through the choke point (`createPattern`, under
  // the user-scope lock) — it re-checks, under the lock, that nothing
  // ACTIVE has landed at this id+scope since the `existingUser` read above
  // (the `already-promoted` check), refusing rather than silently
  // overwriting a candidate/accepted record a concurrent promote/accept
  // wrote in between; it still asserts the target lies inside the
  // user-scope learning root, same as the old direct write did.
  await createPattern(root, promoted, { ...storeOptions, replaceableStatuses: ["rejected", "expired", "superseded"] });

  const actor = resolveActor(root, env);
  await appendDecision(root, { action: "promote", id, actor, tty: true, at: nowIso }, { ...storeOptions, scope: "project" });

  return { id, scope: "user", status: "candidate" };
}
