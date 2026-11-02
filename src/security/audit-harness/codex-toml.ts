// A small, dependency-free TOML-subset reader for `.codex/config.toml`'s
// `[mcp_servers.<name>]` tables — flow 308 (W8, T12).
//
// This module exists ONLY so `security/audit-harness` does not import
// `mcp-servers/compat.ts`'s `parseGrokToml`: audit-harness is a core-zone
// module and `mcp-servers` is a client-zone module, and a core owner
// reaching into a client module is exactly the layering violation
// `src/lib/import-policy.ts` catches. Codex writes a TOML subset close to
// (but not identical to — see below) what `parseGrokToml` understands, so
// rather than share code across the boundary, this file re-implements the
// small piece audit-harness actually needs.
//
// Understood: `[mcp_servers.<name>]` and `[mcp_servers."<name>"]` table
// headers, and `command = "..."` / `args = [ "...", ... ]` key/value pairs
// inside them, including a MULTI-LINE array — `parseGrokToml` deliberately
// refuses those (a value it cannot read poisons the whole server), but a
// real `.codex/config.toml` written by hand commonly wraps a long `args`
// list across several lines, and treating that ordinary shape as
// "unreadable" would make this checker useless on the configs it exists to
// check. `#` starts a comment unless inside a quoted string.
//
// The rule that makes a partial parser safe rather than reckless, carried
// over from `parseGrokToml`: it REFUSES what it does not understand,
// naming the line, instead of guessing. There is no per-server poisoning
// here — a single line this reader cannot read fails the WHOLE file, which
// the caller reports as unreadable/error, never as "scanned clean". A
// partly-read launcher config that comes back clean is worse than one
// flagged as not scanned at all.

export type CodexTomlServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Line number (1-based) of this server's `[mcp_servers.<name>]` header. */
  readonly line: number;
};

export type CodexTomlResult =
  | { readonly ok: true; readonly servers: readonly CodexTomlServer[] }
  | { readonly ok: false; readonly error: string };

type RawServer = {
  name: string;
  line: number;
  command?: string;
  args?: string[];
};

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

/** Index of the first unquoted `]` in `text`, or -1. */
function findUnquotedClose(text: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") quoted = !quoted;
    if (ch === "]" && !quoted) return i;
  }
  return -1;
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

function unescapeToml(value: string): string {
  return value.replace(/\\(.)/g, (_m, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch));
}

/** An array of quoted strings only — the one array shape this subset supports. */
function parseStringArray(inner: string): string[] | undefined {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  const items: string[] = [];
  for (const part of splitTopLevel(trimmed)) {
    const match = /^"((?:[^"\\]|\\.)*)"$/.exec(part.trim());
    if (match === null) return undefined;
    items.push(unescapeToml(match[1] as string));
  }
  return items;
}

/** A quoted string, boolean, or integer scalar. Anything else: undefined. */
function parseScalar(raw: string): string | boolean | number | undefined {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (match !== null) return unescapeToml(match[1] as string);
  return undefined;
}

/** Split on commas outside quotes and outside nested `[]` / `{}`. */
function splitDepthAware(inner: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail !== "") parts.push(tail);
  return parts;
}

/** A dotted key path of bare or quoted segments (`a."b c".d`), or undefined. */
function parseKeyPath(text: string): string[] | undefined {
  const segments: string[] = [];
  let rest = text.trim();
  for (;;) {
    const m = /^(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\s*/.exec(rest);
    if (m === null) return undefined;
    segments.push(m[1] !== undefined ? unescapeToml(m[1]) : (m[2] as string));
    rest = rest.slice(m[0].length);
    if (rest === "") return segments;
    if (!rest.startsWith(".")) return undefined;
    rest = rest.slice(1).trimStart();
  }
}

/** Index of the `=` that ends the key in `key = value` (outside quotes), or -1. */
function findKeyEquals(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") quoted = !quoted;
    if (ch === "=" && !quoted) return i;
  }
  return -1;
}

/**
 * Apply one `command` / `args` field to a server. Other fields are validated
 * as a scalar, array or inline table and ignored. Returns an error or undefined.
 */
function applyField(server: RawServer, key: string, valueText: string): string | undefined {
  const value = valueText.trim();
  if (value.startsWith("[")) {
    const closeAt = findUnquotedClose(value);
    if (closeAt === -1 || value.slice(closeAt + 1).trim() !== "") return `value for "${key}" is not a single-line array`;
    const parsed = parseStringArray(value.slice(1, closeAt));
    if (parsed === undefined) return `value for "${key}" is not an array of strings this reader supports`;
    if (key === "command") return '"command" must be a string, not an array';
    if (key === "args") server.args = parsed;
    return undefined;
  }
  if (value.startsWith("{")) {
    if (key === "command" || key === "args") return `"${key}" must not be a table`;
    return value.endsWith("}") ? undefined : `value for "${key}" is an inline table this reader cannot read`;
  }
  const scalar = parseScalar(value);
  if (scalar === undefined) return `value for "${key}" is a TOML form this reader does not support (${value})`;
  if (key === "command") {
    if (typeof scalar !== "string") return '"command" must be a string';
    server.command = scalar;
  }
  return undefined;
}

/** Fields of one inline table (`{ command = "npx", args = [...] }`) onto `server`. */
function applyInlineServer(server: RawServer, table: string): string | undefined {
  const text = table.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return `"${server.name}" is not an inline table this reader understands`;
  for (const entry of splitDepthAware(text.slice(1, -1))) {
    const eq = findKeyEquals(entry);
    const path = eq === -1 ? undefined : parseKeyPath(entry.slice(0, eq));
    if (path === undefined || path.length !== 1) return `cannot read "${entry.trim()}" as a key/value in "${server.name}"`;
    const error = applyField(server, path[0] as string, entry.slice(eq + 1));
    if (error !== undefined) return error;
  }
  return undefined;
}

const HEADER = /^\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\]$/;

/**
 * Parse a `.codex/config.toml`-shaped file's `[mcp_servers.*]` tables.
 *
 * Whole-file result, not per-server: any line this reader cannot read —
 * inside or outside a server table — fails the file rather than the one
 * server, so the caller never has to decide whether a partial read is
 * trustworthy.
 */
export function parseCodexToml(text: string): CodexTomlResult {
  const servers = new Map<string, RawServer>();
  const order: string[] = [];
  let current: RawServer | undefined;
  // Before the first table header, keys sit at the document root, where TOML
  // lets `mcp_servers.<name>.command = ...` and `mcp_servers = { ... }` define servers.
  let atRoot = true;
  const serverFor = (name: string, line: number): RawServer => {
    const existing = servers.get(name);
    if (existing) return existing;
    const created: RawServer = { name, line };
    servers.set(name, created);
    order.push(name);
    return created;
  };

  // Multi-line array accumulation state, for `key = [` with no closing
  // `]` on the same line.
  let pendingKey: string | undefined;
  let pendingServer: RawServer | undefined;
  let pendingBuffer = "";
  let pendingStartLine = 0;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const stripped = stripComment(lines[index] as string);

    if (pendingKey !== undefined) {
      const closeAt = findUnquotedClose(stripped);
      if (closeAt === -1) {
        pendingBuffer += `${stripped}\n`;
        continue;
      }
      pendingBuffer += stripped.slice(0, closeAt);
      const trailing = stripped.slice(closeAt + 1).trim();
      if (trailing !== "") {
        return { ok: false, error: `line ${lineNo}: unexpected content after "]" (${trailing})` };
      }
      const parsedArray = parseStringArray(pendingBuffer);
      if (parsedArray === undefined) {
        return {
          ok: false,
          error: `line ${pendingStartLine}: value for "${pendingKey}" is not an array of strings this reader supports`,
        };
      }
      if (pendingServer && pendingKey === "command") {
        // An array assigned to `command` is nonsense, but not ours to
        // interpret further than "unsupported": refuse rather than guess.
        return { ok: false, error: `line ${pendingStartLine}: "command" must be a string, not an array` };
      }
      if (pendingServer && pendingKey === "args") {
        pendingServer.args = parsedArray;
      }
      pendingKey = undefined;
      pendingServer = undefined;
      pendingBuffer = "";
      continue;
    }

    const trimmed = stripped.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("[")) {
      atRoot = false;
      const header = HEADER.exec(trimmed);
      if (header !== null) {
        const name = header[1] ?? header[2];
        if (name === undefined || name === "") {
          return { ok: false, error: `line ${lineNo}: "${trimmed}" needs a server name` };
        }
        const existing = servers.get(name);
        if (existing) {
          current = existing;
        } else {
          current = { name, line: lineNo };
          servers.set(name, current);
          order.push(name);
        }
        continue;
      }
      if (/^\[\[.*\]\]$/.test(trimmed)) {
        if (/^\[\[\s*mcp_servers\b/.test(trimmed)) {
          return { ok: false, error: `line ${lineNo}: "${trimmed}" is not a table header this reader understands` };
        }
        // An array-of-tables section outside `mcp_servers` — not ours.
        current = undefined;
        continue;
      }
      if (/^\[\s*mcp_servers\b/.test(trimmed)) {
        // `[mcp_servers]` itself, or a sub-table like `[mcp_servers.x.env]` —
        // both outside the `[mcp_servers.<name>]` shape this reader claims.
        return { ok: false, error: `line ${lineNo}: "${trimmed}" is not a table header this reader understands` };
      }
      // Some other top-level table (e.g. `[model_providers.foo]`,
      // `[shell_environment_policy]`). Not ours: close the current table
      // and move on without complaint.
      current = undefined;
      continue;
    }

    let target = current;
    let kv: { key: string; valueText: string } | undefined;
    if (current === undefined) {
      if (!atRoot) continue; // A key under a foreign table. Not ours.
      const eq = findKeyEquals(trimmed);
      const path = eq === -1 ? undefined : parseKeyPath(trimmed.slice(0, eq));
      if (path === undefined) {
        if (/^"?mcp_servers"?\s*[.=]/.test(trimmed)) {
          return { ok: false, error: `line ${lineNo}: cannot read "${trimmed}" as a TOML key/value` };
        }
        continue;
      }
      if (path[0] !== "mcp_servers") continue; // A root key that is not ours.
      const valueText = trimmed.slice(eq + 1).trim();
      if (path.length === 1) {
        // `mcp_servers = { name = { command = ... }, ... }`
        if (!valueText.startsWith("{") || !valueText.endsWith("}")) {
          return { ok: false, error: `line ${lineNo}: "mcp_servers" is not an inline table this reader understands` };
        }
        for (const entry of splitDepthAware(valueText.slice(1, -1))) {
          const innerEq = findKeyEquals(entry);
          const innerPath = innerEq === -1 ? undefined : parseKeyPath(entry.slice(0, innerEq));
          if (innerPath === undefined || innerPath.length !== 1) {
            return { ok: false, error: `line ${lineNo}: cannot read "${entry.trim()}" as an mcp_servers entry` };
          }
          const error = applyInlineServer(serverFor(innerPath[0] as string, lineNo), entry.slice(innerEq + 1));
          if (error !== undefined) return { ok: false, error: `line ${lineNo}: ${error}` };
        }
        continue;
      }
      const server = serverFor(path[1] as string, lineNo);
      if (path.length === 2) {
        // `mcp_servers.name = { command = ... }`
        const error = applyInlineServer(server, valueText);
        if (error !== undefined) return { ok: false, error: `line ${lineNo}: ${error}` };
        continue;
      }
      if (path.length > 3) continue; // e.g. `mcp_servers.x.env.KEY = "v"`: not command/args.
      target = server;
      kv = { key: path[2] as string, valueText };
    } else {
      const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(trimmed);
      if (pair === null) {
        return { ok: false, error: `line ${lineNo}: cannot read "${trimmed}" as a TOML key/value` };
      }
      kv = { key: pair[1] as string, valueText: (pair[2] as string).trim() };
    }
    const { key, valueText } = kv;
    if (valueText.startsWith("[")) {
      const closeAt = findUnquotedClose(valueText);
      if (closeAt === -1) {
        pendingKey = key;
        pendingServer = target;
        pendingBuffer = `${valueText.slice(1)}\n`;
        pendingStartLine = lineNo;
        continue;
      }
      const trailing = valueText.slice(closeAt + 1).trim();
      if (trailing !== "") {
        return { ok: false, error: `line ${lineNo}: unexpected content after "]" (${trailing})` };
      }
      const parsedArray = parseStringArray(valueText.slice(1, closeAt));
      if (parsedArray === undefined) {
        return { ok: false, error: `line ${lineNo}: value for "${key}" is not an array of strings this reader supports` };
      }
      if (key === "args" && target) target.args = parsedArray;
      continue;
    }

    const scalar = parseScalar(valueText);
    if (scalar === undefined) {
      return { ok: false, error: `line ${lineNo}: value for "${key}" is a TOML form this reader does not support (${valueText})` };
    }
    if (key === "command") {
      if (typeof scalar !== "string") {
        return { ok: false, error: `line ${lineNo}: "command" must be a string` };
      }
      if (target) target.command = scalar;
    }
    // Other keys (e.g. `env`, `startup_timeout_ms`) are read and validated
    // as a scalar, then ignored: audit-harness only needs `command`/`args`.
  }

  if (pendingKey !== undefined) {
    return { ok: false, error: `line ${pendingStartLine}: array for "${pendingKey}" was never closed with "]"` };
  }

  const result: CodexTomlServer[] = order.map((name) => {
    const raw = servers.get(name) as RawServer;
    return { name: raw.name, command: raw.command ?? "", args: raw.args ?? [], line: raw.line };
  });
  return { ok: true, servers: result };
}
