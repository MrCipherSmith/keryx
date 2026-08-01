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
//   sessions/               per-project interactive session store — created by
//                           `src/session/store.ts`, which calls this helper
//                           because with KERYX_DATA_DIR unset its root IS this
//                           directory
//
// NOT resolved through this function, stated rather than glossed over:
// `src/session/paths.ts` has its own `keryxDataDir()`, which applies the same
// platform rules but ALSO honours a `KERYX_DATA_DIR` override. With that
// variable set the two disagree, and `sessions/` moves while `auth.json` does
// not. That divergence predates this flow and is left alone deliberately:
// teaching this resolver about `KERYX_DATA_DIR` would relocate the `auth.json`
// of any existing install that sets it, which is a migration, not a cleanup.
// It is recorded here so the next person finds it rather than discovering it.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * the third time on this branch that a fix covered the site a finding named
 * rather than the class, so the bound lives here and every reader uses it.
 */
export const MAX_CONFIG_FILE_BYTES = 1_000_000;

/** Why a config file could not be read. `null` means it was read fine. */
export type ConfigReadFailure = "absent" | "too-large" | "unreadable";

export type ConfigReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: ConfigReadFailure };

/**
 * Read a user-global config file, refusing one too large to be a config.
 *
 * The size is checked with `statSync` BEFORE the read, because the abort
 * happens inside `readFileSync` and cannot be caught after the fact. Every
 * reader of this directory must go through here;
 * `config-dir.readers.test.ts` runs each one against an oversized file in a
 * real subprocess and fails on a non-zero exit.
 */
export function readConfigFile(file: string): ConfigReadResult {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    // Absent, a dangling symlink, or a path we cannot stat. The caller's
    // existing "nothing configured" branch is the right answer for all three.
    return { ok: false, reason: "absent" };
  }
  if (size > MAX_CONFIG_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
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
