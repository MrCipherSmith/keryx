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

import { chmodSync, mkdirSync } from "node:fs";
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
 * A first fix tightened only the writer the finding named. The class is pinned
 * instead by `config-dir.permissions.test.ts`, which drives all five writers
 * under `umask 002` against an already-widened directory.
 *
 * Best-effort: a directory that cannot be created or chmodded (a read-only
 * mount, a network filesystem that refuses chmod, a directory owned by someone
 * else) returns normally rather than throwing, because this helper sits under
 * five writers with different error contracts. What the operator sees then is
 * the caller's business and is not uniform — see the catch blocks below.
 * `chmod` is skipped on Windows, where POSIX modes carry no meaning.
 */
export function ensureKeryxConfigDir(dir?: string): string {
  const base = keryxConfigDir(dir);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch {
    // Deliberately swallowed: failing here would turn a persistence problem
    // into a crash in a helper every writer calls. What happens next differs by
    // caller and is NOT uniform — `saveServeConfig`, `saveProjectRegistry` and
    // `writeStore` return false and their callers report it, while
    // `saveShellConfig` (and `saveApiKey` through it) is best-effort by
    // contract and reports nothing at all. An earlier comment here claimed the
    // caller always reports; a review checked and two of the five do not.
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
