// Artifact identity for `keryx ctx`.
//
// Every ctx invocation writes a pair — the raw log under `data/gdctx/raw/` and
// the rendered summary under `data/gdctx/artifacts/` — and PRINTS both paths as
// `raw:` / `summary:`. Those printed lines are the only way a reader gets back
// to what the summariser dropped, so the identity naming that pair has one job:
// the pointer must lead to the evidence that was actually written.
//
// The previous identity was `new Date().toISOString()` alone. Two ctx runs that
// minted inside the same millisecond produced the SAME id, so both wrote the
// same two paths and the later writer won. Measured on this checkout with 40
// concurrent `keryx ctx run -- echo MARKER-<i>` from one project root, two of
// the forty collided, and both failures were silent:
//
//     run 18 printed:  Command: `echo MARKER-18`
//                      raw: .metaproject/data/gdctx/raw/2026-09-07T21-00-21-619Z_run.log
//     that file held:  MARKER-5
//
// Run 18 exited 0, its summary claimed a successful capture, its raw log held
// another command's output, and MARKER-18 existed nowhere on disk. That is an
// absence rendered indistinguishable from a legitimate result.
//
// Two layers fix it, and both are load-bearing:
//
//   1. A random discriminator in the id, so two runs in the same millisecond
//      almost never propose the same name in the first place.
//   2. An exclusive `wx` create of BOTH files before the id is handed out, so
//      "almost never" is not what the guarantee rests on. Only the process that
//      atomically claimed both paths may use that id; a loser of the race is
//      told (EEXIST) and retries with a fresh discriminator. Nobody's evidence
//      is overwritten, and nobody is silently dropped.
//
// If reservation cannot succeed at all it THROWS rather than falling back to an
// unreserved name — the one outcome that must never be quiet is a run that
// reports an address it does not own.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A claimed, exclusively-owned identity for one ctx artifact pair.
 *
 * Both files already exist (empty) by the time this is returned: holding a
 * reservation means no other process can take these paths.
 */
export type ArtifactReservation = {
  /** The artifact id — the basename of both files, without extension. */
  id: string;
  /** Absolute path of the raw log this run owns. */
  rawPath: string;
  /** Absolute path of the rendered summary this run owns. */
  summaryPath: string;
};

export type ReserveArtifactOptions = {
  /** Absolute directory for raw logs (`…/data/gdctx/raw`). */
  rawDir: string;
  /** Absolute directory for summaries (`…/data/gdctx/artifacts`). */
  artifactsDir: string;
  /** Artifact kind: `run`, `rg`, `read`, `diff`. */
  kind: string;
  /** Injectable clock — tests pin it to force a same-millisecond race. */
  now?: () => Date;
  /** Injectable discriminator — tests pin it to force an identical candidate. */
  token?: () => string;
  /** How many candidate names to try before giving up loudly. */
  maxAttempts?: number;
};

/** Candidates to try before refusing to guess. Eight is already absurd. */
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Pin the artifact clock to one millisecond, for tests that must GUARANTEE the
 * same-millisecond condition end-to-end.
 *
 * This exists because the alternative is a guard that cannot reliably fail.
 * Spawning concurrent `keryx ctx run` processes really does collide — that is
 * how the defect was found — but only sometimes: the moment each process mints
 * is scattered by startup and by its own post-command work, so an unassisted
 * end-to-end test detected the old naming in roughly four runs of five, and a
 * process barrier did not narrow the spread (it is dominated by work after the
 * command, not before it). Pinning the clock in the child processes removes the
 * luck without stubbing anything: real CLI, real filesystem, real concurrency,
 * real contention for one name.
 *
 * It only narrows the timestamp. The discriminator and the exclusive claim —
 * the parts actually under test — are untouched, so a pinned run exercises
 * exactly the path a natural collision takes.
 */
function pinnedClock(): (() => Date) | undefined {
  const pin = process.env.KERYX_CTX_CLOCK_PIN_MS;
  if (pin === undefined || pin === "") {
    return undefined;
  }
  const ms = Number(pin);
  // A malformed pin is ignored rather than obeyed: a bad value must not turn
  // every artifact's name into `Invalid Date`.
  return Number.isFinite(ms) && ms > 0 ? () => new Date(ms) : undefined;
}

/**
 * Six hex characters of entropy — 16.7M values inside a single millisecond.
 *
 * This is the *cheap* layer. It is not the guarantee; `reserveArtifact`'s
 * exclusive create is. Keeping it short keeps the printed pointer readable.
 */
function defaultToken(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Keep an id usable as a single path segment.
 *
 * `kind` is a fixed literal at every current call site, but an id is
 * concatenated straight into a filesystem path and echoed back to the reader,
 * so anything that is not name-safe is folded to `-` rather than trusted.
 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 40) : "artifact";
}

/**
 * One candidate id: `2026-09-07T21-00-21-619Z-a3f9c1_run`.
 *
 * The timestamp stays first so a directory listing still sorts chronologically,
 * and the `_<kind>` suffix is unchanged, so every address spelling `ctx show`
 * already accepts (bare id, filename, printed project-relative path) keeps
 * working. Only the discriminator between them is new.
 */
export function artifactIdCandidate(kind: string, at: Date, token: string): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${safeSegment(token)}_${safeSegment(kind)}`;
}

/** True for the "someone else already has this name" error from an `wx` open. */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** Create `file` only if it does not exist; false when someone beat us to it. */
async function claim(file: string): Promise<boolean> {
  try {
    await writeFile(file, "", { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Claim an artifact identity, or throw.
 *
 * Both halves of the pair are claimed together: a name is only usable if this
 * process created the raw log AND the summary exclusively. Claiming the raw log
 * but losing the summary releases the raw log again (we created it, so removing
 * it destroys nothing) and retries — otherwise a half-claim would leak an empty
 * log that a later run's reservation would have to route around.
 *
 * The id must be reserved BEFORE the summary is rendered, because a loss
 * manifest quotes its own `raw:` address inside the summary body. Reserving up
 * front is what makes that quoted address one this run provably owns.
 */
export async function reserveArtifact(
  options: ReserveArtifactOptions,
): Promise<ArtifactReservation> {
  const now = options.now ?? pinnedClock() ?? (() => new Date());
  const token = options.token ?? defaultToken;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  await mkdir(options.rawDir, { recursive: true });
  await mkdir(options.artifactsDir, { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const id = artifactIdCandidate(options.kind, now(), token());
    const rawPath = path.join(options.rawDir, `${id}.log`);
    const summaryPath = path.join(options.artifactsDir, `${id}.md`);

    if (!(await claim(rawPath))) {
      continue;
    }
    if (!(await claim(summaryPath))) {
      await rm(rawPath, { force: true });
      continue;
    }
    return { id, rawPath, summaryPath };
  }

  // Never fall through to an unreserved name. A run that cannot prove it owns
  // its address must fail out loud rather than print a pointer into someone
  // else's evidence — that is the exact failure this module exists to remove.
  throw new Error(
    `keryx ctx: could not reserve a unique artifact id under ${options.rawDir} after ${maxAttempts} attempts; refusing to overwrite another run's evidence.`,
  );
}

/**
 * Which raw log belongs to the summary currently sitting at `latest.md`?
 *
 * `latest.log` and `latest.md` are written by two separate calls, so two
 * concurrent runs can interleave and leave run A's log beside run B's summary —
 * the same "one command's output presented as another's" failure the
 * reservation removes for the durable pair, except `latest` is a shared address
 * by design and so cannot be reserved away.
 *
 * The summary knows its own answer: `writeArtifact` stamps the reserved,
 * project-relative `rawPath` into the metadata block. Following that pointer
 * makes `ctx show latest --raw` return the log belonging to the summary that
 * `ctx show latest` prints, whoever last touched `latest.log`.
 *
 * Returns undefined — never a guess — when there is no summary, no metadata
 * block, or the named log is gone. The caller then falls back to `latest.log`
 * and is no worse off than before.
 */
export async function latestRawTarget(options: {
  /** Absolute path of `…/data/gdctx/artifacts/latest.md`. */
  latestSummaryPath: string;
  /** Absolute `…/data/gdctx/raw` — the only directory a target may live in. */
  rawDir: string;
  /** Project root the metadata's `rawPath` is relative to. */
  projectRoot: string;
  /** Existence probe, injectable so this is testable in isolation. */
  exists: (candidate: string) => Promise<boolean>;
}): Promise<string | undefined> {
  let summary: string;
  try {
    summary = await readFile(options.latestSummaryPath, "utf8");
  } catch {
    return undefined;
  }

  const block = /## Metadata\s*\n+```json\n([\s\S]*?)\n```/.exec(summary);
  if (!block) {
    return undefined;
  }

  let rawPath: unknown;
  try {
    rawPath = (JSON.parse(block[1] ?? "") as { rawPath?: unknown }).rawPath;
  } catch {
    return undefined;
  }
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return undefined;
  }

  // The recorded path is written by this tool, but it is still confined: a
  // metadata block edited by hand must not turn `ctx show latest --raw` into an
  // arbitrary file read.
  const resolved = path.resolve(options.projectRoot, rawPath);
  if (path.dirname(resolved) !== path.resolve(options.rawDir)) {
    return undefined;
  }
  return (await options.exists(resolved)) ? resolved : undefined;
}
