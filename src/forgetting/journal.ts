// Flow 242 (forgetting), lane E — AC6: "Удаление оставляет собственный след:
// что удалено, когда, по чьему запросу и на каком основании — и этот след не
// удаляется тем же вызовом, что и знание."
//
// Four requirements, and before this module the project met one and a half.
//
// The only record of a removal was the tombstone written by
// `syncSectionRegistry` (`../wiki/section-tombstone.ts`):
// `{kind, ref, page, title, removedAt, reason}`. It carries WHAT and WHEN. It
// carries no actor at all, and its `reason` is machine-generated — `page "X" is
// no longer present in Y` — which is a restatement of the observation, not a
// basis for it. `options.reason` exists in the API; the CLI (`wiki sections
// sync`, `src/commands/wiki.ts`) passes only `dryRun`, so nothing on any
// surface could supply a real one.
//
// And the record lives in `.metaproject/wiki/.sections.json`, the same file as
// the live entries, written whole by one `writeSectionRegistry` call. Lane B
// made that write REFUSE when the previous file could not be read, which closes
// the accident; the co-location itself stands, and AC6's last clause is about
// the shape, not only the accident: a trail in the file the deletion rewrites
// is a trail the deletion can rewrite.
//
// So the trail lives here instead, and the three properties that make it a
// trail are structural rather than promised:
//
//   1. SEPARATE TREE. `.metaproject/data/forgetting/journal.jsonl` is not under
//      `.metaproject/wiki/`, not under `.metaproject/memory/`, and is not any
//      retention target (`../retention/policy.ts` sweeps `data/gdctx/raw`,
//      `data/gdctx/artifacts` and workspace write-conflict sidecars — pinned by
//      `./journal.test.ts`, which fails if a future target ever covers it).
//      Deleting the knowledge, in any layer, does not reach this file.
//   2. APPEND-ONLY. Records are appended, never rewritten. There is no function
//      here that replaces the file, so no call can shorten the history — which
//      is the property `writeSectionRegistry` cannot have, since it must write
//      the whole live entry set every time.
//   3. ATTRIBUTION THAT CANNOT BE FAKED. "По чьему запросу" and "на каком
//      основании" are recorded with the BASIS on which they are known:
//      `stated` (a human said so), `derived` (the machine inferred it, and from
//      what), `unknown` (nobody said and nothing could be inferred). A derived
//      actor is never written as a stated one, and an absent one is written as
//      `unknown` rather than filled in with the git identity of whoever
//      happened to run the command — recording `aleks@example.com requested
//      this deletion` because that is the local git config is a fabricated
//      audit record, which is worse than an empty one.

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "../lib/fs";

/**
 * 2 changes what `removed` MEANS, which is why it is a version and not a silent
 * edit. In version 1 the field carried `registry.tombstones` — every removal the
 * project had ever recorded — so each record claimed its predecessors' work.
 * From 2 it carries only what the recording run itself removed, and
 * `observedUnrecorded` carries what the run saw removed and could not record.
 *
 * A v1 record is still readable and is NOT rewritten: the trail is append-only,
 * and correcting history in place is the property this file exists to deny
 * itself. The version is how a reader tells a cumulative `removed` from an
 * attributed one.
 */
export const DELETION_JOURNAL_VERSION = 2;

export function forgettingDataDir(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "forgetting");
}

export function deletionJournalPath(cwd: string): string {
  return path.join(forgettingDataDir(cwd), "journal.jsonl");
}

/**
 * How well a piece of attribution is known.
 *
 * The distinction exists because the three are not interchangeable and the
 * failure mode of this whole programme is collapsing them. A `derived` actor
 * answers "who ran the command", which is a different question from "at whose
 * request", and a reader must be able to tell which one they are holding.
 */
export type AttributionBasis = "stated" | "derived" | "unknown";

export type Attribution = {
  /** Null exactly when `basis` is "unknown". */
  value: string | null;
  basis: AttributionBasis;
  /** Where the value came from, or why there is none. Always populated. */
  detail: string;
};

export type DeletionOutcome =
  /** The removal was written into the layer that records identity. */
  | "propagated"
  /** Observed and reported; no layer was changed (the default, dry, shape). */
  | "reported-only"
  /** A layer declined to record it — see `refusals`. */
  | "refused";

export type RemovedItem = {
  layer: string;
  ref: string;
  page: string | null;
  title: string | null;
};

export type UntouchedLayer = {
  layer: string;
  /** Why this layer was not changed. Never empty. */
  cause: string;
};

export type DeletionRecord = {
  v: number;
  at: string;
  /** The command that observed the removal, e.g. "keryx sync --apply". */
  observedBy: string;
  outcome: DeletionOutcome;
  /**
   * What THIS run removed. Not what is on record — see
   * `DELETION_JOURNAL_VERSION`.
   */
  removed: RemovedItem[];
  /**
   * What this run OBSERVED as removed and did not record — the identities left
   * behind by a refusal, or by an interruption before any run wrote a tombstone.
   *
   * Kept apart from `removed` rather than merged into it with a flag, for the
   * same reason `Attribution.basis` exists: "I removed this" and "I saw this was
   * gone and could not write it down" are different claims, and a reader must
   * not have to infer which one a record is making.
   */
  observedUnrecorded: RemovedItem[];
  untouched: UntouchedLayer[];
  /** At whose request. */
  requestedBy: Attribution;
  /** On what basis. */
  grounds: Attribution;
  /** How many references into the removed knowledge were still live afterwards. */
  danglingAfter: number;
  /** Layer refusals, verbatim. Empty unless `outcome` is "refused". */
  refusals: string[];
};

export type ActorInput = {
  /** `--actor` on the command line. */
  stated?: string | undefined;
  /** Environment, for a non-interactive caller. Read as STATED: a human set it. */
  env?: string | undefined;
  /** `git config user.email` — an inference about who ran it, never who asked. */
  gitIdentity?: string | undefined;
};

/**
 * Who requested this, and how well that is known.
 *
 * The git identity is deliberately the weakest input and is never promoted:
 * it answers "whose checkout is this", and a deletion made by an autonomous
 * agent in someone's working copy would be attributed to that person as though
 * they had asked for it. That is the fabrication this function refuses to
 * commit; `./journal.test.ts` reverts the refusal and watches it go red.
 */
export function resolveRequestedBy(input: ActorInput): Attribution {
  const stated = input.stated?.trim();
  if (stated) {
    return { value: stated, basis: "stated", detail: "named on the command line (`--actor`)" };
  }
  const env = input.env?.trim();
  if (env) {
    return { value: env, basis: "stated", detail: "named in the KERYX_ACTOR environment variable" };
  }
  const git = input.gitIdentity?.trim();
  if (git) {
    return {
      value: git,
      basis: "derived",
      detail:
        `git config user.email in this checkout — this is who RAN the command, which is not necessarily who ` +
        `requested the deletion. Pass \`--actor\` to record the requester.`,
    };
  }
  return {
    value: null,
    basis: "unknown",
    detail:
      "nobody stated a requester and no git identity was readable here. This is recorded as unknown rather " +
      "than filled in: an invented requester is worse than an absent one.",
  };
}

/**
 * On what basis, and how well that is known.
 *
 * A machine-generated `reason` is a description of the observation ("the file
 * is gone"), never a justification for it. It is recorded as `derived` and says
 * so, so a reader is never shown a restated observation in the place where a
 * decision should be.
 */
export function resolveGrounds(input: { stated?: string | undefined; observed?: string | undefined }): Attribution {
  const stated = input.stated?.trim();
  if (stated) {
    return { value: stated, basis: "stated", detail: "given with the deletion (`--reason`)" };
  }
  const observed = input.observed?.trim();
  if (observed) {
    return {
      value: observed,
      basis: "derived",
      detail:
        "generated from what was observed on disk, not given by anyone. It records WHAT changed, and is not a " +
        "reason the change was wanted. Pass `--reason` to record one.",
    };
  }
  return {
    value: null,
    basis: "unknown",
    detail: "no reason was given and none could be derived from the observation.",
  };
}

export type JournalAppend =
  | { status: "appended"; path: string; record: DeletionRecord }
  | { status: "failed"; path: string; reason: string };

/**
 * Append one record. The only write in this module.
 *
 * There is no counterpart that rewrites the file, and that is the design: an
 * append cannot shorten a history, so a caller that damages this file has to do
 * it deliberately with something that is not this API. A failed append is a
 * NAMED failure — the caller must not report a deletion as recorded when its
 * record did not land.
 */
export async function appendDeletionRecord(
  cwd: string,
  record: Omit<DeletionRecord, "v">,
): Promise<JournalAppend> {
  const file = deletionJournalPath(cwd);
  const full: DeletionRecord = { v: DELETION_JOURNAL_VERSION, ...record };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(full)}\n`, "utf8");
    return { status: "appended", path: file, record: full };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      path: file,
      reason:
        `the deletion journal could not be appended to (${message}). The removal itself may still have happened — ` +
        "it is NOT recorded, and must not be reported as recorded.",
    };
  }
}

/**
 * What is on disk, in the three states a reader has to tell apart — the same
 * discipline `readSectionRegistryState` applies to the registry, for the same
 * reason: "there is no trail" and "I could not read the trail" are different
 * facts, and a reader shown an empty array for the second one concludes nothing
 * was ever deleted.
 *
 * A record that will not parse makes the whole read `unreadable` rather than
 * being dropped: a history reported as complete while missing records is the
 * defect, and here it is a pure read, so nothing is at risk except the claim.
 */
export type JournalRead =
  | { state: "absent"; path: string }
  | { state: "present"; path: string; records: DeletionRecord[] }
  | { state: "unreadable"; path: string; reason: string };

export async function readDeletionJournal(cwd: string): Promise<JournalRead> {
  const file = deletionJournalPath(cwd);
  try {
    await stat(file);
  } catch (error) {
    if (isNotFound(error)) {
      return { state: "absent", path: file };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "unreadable",
      path: file,
      reason: `the deletion journal could not be examined (${message}). This is not the same as "nothing was ever deleted".`,
    };
  }

  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "unreadable",
      path: file,
      reason:
        `the deletion journal exists but could not be read (${message}). Its records are on disk and are NOT ` +
        "absent just because this read failed.",
    };
  }

  const records: DeletionRecord[] = [];
  let damaged = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseRecord(trimmed);
    if (parsed) {
      records.push(parsed);
    } else {
      damaged += 1;
    }
  }
  if (damaged > 0) {
    return {
      state: "unreadable",
      path: file,
      reason:
        `the deletion journal holds ${damaged} line${damaged === 1 ? "" : "s"} that could not be parsed as a ` +
        "record. The readable remainder is not reported as the whole history.",
    };
  }
  return { state: "present", path: file, records };
}

function parseRecord(line: string): DeletionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["at"] !== "string" || typeof raw["observedBy"] !== "string") {
    return null;
  }
  return raw as unknown as DeletionRecord;
}
