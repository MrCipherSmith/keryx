// `keryx setup` — print the Metaproject preparation guide.
//
// The human-readable guide is also rendered by the shell modal.

import { parseSetupArgs, renderSetupGuide, renderSetupScenario, renderSetupUsage } from "./setup-guide";

export async function setupCommand(rest: string[]): Promise<void> {
  const operation = rest[0];
  if (operation === "inspect" || operation === "plan" || operation === "apply") {
    const { setupProjectCommand } = await import("./setup-project");
    await setupProjectCommand(operation, rest.slice(1));
    return;
  }
  if (rest[0] === "--help" || rest[0] === "-h") {
    const { SETUP_JSON_USAGE } = await import("./setup-project");
    console.log(`${renderSetupUsage()}
Project automation
${SETUP_JSON_USAGE}`);
    return;
  }
  const request = parseSetupArgs(rest);
  if (request.kind === "error") {
    console.error(request.message);
    console.error("Run `keryx setup --help` for the guide.");
    process.exitCode = 1;
    return;
  }
  console.log(request.kind === "all" ? renderSetupGuide() : renderSetupScenario(request.scenario));
}
