import { rejectUnknownFlags } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { OpenSpecReadError, readOpenSpec, type OpenSpecDetail, type OpenSpecEntrySummary, type OpenSpecPage, type OpenSpecSearchHit } from "../openspec/service";

type Kind = "spec" | "change" | "archive";
type Scope = Kind | "all";
type Args =
  | { action: "list"; kind: Kind; cursor?: string; json: boolean }
  | { action: "show"; path: string; artifactPath?: string; section?: string; json: boolean }
  | { action: "search"; query: string; scope?: Scope; cursor?: string; json: boolean };

const usage = "Usage: keryx openspec list --kind <spec|change|archive> [--cursor <cursor>] [--json] | show <path> [--artifact <path>] [--section <id>] [--json] | search <query> [--scope <all|spec|change|archive>] [--cursor <cursor>] [--json]";

export function parseOpenSpecArgs(args: string[]): Args {
  const [action, ...rest] = args;
  if (action !== "list" && action !== "show" && action !== "search") throw new Error(usage);
  const options: Record<string, string> = {};
  let positional: string | undefined;
  let json = false;
  const allowed = action === "list" ? ["--kind", "--cursor"] : action === "show" ? ["--artifact", "--section"] : ["--scope", "--cursor"];
  rejectUnknownFlags(rest, [...allowed, "--json"], `openspec ${action}`);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) throw new Error(usage);
    if (arg === "--json") {
      if (json) throw new Error(usage);
      json = true;
    } else if (arg.startsWith("-")) {
      const value = rest[++i];
      if (!allowed.includes(arg) || options[arg] !== undefined || !value || value.startsWith("-")) throw new Error(usage);
      options[arg] = value;
    } else {
      if (positional !== undefined) throw new Error(usage);
      positional = arg;
    }
  }
  const kind = options["--kind"];
  const scope = options["--scope"];
  if (action === "list") {
    if (positional || (kind !== "spec" && kind !== "change" && kind !== "archive")) throw new Error(usage);
    return { action, kind, ...(options["--cursor"] ? { cursor: options["--cursor"] } : {}), json };
  }
  if (!positional?.trim()) throw new Error(usage);
  if (action === "show") return { action, path: positional, ...(options["--artifact"] ? { artifactPath: options["--artifact"] } : {}), ...(options["--section"] ? { section: options["--section"] } : {}), json };
  if (scope !== undefined && scope !== "all" && scope !== "spec" && scope !== "change" && scope !== "archive") throw new Error(usage);
  return { action, query: positional, ...(scope ? { scope } : {}), ...(options["--cursor"] ? { cursor: options["--cursor"] } : {}), json };
}

function formatPage(result: OpenSpecPage<OpenSpecEntrySummary> | OpenSpecPage<OpenSpecSearchHit>): string {
  const lines = result.items.map(item => {
    if ("entry" in item) {
      const line = item.source.startLine ? `:${item.source.startLine}` : "";
      return `${item.entry.kind}  ${item.entry.title}  ${item.source.path}${line}\n  ${item.snippet}`;
    }
    return `${item.kind}  ${item.title}  ${item.path}`;
  });
  if (!lines.length) lines.push("No entries found.");
  if (result.partial) lines.push("Results are partial.");
  if (result.nextCursor) lines.push(`Next cursor: ${result.nextCursor}`);
  return lines.join("\n");
}

function formatDetail(detail: OpenSpecDetail): string {
  const lines = [`${detail.entry.title} (${detail.entry.kind})`, detail.entry.path];
  if (detail.artifact) lines.push("", detail.artifact.markdown);
  else if (detail.artifacts.length) lines.push("", "Artifacts:", ...detail.artifacts.map(item => `  ${item.path}`));
  for (const diagnostic of detail.diagnostics) lines.push(`${diagnostic.code}: ${diagnostic.message}`);
  if (detail.partial) lines.push("Results are partial.");
  return lines.join("\n");
}

export async function openspecCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  try {
    const input = parseOpenSpecArgs(args);
    const snapshot = await readOpenSpec(resolveProjectRoot(process.cwd()));
    if (snapshot.catalog.availability === "unavailable") throw new Error("OpenSpec source is unavailable.");
    const result = input.action === "list"
      ? snapshot.list({ kind: input.kind, ...(input.cursor !== undefined && { cursor: input.cursor }) })
      : input.action === "show"
        ? snapshot.detail({ path: input.path, ...(input.artifactPath !== undefined && { artifactPath: input.artifactPath }), ...(input.section !== undefined && { section: input.section }) })
        : snapshot.search({ query: input.query, ...(input.scope !== undefined && { scope: input.scope === "all" ? ["spec", "change", "archive"] : [input.scope] }), ...(input.cursor !== undefined && { cursor: input.cursor }) });
    const output = input.json
      ? JSON.stringify({ schemaVersion: 2, ...result, ...(input.action === "list" && { availability: snapshot.catalog.availability, diagnostics: snapshot.catalog.diagnostics }) })
      : input.action === "show" ? formatDetail(result as OpenSpecDetail) : `${input.action === "list" ? `OpenSpec ${snapshot.catalog.availability}\n` : ""}${formatPage(result as OpenSpecPage<OpenSpecEntrySummary> | OpenSpecPage<OpenSpecSearchHit>)}`;
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const code = error instanceof OpenSpecReadError ? error.code : error instanceof Error && (error.message.startsWith("Usage:") || error.message.startsWith("Unknown option") || error.message.startsWith("`keryx openspec")) ? "invalid-input" : "unavailable";
    const message = error instanceof Error ? error.message : "OpenSpec request failed.";
    process.exitCode = code === "invalid-input" || code === "not-found" || code === "stale-section" || code === "stale-snapshot" ? 1 : 2;
    if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 2, error: { code, message } })}\n`);
    else process.stderr.write(`${message}\n`);
  }
}
