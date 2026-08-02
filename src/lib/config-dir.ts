// The one user-global keryx config directory resolver.
//
// This function existed twice, byte-identical, in `shell-config.ts` (flow 081)
// and `project-registry.ts` (flow 127). `keryx serve` needs the same directory
// for `serve.json` and the credential store, and a third copy is how the three
// eventually disagree about where `auth.json` lives. So it is extracted here and
// both originals import it.
//
// Files resolved through THIS function:
//
//   auth.json               provider/model selection + API keys (0600)
//   projects.json           the user-global project registry (flow 127)
//   serve.json              the `keryx serve` configuration (flow 128)
//   serve-credentials.json  salted bearer-token hash (0600, flow 128)
//   permissions.json        shell-command auto-approval allowlist
//   sandbox.json            global sandbox defaults
//   turns/                  durable remote-turn records (flow 131 / R4c) — the
//                           event log and terminal result each remote turn is
//                           streamed and replayed from, plus the idempotency
//                           index. Written through `writeOwnerOnlyFile` and
//                           `appendOwnerOnlyLine`, read through `readConfigFile`
//   sessions/               per-project interactive session store — created by
//                           `src/session/store.ts`, which calls this helper
//                           because with KERYX_DATA_DIR unset its root IS this
//                           directory. Its summaries read through
//                           `readConfigFile` and its transcripts through
//                           `readTranscriptFile`; until flow 130 both were raw
//                           `readFileSync` calls, so this entry named the path
//                           while the read had no bound at all.
//
// NOT resolved through this function, stated rather than glossed over:
// `src/session/paths.ts` has its own `keryxDataDir()`, which applies the same
// platform rules but ALSO honours a `KERYX_DATA_DIR` override. With that
// variable set the two disagree, and `sessions/` moves while `auth.json` does
// not. That divergence predates this flow and is left alone deliberately:
// teaching this resolver about `KERYX_DATA_DIR` would relocate the `auth.json`
// of any existing install that sets it, which is a migration, not a cleanup.
// It is recorded here so the next person finds it rather than discovering it.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The per-user config directory for keryx, cross-platform:
 *   - Windows: `%APPDATA%\keryx` (or `~/AppData/Roaming/keryx`).
 *   - Linux/BSD: `$XDG_DATA_HOME/keryx` (or `~/.local/share/keryx`).
 *   - macOS: `~/.local/share/keryx` (as opencode/most CLIs use on Unix).
 *
 * `dir`, when given, is returned unchanged. It is the test seam every caller in
 * this codebase threads through, so a test never touches the developer's real
 * configuration.
 */
export function keryxConfigDir(dir?: string): string {
  if (dir !== undefined) {
    return dir;
  }
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const base = appData !== undefined && appData.length > 0 ? appData : path.join(home, "AppData", "Roaming");
    return path.join(base, "keryx");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, ".local", "share");
  return path.join(base, "keryx");
}

/**
 * The largest a user-global config file may be before it is refused unread.
 *
 * Every file in this directory is a few hundred bytes of JSON. A review pointed
 * one of them at a 3 GiB sparse file and `keryx serve status` died with SIGABRT
 * and NOTHING on stdout or stderr — Bun aborts rather than throwing, so a
 * `try/catch` around `readFileSync` does not help and four module headers
 * promising "never throws" were wrong.
 *
 * The first fix bounded `serve.json` alone. The other five readers of this
 * directory — `auth.json`, `projects.json`, `permissions.json`, `sandbox.json`
 * and the credential store — still aborted, on the same two commands. That is
 * the third time on that branch that a fix covered the site a finding named
 * rather than the class, so the bound lives here.
 *
 * A fourth round then found that "every reader uses it", as this comment used
 * to end, was false: `session/store.ts` read two files under this directory
 * with a raw `readFileSync` and appeared in no list. It is true now, and it is
 * held true by the source-level guard in `config-dir.readers.test.ts` rather
 * than by this sentence.
 */
export const MAX_CONFIG_FILE_BYTES = 1_000_000;

/**
 * The largest an append-only CONTENT file under this directory may be.
 *
 * One value, two named readers over it. See `MAX_TURN_FILE_BYTES` for why the
 * split that carries information is config-versus-content and not one constant
 * per filename.
 *
 * 64 MiB is far above any observed transcript or event log and far below the
 * size at which the read aborts, which is the whole job of this number.
 */
export const MAX_CONTENT_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The largest a session transcript may be before it is refused unread.
 *
 * Separate from `MAX_CONFIG_FILE_BYTES`, and not simply a larger value for it.
 * The config bound is 1 MB because every file it governs is a few hundred bytes
 * of JSON; raising that number to fit a transcript would loosen the bound on
 * `auth.json` and the credential store for no reason. `context.jsonl` and
 * `archive.jsonl` are append-only logs of a real conversation and legitimately
 * run to megabytes, so routing them through the config bound would have turned
 * "an oversized file aborts the process" into "a long session cannot be
 * resumed" — a regression dressed as a fix.
 *
 * 64 MiB is far above any observed transcript and far below the size at which
 * the read aborts, which is the whole job of this number.
 */
export const MAX_TRANSCRIPT_FILE_BYTES = MAX_CONTENT_FILE_BYTES;

/**
 * The largest a durable TURN file may be before it is refused unread.
 *
 * The same number and the same reason as a transcript, and that is the point
 * rather than a coincidence: there are two CLASSES of file under this
 * directory, not three. A config document is a few hundred bytes of fixed shape.
 * Everything else here is an append-only log of content —
 * `context.jsonl`, `archive.jsonl`, `turns/<id>/events.jsonl` — or a document
 * carrying such content, like `turn.json` with the assistant's `result.text`.
 *
 * So `MAX_CONTENT_FILE_BYTES` is the value and the two names are the call
 * sites' vocabulary: a reader says which class of file it is reading, which is
 * what the readers guard's numerator is derived from. Two named readers over
 * one bound, rather than two constants that must be kept equal by hand — the
 * previous version was two identical numbers with two identical rationales and
 * two byte-identical bodies, and a fourth file class would have had a precedent
 * ("add a constant and a reader per filename") instead of a principle.
 *
 * Why the turn store needed it at all: both files were read through
 * `readConfigFile`, whose bound is 1 MB, while `MAX_TURN_EVENTS` is 10 000 —
 * and 10 000 events serialise to 1 418 890 bytes with no `text` field at all,
 * or 1 518 890 with an empty one. Both are over the 1 MB bound, which is the
 * point; an earlier version of this note gave the second figure and labelled it
 * the first, so one quantity had two numbers. Measured on the real failing
 * shape: 8 000 events gave 1 302 890 bytes and the read then returned ZERO, so
 * past roughly 6 500 events the event route answered 200 with an empty body.
 * §Bounds forbids exactly that, and the store's own header said it could not
 * happen.
 *
 * STATED LIMIT: this is a bound on the FILE, enforced on read, and
 * `MAX_TURN_EVENTS` is a bound on the COUNT, enforced on write. Nothing connects
 * them. Ten thousand bare events are 1 418 890 bytes (1.353 MiB), leaving
 * (64 MiB - 1 418 890) / 10 000 = 6 569 bytes of text per event before the
 * reader refuses — derived from the bare figure, which is why that is the one
 * this paragraph uses. There is no per-event byte bound. In
 * practice the provider's own output ceiling holds it down — 10 000 real deltas
 * measured at 1.5 MiB, a 42x margin — but that is a property keryx neither
 * states nor enforces, and on the OpenAI-compatible path `maxOutputTokens` is
 * dropped rather than sent. Recorded here because the next person to raise
 * `MAX_TURN_EVENTS` needs to know the two numbers are in different units.
 */
export const MAX_TURN_FILE_BYTES = MAX_CONTENT_FILE_BYTES;

/** Why a file could not be read. */
export type ConfigReadFailure = "absent" | "not-regular" | "too-large" | "unreadable";

export type ConfigReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: ConfigReadFailure };

/**
 * Read a file under the shared directory, refusing one that is not a regular
 * file or is larger than `maxBytes`.
 *
 * Both checks run on the `statSync` BEFORE the read, because neither failure
 * can be caught afterwards:
 *
 *   too large    the abort happens inside `readFileSync`; Bun aborts rather
 *                than throwing, so `try/catch` never runs.
 *   not regular  a FIFO stats as size 0, passes any size bound, and then
 *                `readFileSync` BLOCKS FOREVER waiting for a writer. A review
 *                replaced `serve.json` with a FIFO and `keryx serve status`
 *                produced no output, no refusal and no timeout. A hang is not
 *                a safer failure than an abort, only a less legible one — so
 *                the requirement is `isFile()`, stated as the class rather
 *                than as a list of the device types known to hang.
 */
function readBoundedFile(file: string, maxBytes: number): ConfigReadResult {
  let stats: Stats;
  try {
    stats = statSync(file);
  } catch {
    // Absent, a dangling symlink, or a path we cannot stat. The caller's
    // existing "nothing configured" branch is the right answer for all three.
    return { ok: false, reason: "absent" };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "not-regular" };
  }
  if (stats.size > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Read a user-global config file, refusing one too large to be a config.
 *
 * Every reader of this directory must go through here or through
 * `readTranscriptFile`. Two guards hold that: `config-dir.readers.test.ts`
 * scans the source for a raw read beside a config-path resolver, and the same
 * file drives every reader against an oversized file in a real subprocess and
 * fails on a non-zero exit.
 */
export function readConfigFile(file: string): ConfigReadResult {
  return readBoundedFile(file, MAX_CONFIG_FILE_BYTES);
}

/**
 * Read a session transcript, refusing one beyond `MAX_TRANSCRIPT_FILE_BYTES`.
 *
 * Same stat-before-read path as `readConfigFile`, different bound and a
 * different reason for it — see `MAX_TRANSCRIPT_FILE_BYTES`.
 */
export function readTranscriptFile(file: string): ConfigReadResult {
  return readBoundedFile(file, MAX_TRANSCRIPT_FILE_BYTES);
}

/**
 * Read a durable turn file, refusing one beyond `MAX_TURN_FILE_BYTES`.
 *
 * Same stat-before-read path as the other two, a third bound and a third reason
 * for it — see `MAX_TURN_FILE_BYTES`. A caller of this one must surface the
 * failure rather than collapsing it into an empty result: that collapse is the
 * defect the bound was added for, and a correct bound with a lying caller in
 * front of it is the same silence.
 */
export function readTurnFile(file: string): ConfigReadResult {
  return readBoundedFile(file, MAX_TURN_FILE_BYTES);
}

/**
 * Create a directory below the shared root, owner-only at every level.
 *
 * `mkdirSync`'s `mode` applies at CREATION only, so a level that already exists
 * — from a release before this one, or created under a umask that stripped the
 * bits — keeps whatever it had. That is the exact `sessions/` defect
 * `ensureKeryxConfigDir`'s comment describes one screen down, and the writers
 * guard reported the first attempt at the turn store making it again. So the
 * walk is here, once, rather than in each module that needs a subdirectory.
 *
 * `segments` are joined under the resolved root. Callers pass literals; nothing
 * caller-supplied reaches this without being constrained first (see
 * `isTurnId` in `serve-turn-store.ts`).
 */
export function ensureKeryxSubdir(segments: readonly string[], dir?: string): string {
  const root = ensureKeryxConfigDir(dir);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    mkdirSync(current, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      continue;
    }
    try {
      chmodSync(current, 0o700);
    } catch {
      // Best-effort, like every other mode in this module. A level that cannot
      // be chmodded is still created; the caller's error contract decides what
      // that means, and they differ.
    }
  }
  return current;
}

/**
 * Append one line to an owner-only file under the shared directory.
 *
 * Exists so the durable turn record (flow 131 / R4c) can be append-only without
 * calling `appendFileSync` itself. `config-dir.writers.test.ts` reports every
 * raw write beside a config-path resolver, and the honest way past that guard is
 * a sanctioned helper here — not an exemption on the new module, which would
 * excuse every future write in it as well.
 *
 * Same mode trap as `writeOwnerOnlyFile`: `appendFileSync`'s `mode` applies at
 * CREATION only, so a file that already exists at 0664 stays 0664 through every
 * later append. The chmod is unconditional for that reason.
 *
 * `line` is written verbatim with a trailing newline; callers pass one JSON
 * document per call, so a torn append damages one record rather than the file.
 */
export function appendOwnerOnlyLine(file: string, line: string): void {
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
  if (process.platform === "win32") {
    return;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Unreported, exactly as in `writeOwnerOnlyFile` and for the same reason:
    // this helper sits under callers with different error contracts.
  }
}

/**
 * Write a user-global config file and force it owner-only.
 *
 * The same defect as the directory one, on the file path, and it survived the
 * first two fix rounds: `writeFileSync`'s `mode` applies at CREATION only, so a
 * `serve.json` or `auth.json` that already exists at 0664 — from a release
 * before the mode was passed, or from a restore, or from an editor — stays 0664
 * through every subsequent write. `keryx serve config set` made it reachable on
 * every single invocation, since a patch is by construction a rewrite.
 *
 * The credential store does not use this: it needs temp+fsync+rename, and rename
 * carries the temp file's mode, so it is already correct.
 *
 * Throws what the write throws — callers here decide what a failure means.
 */
export function writeOwnerOnlyFile(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o600 });
  if (process.platform === "win32") {
    return;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Unreported, like the directory chmod above and for the same reason: this
    // helper has callers with different error contracts. Nothing in keryx reads
    // the mode of these two files back, so there is no fail-closed check to
    // route it through — said plainly rather than implied.
  }
}

/**
 * Resolve the config directory, create it if absent, and force it owner-only.
 *
 * Every writer of a file in this directory must call this instead of
 * `mkdirSync`, and the reason is that `mkdirSync`'s `mode` applies at CREATION
 * only. `saveShellConfig` historically passed no mode at all, so on a host with
 * the common `umask 002` the directory already exists as 0775 by the time
 * anything else runs, and each later writer's `{ mode: 0o700 }` is a silent
 * no-op. Group write on the directory is sufficient on its own: an attacker
 * unlinks and replaces `serve-credentials.json` with the salt and hash of a
 * token they chose — setting 0600 on it themselves, so a fail-closed check that
 * inspects only the file mode never fires — and authenticates as the operator.
 * The same handle replaces `auth.json` and its plaintext provider API keys.
 *
 * A first fix tightened only the writer the finding named, and a second missed
 * `createSession`. The class is pinned instead by
 * `config-dir.permissions.test.ts`, which drives every writer under `umask 002`
 * against a directory that already exists group-writable.
 *
 * Best-effort: a directory that cannot be created or chmodded (a read-only
 * mount, a network filesystem that refuses chmod, a directory owned by someone
 * else) returns normally rather than throwing, because this helper sits under
 * seven callers with three different error contracts. What the operator sees then
 * is the caller's business and is not uniform — see the catch block below.
 * `chmod` is skipped on Windows, where POSIX modes carry no meaning.
 */
export function ensureKeryxConfigDir(dir?: string): string {
  const base = keryxConfigDir(dir);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch {
    // Deliberately swallowed: failing here would turn a persistence problem
    // into a crash in a helper every writer calls. What happens next differs by
    // caller and is NOT uniform. There are SEVEN direct callers and three
    // behaviours between them. Counting them has itself gone wrong twice — one
    // version claimed a single uniform behaviour, the next claimed two and said
    // "five callers" while counting `saveApiKey` (which reaches this only
    // through `saveShellConfig`) and omitting `createSession`. Grep for
    // `ensureKeryxConfigDir(` outside tests before editing this:
    //
    //   report it     `saveServeConfig`, `saveProjectRegistry`, `writeStore`
    //                 return false; their callers print the failure.
    //   swallow it    `saveShellConfig`, `saveShellPermissions` and
    //                 `saveSandboxDefaults` are best-effort by contract and say
    //                 nothing; `saveApiKey` inherits that from `saveShellConfig`.
    //   throw         `ensureDir` in `src/session/store.ts` lets the following
    //                 `mkdirSync` throw EACCES up through `createSession`. That
    //                 predates this helper — a shell that cannot write its
    //                 session store has nothing useful to continue with.
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(base, 0o700);
    } catch {
      // Unreported, and said plainly rather than papered over. An earlier
      // version of this comment claimed the failure was "surfaced by the
      // fail-closed permission check in readServeCredential" — a review checked
      // and it is not: that check reads the MODE OF THE FILE
      // (`serve-credential.ts`, `isGroupOrOtherAccessible`), never the
      // directory, and a wide directory produces no warning anywhere. It is
      // also precisely the check this whole fix exists because of, since an
      // attacker who replaces the file sets 0600 on it themselves.
      //
      // A directory-mode check is worth having and is not in this slice. Until
      // it is, a chmod that cannot be applied is silent, and that is the
      // honest description.
    }
  }
  return base;
}
