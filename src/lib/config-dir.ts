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
//
// NOT resolved through this function, stated rather than glossed over:
// `src/session/paths.ts` has its own `keryxDataDir()`, which applies the same
// platform rules but ALSO honours a `KERYX_DATA_DIR` override. With that
// variable set the two disagree, and `sessions/` moves while `auth.json` does
// not. That divergence predates this flow and is left alone deliberately:
// teaching this resolver about `KERYX_DATA_DIR` would relocate the `auth.json`
// of any existing install that sets it, which is a migration, not a cleanup.
// It is recorded here so the next person finds it rather than discovering it.

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
