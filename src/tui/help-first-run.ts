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
