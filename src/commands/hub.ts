import { hubCommand as clientCommand, HUB_HELP as CLIENT_HELP } from "../hub/client-command";
import { hubUpdateCommand, HUB_UPDATE_HELP } from "./hub-update";
export const HUB_HELP = CLIENT_HELP.replace("  serve ", '  update [version] [--check|--dry-run] [--install-dir path] [--yes]\n                                             Update the local server from a checksummed release; no checkout\n  machine pair --url <https-url> --code-env <name>\n  machine allow --project <id> --checkout <id> --path <path> --profile <id>\n  machine configure --hub <id> --candidate current --ad-hoc allow|deny --max-runs 1|2\n  machine readiness                          Check that this build\'s native host coverage is release-ready\n  machine recover [--hub <id>] [--action <action>]\n                                             Conservative recovery after a crash; --action defaults to inspect\n  machine unpair [--hub <id>]                Remove this machine\'s local enrollment\n' + "  serve ");
export function printHubHelp(rest: readonly string[] = []): void { console.log(rest[0] === "update" ? HUB_UPDATE_HELP : HUB_HELP); }
export async function hubCommand(args: string[]): Promise<void> {
  if (args[0] === "update") {
    const code = await hubUpdateCommand(args.slice(1));
    if (code !== 0) process.exitCode = code;
    return;
  }
  await clientCommand(args, async machineArgs => { const { hubMachineCommand } = await import("./hub-machine"); await hubMachineCommand(machineArgs); }, HUB_HELP, async () => {
    const {startHub,loadHubConfig}=await import('../hub/server');
    const server=startHub(loadHubConfig(process.env));
    console.log(`Team Hub listening at ${server.url}`);
  });
}
