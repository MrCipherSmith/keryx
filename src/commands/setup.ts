// `keryx setup` — print the Metaproject preparation guide.
//
// Read-only. The scenarios live in `./setup-guide` so the shell modal renders
// the same text. This command never invokes init, update, sync, or enrich.

import {
  renderSetupGuide,
  renderSetupScenario,
  renderSetupUsage,
  SETUP_SCENARIO_IDS,
  setupScenario,
} from "./setup-guide";

export async function setupCommand(rest: string[]): Promise<void> {
  const arg = rest[0];
  if (arg === "--help" || arg === "-h") {
    console.log(renderSetupUsage());
    return;
  }
  if (arg === undefined) {
    console.log(renderSetupGuide());
    return;
  }
  const scenario = setupScenario(arg);
  if (scenario === undefined) {
    console.error(`Unknown setup scenario: ${arg}`);
    console.error(`Choose one of: ${SETUP_SCENARIO_IDS.join(", ")}`);
    console.error("Run `keryx setup --help` for the guide.");
    process.exitCode = 1;
    return;
  }
  console.log(renderSetupScenario(scenario));
}
