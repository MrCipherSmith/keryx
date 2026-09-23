// Flow 303 (AC8): remember whether the first-run `/help` onboarding modal
// has already been shown, in the per-user keryx config dir (never inside the
// project — the same directory `auth.json`/`version-check.json` live in), so
// it opens once ever, not once per project and not once per launch.

import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "../lib/config-dir";

const FIRST_RUN_HELP_FILE = "help-first-run.json";

function firstRunHelpPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), FIRST_RUN_HELP_FILE);
}

interface FirstRunHelpRecord {
  shown?: boolean;
}

/** Has the first-run help modal already been shown (in a PRIOR launch, on this machine)? */
export function helpFirstRunShown(dir?: string): boolean {
  const result = readConfigFile(firstRunHelpPath(dir));
  if (!result.ok) {
    return false;
  }
  try {
    const parsed = JSON.parse(result.text) as FirstRunHelpRecord;
    return parsed.shown === true;
  } catch {
    // A corrupt or hand-edited file is treated as "not shown" — the modal
    // showing again is a minor annoyance; silently never onboarding a new
    // user because of a bad file is the worse failure.
    return false;
  }
}

/**
 * Should the first-run help modal open right now? Pure — extracted from
 * `launchTuiAgentShell`'s wiring so the two cases AC8 names are each testable
 * without driving the whole TUI shell:
 *   - not shown yet, and no provider is connected -> true (open it, once);
 *   - already shown -> false, regardless of provider state (never again);
 *   - a provider IS connected -> false, even on a genuinely first run (there
 *     is nothing to onboard).
 */
export function shouldOpenFirstRunHelp(alreadyShown: boolean, connectedProviderCount: number): boolean {
  return !alreadyShown && connectedProviderCount === 0;
}

/** Record that the first-run help modal has now been shown; never shows again. */
export function markHelpFirstRunShown(dir?: string): void {
  ensureKeryxConfigDir(dir);
  writeOwnerOnlyFile(
    firstRunHelpPath(dir),
    JSON.stringify({ shown: true, at: new Date().toISOString() }, null, 2),
  );
}

export interface ResolveFirstRunHelpOptions {
  /** Has the first-run help modal already been shown, on a PRIOR launch? */
  shown: boolean;
  /**
   * Count connected providers. A real network probe
   * (`filterConnectedDetectedProviders`) — up to ~10s per configured
   * provider, sequential — so this is called AT MOST ONCE, only on a
   * genuine first run (`shown === false`); a later run never calls it.
   */
  probe: () => Promise<number>;
  /** Record that first-run help has been resolved. Called on every first run — whether or not the modal ends up opening. */
  mark: () => void;
}

/**
 * The whole AC8 decision in one place (PR #669 review, HIGH 1): the marker
 * used to be written only on the branch that actually opened the modal (no
 * provider connected), so a user who already had a provider configured on
 * their first run was NEVER marked — every later launch re-ran the network
 * probe from scratch, forever. Folding the probe and the marker into one
 * function makes that bug structurally impossible to reintroduce: `mark()`
 * runs on every first run this function sees, unconditionally, whichever way
 * the decision goes.
 *
 * Returns the group slug to open the modal on ("connect"), or `undefined`
 * when nothing should open. Callers must NOT `await` this inline in the
 * shell's startup sequence — the probe it calls can take real, user-visible
 * time and must never delay the composer becoming interactive; see the
 * `void resolveFirstRunHelp(...).then(...)` call site in `tui-shell.ts`.
 */
export async function resolveFirstRunHelp(opts: ResolveFirstRunHelpOptions): Promise<string | undefined> {
  if (opts.shown) {
    return undefined; // never probes, never marks again — already resolved
  }
  let connectedProviderCount: number;
  try {
    connectedProviderCount = await opts.probe();
  } catch {
    // An unknown answer opens nothing and marks nothing: the next launch asks again.
    return undefined;
  }
  try {
    opts.mark(); // ALWAYS, on every first run — connected or not
  } catch {
    // A marker that cannot be written (read-only home, full disk) must not take
    // the shell down; the worst case is that the next launch probes once more.
  }
  return shouldOpenFirstRunHelp(false, connectedProviderCount) ? "connect" : undefined;
}
