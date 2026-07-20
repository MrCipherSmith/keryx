// Persisted interactive-shell config (flow 080), modelled on opencode's
// `~/.local/share/opencode/auth.json`: the last-used provider/model and an
// optional OpenRouter API key, so the user does not re-enter them every launch.
//
// Stored at `~/.local/share/keryx/auth.json` with mode 0600 (owner-only). The key
// is a plaintext secret on disk — the same tradeoff opencode makes; it is written
// owner-only, never logged, and only read to populate the process env at startup.
// All functions are best-effort and never throw; the `dir` override keeps them
// unit-testable against a temp directory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ShellConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** OpenRouter API key (owner-only plaintext; loaded into env at startup). */
  openrouterKey?: string;
}

/**
 * The per-user config directory for keryx, cross-platform:
 *   - Windows: `%APPDATA%\keryx` (or `~/AppData/Roaming/keryx`).
 *   - Linux/BSD: `$XDG_DATA_HOME/keryx` (or `~/.local/share/keryx`).
 *   - macOS: `~/.local/share/keryx` (as opencode/most CLIs use on Unix).
 * Overridable via `dir` for tests.
 */
function configDir(dir?: string): string {
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

/** Absolute path to the `auth.json` config file. */
export function shellConfigPath(dir?: string): string {
  return path.join(configDir(dir), "auth.json");
}

/** Read the persisted config; `{}` when absent/unreadable/malformed. Never throws. */
export function loadShellConfig(dir?: string): ShellConfig {
  try {
    const file = shellConfigPath(dir);
    if (!existsSync(file)) {
      return {};
    }
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return raw !== null && typeof raw === "object" ? (raw as ShellConfig) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the persisted config (0600). Best-effort; never throws. */
export function saveShellConfig(patch: Partial<ShellConfig>, dir?: string): void {
  try {
    const base = configDir(dir);
    mkdirSync(base, { recursive: true });
    const next: ShellConfig = { ...loadShellConfig(dir), ...patch };
    writeFileSync(shellConfigPath(dir), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // best-effort persistence — a failure just means the user re-enters next time
  }
}
