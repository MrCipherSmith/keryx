// Flow 389: the configuration block of the scheduled digest.
//
// The digest is NOT a second scheduler. It is a flow 295 `agent-task` schedule
// entry that carries one extra optional block, `action.digest`. Because
// `confirmedHash` is an HMAC over the whole stored action
// (`scheduleContentCanonical`), the block is covered by the operator's
// confirmation like every other field: editing the topic or the memory limit
// behind an installed timer makes the entry refuse to run (`grants-changed`).
//
// What is configured where:
//   - repositories  `action.grants.repos` (the existing allowed-repo list)
//   - schedule      `on.cron`
//   - topic         `action.digest.topic`
//   - dollar limit  `action.dispatch.ceilingUsd`
//   - timeout       `action.dispatch.maxSeconds`
//   - memory limit  `action.digest.memoryLimitMb`
//
// Pure: no I/O.

import { DIGEST_TOOL_IDS } from "./granted-tools";

/** The service topic the digest goes to when the project has no remote session. */
export const DIGEST_DEFAULT_TOPIC = "Digest";
/** The repository a first-version digest watches. More are config (`grants.repos`). */
export const DIGEST_DEFAULT_REPOS: readonly string[] = ["MrCipherSmith/keryx"];
/** Default ceiling of one run's resident-memory growth, in MiB. */
export const DIGEST_DEFAULT_MEMORY_MB = 512;

const TOPIC_MAX = 128;
const MEMORY_MIN_MB = 64;
const MEMORY_MAX_MB = 16_384;

export interface DigestConfig {
  /** Name of the service topic used when the project has no remote session. */
  readonly topic: string;
  /** A run whose resident memory grows by more than this since it started is stopped and reported. */
  readonly memoryLimitMb: number;
}

export function defaultDigestConfig(): DigestConfig {
  return { topic: DIGEST_DEFAULT_TOPIC, memoryLimitMb: DIGEST_DEFAULT_MEMORY_MB };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every problem with a raw `action.digest` block; empty means valid. `undefined` (no block) is valid. */
export function digestConfigProblems(raw: unknown, grants: { readonly tools?: unknown; readonly repos?: unknown } | undefined): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ["action.digest: must be an object { topic?, memoryLimitMb? }"];
  const problems: string[] = [];
  const known = new Set(["topic", "memoryLimitMb"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push(`action.digest.${key}: unknown field (known: topic, memoryLimitMb)`);
  }
  const topic = raw["topic"];
  if (topic !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof topic !== "string" || topic.trim().length === 0 || topic.length > TOPIC_MAX || /[\u0000-\u001f\u007f]/.test(topic)) {
      problems.push(`action.digest.topic: must be a 1-${TOPIC_MAX} character name without control characters`);
    }
  }
  const memory = raw["memoryLimitMb"];
  if (memory !== undefined) {
    if (typeof memory !== "number" || !Number.isInteger(memory) || memory < MEMORY_MIN_MB || memory > MEMORY_MAX_MB) {
      problems.push(`action.digest.memoryLimitMb: must be an integer between ${MEMORY_MIN_MB} and ${MEMORY_MAX_MB}`);
    }
  }
  // The digest reads GitHub through read-only catalogue tools only, and only in listed repositories.
  const tools = Array.isArray(grants?.tools) ? (grants?.tools as unknown[]) : [];
  for (const tool of tools) {
    if (typeof tool === "string" && !DIGEST_TOOL_IDS.includes(tool)) {
      problems.push(`action.digest: grants.tools "${tool}" is not a digest tool (allowed: ${DIGEST_TOOL_IDS.join(", ")})`);
    }
  }
  const repos = Array.isArray(grants?.repos) ? (grants?.repos as unknown[]) : [];
  if (repos.length === 0) problems.push("action.digest: grants.repos must list at least one repository to watch");
  return problems;
}

/** Fill the defaults of a (validated) block. */
export function normalizeDigestConfig(raw: unknown): DigestConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const defaults = defaultDigestConfig();
  return {
    topic: typeof raw["topic"] === "string" ? raw["topic"].trim() : defaults.topic,
    memoryLimitMb: typeof raw["memoryLimitMb"] === "number" ? raw["memoryLimitMb"] : defaults.memoryLimitMb,
  };
}
