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
import type { ResolvedMcpServer } from "./config";

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
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** The key a decision is filed under: the file it came from, plus the name. */
export function trustKey(server: ResolvedMcpServer): string {
  return `${server.file}::${server.name}`;
}

export function loadTrustStore(configDir?: string): Record<string, string> {
  const read = readConfigFile(trustFile(configDir));
  if (!read.ok) return {};
  try {
    const parsed = JSON.parse(read.text) as McpTrustStore;
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
  if (server.source !== "project") return false;
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
  if (raw.url !== undefined && raw.url.length > 0) return raw.url;
  return [raw.command, ...(raw.args ?? [])].filter(Boolean).join(" ");
}
