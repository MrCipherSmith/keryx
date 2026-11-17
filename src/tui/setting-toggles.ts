// The `/editguard on|off` and `/projectctx warn|block` writes, as text, with no renderer
// (flow 343 / flow 461). The full-screen shell makes the same writes from its own closures;
// the ACP `shell` profile (`src/acp/shell-command-runners.ts`) calls these instead of
// reaching into the review and gdskills owners itself.

import { writeProjectContextEnforcement } from "../gdskills/project-context-config";
import { loadProjectContextStatus } from "../gdskills/project-context-status";
import { writeJevEditGuardEnabled } from "../review/jev-edit-guard-config";
import { PROJECT_CONTEXT_CONFIG_REFUSAL } from "./project-context-command";

export interface ToggleOutcome {
  readonly text: string;
  /** The write did not happen: the reason is `text`. */
  readonly refused?: true;
  /** The write happened. */
  readonly changed?: true;
}

/** `/editguard on|off`: the project's `review.jev.edit_guard` switch. */
export async function setEditGuardText(cwd: string, on: boolean): Promise<ToggleOutcome> {
  try {
    await writeJevEditGuardEnabled(cwd, on);
  } catch (error) {
    return { text: `editguard: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  return { text: `EditGuard: ${on ? "on" : "off"}\n`, changed: true };
}

/** `/projectctx warn|block`: refused, not overwritten, when the project's config file is not valid JSON. */
export async function setProjectContextText(cwd: string, mode: "warn" | "block"): Promise<ToggleOutcome> {
  try {
    const current = await loadProjectContextStatus(cwd);
    if (current.configError !== undefined) return { text: `${PROJECT_CONTEXT_CONFIG_REFUSAL}\n`, refused: true };
    await writeProjectContextEnforcement(cwd, mode);
  } catch (error) {
    return { text: `projectctx: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  return { text: `ProjectCtx: ${mode}\n`, changed: true };
}
