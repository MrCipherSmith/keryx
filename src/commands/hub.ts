import { hubCommand as clientCommand, HUB_HELP as CLIENT_HELP } from "../hub/client-command";
export const HUB_HELP = CLIENT_HELP.replace("  serve ", '  machine pair --url <https-url> --code-env <name>\n  machine allow --project <id> --checkout <id> --path <path> --profile <id>\n  machine configure --hub <id> --candidate current --ad-hoc allow|deny --max-runs 1|2\n  machine unpair | recover                   Local enrollment and conservative recovery\n' + "  serve ");
export function printHubHelp(): void { console.log(HUB_HELP); }
export async function hubCommand(args: string[]): Promise<void> { await clientCommand(args, async machineArgs => { const { hubMachineCommand } = await import("./hub-machine"); await hubMachineCommand(machineArgs); }, HUB_HELP); }
