// `keryx setup` — print the Metaproject preparation guide.
//
// Read-only. The scenarios live in `./setup-guide` so the shell modal renders
// the same text. This command never invokes init, update, sync, or enrich.

import { parseSetupArgs, renderSetupGuide, renderSetupScenario, renderSetupUsage } from "./setup-guide";

export async function setupCommand(rest: string[]): Promise<void> {
  if (rest[0] === "--help" || rest[0] === "-h") {
    console.log(renderSetupUsage());
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
