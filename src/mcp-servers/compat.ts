// Reading the MCP servers somebody else's tool already configured.
//
// P3a, spec AC10. Four other tools keep a list of MCP servers on this
// machine, and an operator who has already set one up should not have to
// set it up again to use it from keryx. keryx reads those lists and
// NEVER writes to them.
//
// Read-only is not a convention here, it is the design:
//
//   - `keryx mcp add` always writes native JSON, so the file keryx owns
//     is the only file keryx changes;
//   - `remove` on a compat-only name FAILS, naming the file to edit,
//     rather than quietly writing a native entry that shadows it — a
//     "removal" that adds a file is the kind of success nobody asked
//     for;
//   - `enable`/`disable` go through the personal overlay, exactly as
//     they already do for a committed project file. Toggling somebody
//     else's config by editing it is how two tools start fighting over
//     one file.
//
// Precedence: native project, then native user, then compat. Native
// wins because it is what keryx owns and what `add` writes; a compat
// source is a courtesy read of a file whose author never agreed to
// keryx's semantics. Among compat sources the order is fixed and
// asserted, so "which one won" is answerable rather than emergent.
//
// Every reader is defensive in the same way `parseConfigFile` is: a
// malformed file is a REPORTED PROBLEM naming the file, never a crash
// and never a silent skip. A silently skipped source is
// indistinguishable from one that was never configured, which is the
// state an operator debugs for an hour.

import path from "node:path";
import os from "node:os";
import { isDefiniteAbsence, readConfigFile } from "../lib/config-dir";
import { parseJsonTolerant, type McpConfigProblem, type McpServerEntry } from "./config";

/**
 * Which other tool a server came from.
 *
 * Distinct values rather than one `"compat"`, because `keryx mcp list`
 * tags each row and "edit the file it came from" is only actionable if
 * the row says which file that is.
 */
export type CompatSource = "cursor" | "claude" | "mcp.json" | "grok";

export type CompatServers = {
  readonly servers: Record<string, McpServerEntry>;
  readonly problems: readonly McpConfigProblem[];
};

/** One compat file, in the order it is consulted. */
export type CompatFile = {
  readonly source: CompatSource;
  readonly file: string;
};

/**
 * Every compat file keryx will look at, in PRECEDENCE ORDER — later wins.
 *
 * Project-local before user-global within a source, matching how the
 * native readers already treat `.keryx/mcp-servers.json` versus the user
 * file: the more specific location is the more deliberate statement.
 *
 * The order across sources is arbitrary in the sense that no external
 * authority sets it, and fixed in the sense that it is written here and
 * asserted by a test. An arbitrary order that is stable and documented
 * is answerable; an emergent one is not.
 */
export function compatFiles(cwd: string, home?: string): CompatFile[] {
  const base = home ?? os.homedir();
  return [
    { source: "grok", file: path.join(base, ".grok", "config.toml") },
    { source: "grok", file: path.join(cwd, ".grok", "config.toml") },
    { source: "claude", file: path.join(base, ".claude.json") },
    { source: "mcp.json", file: path.join(cwd, ".mcp.json") },
    { source: "cursor", file: path.join(base, ".cursor", "mcp.json") },
    { source: "cursor", file: path.join(cwd, ".cursor", "mcp.json") },
  ];
}

/** `{"mcpServers": {...}}` — Cursor, `.mcp.json`, and Claude's top level. */
function readMcpServersShape(file: string, text: string): CompatServers {
  let parsed: unknown;
  try {
    parsed = parseJsonTolerant(text);
  } catch (error) {
    return {
      servers: {},
      problems: [{ file, message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { servers: {}, problems: [{ file, message: "must be a JSON object" }] };
  }
  const block = (parsed as { mcpServers?: unknown }).mcpServers;
  if (block === undefined) {
    // NOT a problem. A `.cursor/mcp.json` with no `mcpServers` is a
    // valid Cursor config that simply configures no servers, and
    // reporting it would put a warning in front of every operator who
    // has Cursor installed and no MCP set up in it.
    return { servers: {}, problems: [] };
  }
  return collectEntries(file, block);
}

/** Claude also keys servers per project under `projects.<cwd>.mcpServers`. */
function readClaude(file: string, text: string, cwd: string): CompatServers {
  const top = readMcpServersShape(file, text);
  let parsed: unknown;
  try {
    parsed = parseJsonTolerant(text);
  } catch {
    return top; // already reported by the call above
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
    return top;
  }
  // The project block for THIS cwd only. Reading every project's servers
  // would hand the operator a list of things configured for directories
  // they are not in.
  const forCwd = (projects as Record<string, unknown>)[cwd];
  if (typeof forCwd !== "object" || forCwd === null) return top;
  const nested = collectEntries(file, (forCwd as { mcpServers?: unknown }).mcpServers);
  return {
    // Project-scoped beats the top level, within the same file.
    servers: { ...top.servers, ...nested.servers },
    problems: [...top.problems, ...nested.problems],
  };
}

/** Validate and collect a `{name: entry}` block from any compat shape. */
function collectEntries(file: string, block: unknown): CompatServers {
  if (block === undefined) return { servers: {}, problems: [] };
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return { servers: {}, problems: [{ file, message: "`mcpServers` must be an object keyed by name" }] };
  }
  // `Object.create(null)` for the same reason `parseConfigFile` uses it:
  // a server named `__proto__` otherwise hits `Object.prototype`'s setter
  // and the file loads with zero problems and zero servers.
  const servers: Record<string, McpServerEntry> = Object.create(null) as Record<string, McpServerEntry>;
  const problems: McpConfigProblem[] = [];
  for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push({ file, message: `server "${name}" must be an object` });
      continue;
    }
    servers[name] = value as McpServerEntry;
  }
  return { servers, problems };
}

/**
 * Grok's `[mcp_servers.NAME]` tables, from the SUBSET of TOML they use.
 *
 * Deliberately not a TOML library. Adding one to the runtime bundle for
 * one optional compat source that most operators do not have is a poor
 * trade, and the shape Grok writes is small: table headers, string,
 * boolean and integer scalars, and arrays of strings.
 *
 * The rule that makes a partial parser safe rather than reckless: it
 * REFUSES what it does not understand, with the line number, instead of
 * guessing. A parser that silently ignores a line it cannot read is how
 * a server's `args` go missing and the command runs with the wrong
 * arguments — which is worse than not reading the file at all.
 */
export function parseGrokToml(file: string, text: string): CompatServers {
  const servers: Record<string, McpServerEntry> = Object.create(null) as Record<string, McpServerEntry>;
  const problems: McpConfigProblem[] = [];

  let current: Record<string, unknown> | undefined;

  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const lineNo = index + 1;
    const line = stripComment(rawLine).trim();
    if (line === "") continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const parts = (header[1] as string).split(".").map((p) => p.trim().replace(/^"(.*)"$/, "$1"));
      if (parts[0] !== "mcp_servers") {
        // Another section of Grok's config entirely. Skipped on purpose,
        // and not a problem: this reader claims only `[mcp_servers.*]`.
        current = undefined;
        continue;
      }
      const name = parts[1];
      if (name === undefined || name === "") {
        problems.push({ file, message: `line ${lineNo}: [mcp_servers] needs a server name` });
        current = undefined;
        continue;
      }
      const subTable = parts[2];
      const existing = servers[name];
      current = (existing as Record<string, unknown> | undefined) ?? {};
      servers[name] = current as McpServerEntry;
      if (subTable !== undefined) {
        const nested = (current[subTable] as Record<string, unknown> | undefined) ?? {};
        current[subTable] = nested;
        current = nested;
      }
      continue;
    }

    if (current === undefined) {
      // A key outside any `[mcp_servers.*]` table. Not ours.
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (pair === null) {
      problems.push({ file, message: `line ${lineNo}: cannot read "${line}" as a TOML key/value` });
      continue;
    }
    const value = parseScalar(pair[2] as string);
    if (value === undefined) {
      problems.push({
        file,
        message: `line ${lineNo}: value for "${pair[1] as string}" is a TOML form this reader does not support (${pair[2] as string})`,
      });
      continue;
    }
    current[pair[1] as string] = value;
  }
  return { servers, problems };
}

/** `#` starts a comment, unless it is inside a quoted string. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") quoted = !quoted;
    if (ch === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

/** A string, boolean, integer or array of strings. Anything else: undefined. */
function parseScalar(raw: string): string | boolean | number | string[] | undefined {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  const str = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (str !== null) return unescapeToml(str[1] as string);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    const items: string[] = [];
    for (const part of splitTopLevel(inner)) {
      const item = /^"((?:[^"\\]|\\.)*)"$/.exec(part.trim());
      // An array that is not all strings is refused wholesale rather
      // than partially read: half an `args` list is worse than none.
      if (item === null) return undefined;
      items.push(unescapeToml(item[1] as string));
    }
    return items;
  }
  return undefined;
}

function unescapeToml(value: string): string {
  return value.replace(/\\(.)/g, (_m, ch: string) =>
    ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch,
  );
}

/** Split on commas that are not inside a quoted string. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail !== "") parts.push(tail);
  return parts;
}

/** Read one compat file. Absent is silence; unreadable is a problem. */
export function readCompatFile(entry: CompatFile, cwd: string): CompatServers {
  const read = readConfigFile(entry.file);
  if (!read.ok) {
    return isDefiniteAbsence(read.reason)
      ? { servers: {}, problems: [] }
      : { servers: {}, problems: [{ file: entry.file, message: `could not be read (${read.reason})` }] };
  }
  if (entry.source === "grok") return parseGrokToml(entry.file, read.text);
  if (entry.source === "claude") return readClaude(entry.file, read.text, cwd);
  return readMcpServersShape(entry.file, read.text);
}
