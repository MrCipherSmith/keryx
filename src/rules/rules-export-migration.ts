// Flow 363: `keryx init` / `keryx update` moving a `keryx:rules` block — the
// opt-in rules-export surface's, written into a tracked `CLAUDE.md` /
// `AGENTS.md` by keryx before 0.3.47 — to the local target its runtime uses.
//
// Two steps around `syncAgentRules`, because the local targets are written
// in between: `moveRulesBlocksOutOfTeamFiles` (before) takes the block out of
// the team file, so the Codex override is generated from the restored team
// file and the imported rules copy it without the block; `reinstallRulesExport`
// (after) installs the surface again for each runtime that lost a block,
// which re-renders it from the current rules library into the local target
// the surface now resolves to. Kept out of `./entrypoint-writers` so the
// block writers do not depend on the integrations installer.
//
// The other direction (review round 1, F-002): a runtime switched from local
// to shared loses its local target, the installed block with it;
// `rulesBlocksLeavingLocalTargets` (before) names those runtimes, and the
// same `reinstallRulesExport` (after) writes the block into the team file.

import { installIntegration } from "../integrations/installer";
import type { EntrypointRuntime } from "./entrypoint-targets";

export { moveRulesBlocksOutOfTeamFiles, rulesBlocksLeavingLocalTargets } from "./entrypoint-writers";

const RULES_EXPORT_SURFACE_ID = "rules-export";

/**
 * Installs the rules-export surface for every runtime in `moved`. A failure
 * is reported, not thrown: the block has already left the team file, and the
 * line tells the developer the one command that puts it back.
 */
export async function reinstallRulesExport(
  projectRoot: string,
  moved: readonly EntrypointRuntime[],
  notice: (line: string) => void = () => {},
): Promise<void> {
  for (const runtime of moved) {
    const retry = `keryx integrations install --runtime ${runtime} --surface rules`;
    let result: Awaited<ReturnType<typeof installIntegration>>;
    try {
      result = await installIntegration(projectRoot, runtime, { surfaces: [RULES_EXPORT_SURFACE_ID] });
    } catch (error) {
      notice(`rules-export (${runtime}): the keryx:rules block was not written again — ${error instanceof Error ? error.message : String(error)}. Run \`${retry}\`.`);
      continue;
    }
    const surface = result.results.find((entry) => entry.surfaceId === RULES_EXPORT_SURFACE_ID);
    if (surface === undefined || surface.status === "failed" || result.errors.length > 0) {
      notice(`rules-export (${runtime}): the keryx:rules block was not written again — ${[...result.errors, ...(surface?.errors ?? [])].join("; ") || "no result"}. Run \`${retry}\`.`);
    } else if (surface.file === undefined) {
      notice(`rules-export (${runtime}): ${surface.warnings.join(" ")}`);
    } else {
      notice(`${surface.file}: holds the keryx:rules block now, rendered from the current rules library.`);
    }
  }
}
