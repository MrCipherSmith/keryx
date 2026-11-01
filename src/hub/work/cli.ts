import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { HubConnector } from "../connector";
import { contributorWorkCommands, createWorkClient } from "./client";
import { matchesWorkSchema, type WorkReadName } from "./openapi";
import type { WorkCommand } from "./model";

export const WORK_HELP = `keryx hub work — Managed work metadata
  status                                     Show local binding; no network or credentials
  capabilities                               Show enabled features and permitted commands
  flow list | flow show <id>                  Read managed Flows
  intent list --flow <id> | intent show <id>
  attempt list --intent <id> | attempt show <id>
  context show <id> | subject show <id>        Fetch exact immutable metadata
  evidence list --attempt <id> | decision list [--target <id>]
  submission show <id> | flow-submission show <id> | amendment show <id>
  revision show --flow <id> --revision <id>    Exact Flow revision (or --intent)
  attention | snapshot [--cursor <opaque>] | events [--after <opaque>]
  operation show <operationId>                Poll own original operation outcome
  command --input <file|->                    Send contributor command envelope JSON
  <flow|intent|attempt|context|subject|evidence|revision> <action> --input <file|->
                                             Alias for matching contributor command
Read pagination: --limit <n> --after-id <opaque>; token: --token-env <name>.
Uses the trusted project connection from keryx hub connect. Input is at most 64 KiB.
Supply operationId, expectedVersions, command and payload; reuse identical input after an uncertain result.
No approval, selection, acceptance, waiver, amendment, cancellation or execution dispatch commands.
`;
type Connector = Pick<HubConnector, "status" | "binding">;
type Options = { connector?: Connector; cwd?: string; env?: Record<string, string | undefined>; fetch?: (request: Request) => Promise<Response>; write?: (value: string) => void; readInput?: (source: string) => Promise<string> };
function invalid(): never { throw Error("Invalid hub work arguments; use keryx hub work --help"); }
async function inputText(source: string): Promise<string> {
    let size = 0; const chunks: Uint8Array[] = [];
    if (source === "-") {
        if (process.stdin.isTTY) throw Error("Pipe a command envelope to stdin, or specify a JSON input file.");
        for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); size += bytes.byteLength; if (size > 65536) throw Error("Work command input exceeds 64 KiB."); chunks.push(bytes); }
    } else {
        const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw Error("Cannot read work command input file."); });
        try {
            const stat = await file.stat(); if (!stat.isFile() || stat.size > 65536) throw Error("Work command input must be a regular file at most 64 KiB.");
            const bytes = Buffer.alloc(65537); const result = await file.read(bytes, 0, bytes.length, 0);
            if (result.bytesRead > 65536) throw Error("Work command input exceeds 64 KiB."); chunks.push(bytes.subarray(0, result.bytesRead));
        } finally { await file.close(); }
    }
    return Buffer.concat(chunks).toString("utf8");
}
function parse(args: string[]) {
    const words: string[] = []; const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!arg.startsWith("--")) { words.push(arg); continue; }
        if (!["--input", "--token-env", "--flow", "--intent", "--attempt", "--target", "--revision", "--limit", "--after-id", "--cursor", "--after"].includes(arg) || flags.has(arg)) invalid();
        const value = args[++i]; if (!value || value.startsWith("--")) invalid(); flags.set(arg, value);
    }
    return { words, flags };
}
export async function runWorkCommand(args: string[], options: Options = {}): Promise<void> {
    const write = options.write ?? console.log;
    if (!args.length || args.includes("--help") || args.includes("-h")) { write(WORK_HELP); return; }
    const { words, flags } = parse(args); const [family, action, entityId] = words;
    const connector = options.connector ?? new HubConnector({ cwd: options.cwd ?? process.cwd() });
    const status = await connector.status();
    if (!status.ok) throw Error("Invalid or unreadable Hub connection binding.");
    if (family === "status" && words.length === 1 && !flags.size) { write(status.connection ? JSON.stringify({ url: status.connection.url, projectId: status.connection.projectId, checkoutId: status.connection.checkoutId }, null, 2) : "This checkout is not connected to Team Hub."); return; }
    if (!status.connection) throw Error("This checkout is not connected to Team Hub; use keryx hub connect first.");
    const { projectId } = status.connection;
    const params: Record<string, string | number> = {}; let read: WorkReadName | undefined;
    const used = new Set(["--token-env"]);
    const take = (flag: string, key: string, required = false) => { const value = flags.get(flag); used.add(flag); if (required && !value) invalid(); if (value !== undefined) params[key] = value; };
    const shows: Record<string, [WorkReadName, string]> = { flow: ["get_flow", "flowId"], intent: ["get_intent", "intentId"], attempt: ["get_attempt", "attemptId"], context: ["get_context", "contextId"], subject: ["get_subject", "subjectId"], submission: ["get_submission", "submissionId"], "flow-submission": ["get_flow_submission", "submissionId"], amendment: ["get_amendment", "amendmentId"], operation: ["operation", "operationId"] };
    if (flags.has("--input")) {
        used.add("--input");
        if (words.length !== 1 && words.length !== 2 || family !== "command" && !contributorWorkCommands.includes(`${family}.${action}` as WorkCommand["command"])) invalid();
        if (family === "command" && words.length !== 1) invalid();
    } else if (words.length === 1 && ["capabilities", "attention", "events", "snapshot"].includes(family!)) {
        read = family as "capabilities" | "attention" | "events" | "snapshot";
    } else if (action === "show" && words.length === 3 && shows[family!]) {
        const [name, field] = shows[family!]!; read = name; params[field] = entityId!;
    } else if (action === "list" && words.length === 2) {
        if (family === "flow") read = "list_flows";
        else if (family === "intent") { read = "list_intents"; take("--flow", "flowId", true); }
        else if (family === "attempt") { read = "list_attempts"; take("--intent", "intentId", true); }
        else if (family === "evidence") { read = "list_evidence"; take("--attempt", "attemptId", true); }
        else if (family === "decision") { read = "list_decisions"; take("--target", "targetId"); }
        else invalid();
    } else if (family === "revision" && action === "show" && words.length === 2) {
        if (flags.has("--flow") === flags.has("--intent")) invalid();
        read = flags.has("--flow") ? "get_flow_revision" : "get_intent_revision";
        take(flags.has("--flow") ? "--flow" : "--intent", flags.has("--flow") ? "flowId" : "intentId", true); take("--revision", "revisionId", true);
    } else invalid();
    if (read && ["list_flows", "list_intents", "list_attempts", "list_evidence", "list_decisions", "attention", "events", "snapshot"].includes(read)) {
        if (flags.has("--limit")) { used.add("--limit"); const value = flags.get("--limit")!; if (!/^\d+$/.test(value)) invalid(); params.limit = Number(value); }
        take(read === "events" ? "--after" : read === "snapshot" ? "--cursor" : "--after-id", read === "events" ? "after" : read === "snapshot" ? "cursor" : "afterId");
    }
    if ([...flags.keys()].some(flag => !used.has(flag))) invalid();
    let command: WorkCommand | undefined;
    if (flags.has("--input")) {
        const raw = await (options.readInput ?? inputText)(flags.get("--input")!);
        if (Buffer.byteLength(raw, "utf8") > 65536) throw Error("Work command input exceeds 64 KiB.");
        let value: unknown; try { value = JSON.parse(raw) as unknown; } catch { throw Error("Invalid work command JSON."); }
        if (!matchesWorkSchema(value, { $ref: "#/components/schemas/WorkCommand" })) throw Error("Invalid work command envelope.");
        command = value as WorkCommand;
        if (!contributorWorkCommands.includes(command.command) || family !== "command" && command.command !== `${family}.${action}`) throw Error("This CLI exposes contributor work commands only; command does not match the requested action.");
    }
    const binding = await connector.binding();
    const tokenEnv = flags.get("--token-env") ?? binding.tokenEnv;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw Error("Invalid Hub token environment variable name.");
    const token = (options.env ?? process.env)[tokenEnv]; if (!token) throw Error("Hub token environment variable is empty.");
    const client = createWorkClient({ baseUrl: status.connection.url, headers: { Authorization: `Bearer ${token}` }, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const result = command ? await client.command(projectId, command) : await client.read(read!, projectId, params);
    write(JSON.stringify(result, (_key, value: unknown) => typeof value === "string" ? value.replaceAll(token, "[REDACTED]") : value, 2));
}
