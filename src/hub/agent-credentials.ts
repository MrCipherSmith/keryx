import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { HubConfig, Principal } from "./contracts";
import { fail, sha256 } from "./domain";

type NamedCredential = { id: string; tokenDigest: string; projectIds: string[]; readOnly: boolean };
const MAX_BYTES = 64 * 1024;
const idPattern = /^[a-z][a-z0-9._-]{0,99}$/;
const projectPattern = /^[A-Za-z0-9._-]{1,200}$/;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }

// The path is operator configuration, never an API argument. Bound the read as
// well as the declared size, refuse links/FIFOs and require owner-only access.
function readCredentials(config: HubConfig): NamedCredential[] {
  if (config.agentCredentialsFile === undefined) return [];
  if (typeof config.agentCredentialsFile !== "string" || !config.agentCredentialsFile.trim()) throw new Error();
  let fd: number | undefined;
  try {
    fd = openSync(config.agentCredentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) throw new Error();
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error();
    const parsed: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!record(parsed) || !keys(parsed, ["agents"]) || !Array.isArray(parsed.agents) || parsed.agents.length > 128) throw new Error();
    const ids = new Set<string>(); const digests = new Set([config.operatorToken, config.agentToken, ...(config.reviewerToken ? [config.reviewerToken] : [])].map(sha256));
    const agents: NamedCredential[] = [];
    for (const value of parsed.agents) {
      if (!record(value) || !keys(value, ["id", "tokenDigest", "projectIds", "readOnly"]) ||
        typeof value.id !== "string" || !idPattern.test(value.id) || value.id === "connector" || ids.has(value.id) ||
        typeof value.tokenDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.tokenDigest) || digests.has(value.tokenDigest) ||
        !Array.isArray(value.projectIds) || value.projectIds.length > 100 || value.projectIds.some((id) => typeof id !== "string" || !projectPattern.test(id)) ||
        new Set(value.projectIds).size !== value.projectIds.length || (value.readOnly !== undefined && typeof value.readOnly !== "boolean")) throw new Error();
      ids.add(value.id); digests.add(value.tokenDigest);
      agents.push({ id: value.id, tokenDigest: value.tokenDigest, projectIds: value.projectIds, readOnly: value.readOnly === true });
    }
    return agents;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function validateAgentCredentialsConfiguration(config: HubConfig): void {
  try { readCredentials(config); } catch { throw new Error("Invalid Hub agent credentials configuration"); }
}

export function resolveNamedAgent(token: string, config: HubConfig): Principal | undefined {
  let agents: NamedCredential[];
  try { agents = readCredentials(config); } catch { fail(503, "agent-credentials-unavailable", "Hub agent credentials are unavailable"); }
  if (token.length < 32) return undefined;
  const digest = Buffer.from(sha256(token), "hex");
  const agent = agents.find((entry) => timingSafeEqual(digest, Buffer.from(entry.tokenDigest, "hex")));
  return agent ? { id: `agent:${agent.id}`, kind: "agent", role: "agent", projectIds: [...agent.projectIds], readOnly: agent.readOnly } : undefined;
}

export function authorizeAgentRequest(actor: Principal, path: string[], method: string): void {
  if (actor.kind !== "agent" || actor.projectIds === undefined) return;
  if (path[0] === "session") return;
  if (path[0] !== "projects" || (path.length === 1 && method !== "GET")) fail(403, "agent-scope-denied", "Agent project access denied");
  if (path[1] && !actor.projectIds.includes(path[1])) fail(403, "agent-scope-denied", "Agent project access denied");
  if (method !== "GET" && actor.readOnly) fail(403, "agent-read-only", "Agent is read-only");
}
