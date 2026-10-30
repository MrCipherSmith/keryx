import { HubConnector } from "../hub/connector";
import { validateWatchInterval, watchHubContext } from "../hub/context-watch";
export const HUB_HELP = `keryx hub — Team Hub prototype
  serve                                      Start Hub from KERYX_HUB_* environment
  status                                     Show local binding; no network or credentials
  mcp --url <http(s)://host/mcp> [--token-env <name>]
                                             Bridge remote Hub MCP over local stdio; no checkout needed
  connect --url <http(s)://host> --project <id> [--token-env <name>]
  import [--token-env <name>]                 Import bounded OpenSpec/wiki Markdown
  sync [--watch [--interval <seconds>]] [--token-env <name>]
                                             Refresh context; foreground watch defaults to 15 seconds (5..3600)
  submit --message <text> [--token-env <name>] Upload tracked file snapshot/delta
  fetch --delivery <id> [--token-env <name>]   Fetch/verify publication receipt; preview only
  pull [--revision <id>] [--apply] [--token-env <name>]
                                             Preview selected code; apply with recovery checkpoint
Credentials: KERYX_HUB_TOKEN by default; binding never stores tokens.
Run checkout commands from the intended checkout; mcp needs no checkout. Pull leaves Git HEAD/index unchanged; commit or inspect normally.
`;
export function printHubHelp(help = HUB_HELP): void {
    console.log(help);
}
export async function hubCommand(args: string[], machineHandler?: (args: string[]) => Promise<void>, help = HUB_HELP): Promise<void> {
    if (!args.length || args.includes("--help") || args.includes("-h")) {
        printHubHelp(help);
        return;
    }
    const [command, ...rest] = args;
    if (command === "machine") {
        if (!machineHandler) throw new Error("Machine commands require the full Keryx executor installation; this package contains the Hub context client only.");
        await machineHandler(rest);
        return;
    }
    const allowed: Record<string, string[]> = {
        fetch: ["--delivery", "--token-env"], serve: [], status: [], mcp: ["--url", "--token-env"], connect: ["--url", "--project", "--token-env"], import: ["--token-env"], sync: ["--token-env", "--watch", "--interval"], submit: ["--message", "--token-env"], pull: ["--revision", "--apply", "--token-env"]
    };
    if (!command || !allowed[command])
        throw Error("Unknown hub command; use keryx hub --help");
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i]!;
        if (!allowed[command]!.includes(flag) || flags.has(flag))
            throw Error(command === "mcp" ? "Invalid hub mcp arguments; use keryx hub --help" : `Unknown or repeated hub argument: ${flag}`);
        if (flag === "--apply" || flag === "--watch") {
            flags.set(flag, "true");
            continue;
        }
        const value = rest[++i];
        if (!value || value.startsWith("--"))
            throw Error(`Missing value for ${flag}`);
        flags.set(flag, value);
    }
    if (flags.has("--interval") && !flags.has("--watch")) throw Error("--interval requires --watch");
    const intervalText = flags.get("--interval");
    const intervalSeconds = intervalText === undefined ? 15 : Number(intervalText);
    if (intervalText !== undefined && !/^\d+$/.test(intervalText)) throw Error("Invalid watch interval; use an integer from 5 through 3600");
    if (flags.has("--watch")) validateWatchInterval(intervalSeconds);
    if (command === "serve") {
        const { startHub, loadHubConfig } = await import("../hub/server");
        const server = startHub(loadHubConfig(process.env));
        console.log(`Team Hub listening at ${server.url}`);
        return;
    }
    const required = (flag: string) => {
        const value = flags.get(flag);
        if (!value)
            throw Error(`Required ${flag}`);
        return value;
    };
    if (command === "mcp") {
        const { runHubMcpBridge } = await import("../hub/mcp-bridge");
        await runHubMcpBridge({ endpoint: required("--url"), ...(flags.has("--token-env") ? { tokenEnv: flags.get("--token-env")! } : {}) });
        return;
    }
    const connector = new HubConnector({ cwd: process.cwd(), ...(flags.has("--token-env") ? { tokenEnv: flags.get("--token-env")! } : {}) });
    if (command === "status") {
        const status = await connector.status();
        if (!status.ok)
            throw Error(status.error === "unreadable-binding" ? "Cannot read Hub connection binding." : "Invalid Hub connection binding.");
        console.log(status.connection ? JSON.stringify(status.connection, null, 2) : "This checkout is not connected to Team Hub.");
        return;
    }
    let result: unknown;
    switch (command) {
        case "connect":
            result = await connector.connect(required("--url"), required("--project"));
            break;
        case "import":
            result = await connector.importDocuments();
            break;
        case "sync":
            if (flags.has("--watch")) {
                const controller = new AbortController();
                const stop = () => controller.abort();
                process.on("SIGINT", stop);
                process.on("SIGTERM", stop);
                try {
                    await watchHubContext({ connector, intervalSeconds, signal: controller.signal, onEvent: event => console.log(JSON.stringify(event)) });
                } finally {
                    process.off("SIGINT", stop);
                    process.off("SIGTERM", stop);
                }
                return;
            }
            result = await connector.sync();
            break;
        case "submit":
            result = await connector.submit(required("--message"));
            break;
        case "fetch":
            result = await connector.fetchDelivery(required("--delivery"));
            break;
        case "pull":
            result = await connector.pull(flags.get("--revision"), flags.has("--apply"));
            break;
    }
    console.log(JSON.stringify(result, null, 2));
}
