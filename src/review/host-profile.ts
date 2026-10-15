// Which agent host runs a review, and what that changes (flow 457, T7).
//
// A keryx shell kills a spawned reviewer child after 5 minutes, so a wave there stays at 60000 bytes. Claude Code's
// Agent subagents, Codex and other hosts have no such deadline, so their waves can carry more per dispatch. The
// slice manifest records the host and the wave budget it was cut for; everything downstream reads the manifest.

export const REVIEW_HOSTS = ["keryx-shell", "claude-code", "codex", "other"] as const;
export type ReviewHost = (typeof REVIEW_HOSTS)[number];

/** Wave budget per host. keryx shell: the 5-minute child deadline. Others: no deadline, so a larger wave. */
export const HOST_WAVE_BYTES: Readonly<Record<ReviewHost, number>> = {
  "keryx-shell": 60_000,
  "claude-code": 150_000,
  codex: 150_000,
  other: 150_000,
};

export function parseReviewHost(value: string | undefined): ReviewHost | undefined {
  if (value === undefined) return undefined;
  const wanted = value.trim().toLowerCase();
  return (REVIEW_HOSTS as readonly string[]).includes(wanted) ? (wanted as ReviewHost) : undefined;
}

/**
 * The host this process runs under, from its environment. A command a keryx shell ran carries `KERYX_TOOL_CALL=1`
 * (or the review system marker); Claude Code sets `CLAUDECODE=1`; Codex sets `CODEX_SANDBOX`/`CODEX_MANAGED_BY_*`.
 */
export function detectReviewHost(env: Readonly<Record<string, string | undefined>> = process.env): ReviewHost {
  if (env["KERYX_TOOL_CALL"] === "1" || env["KERYX_REVIEW_SYSTEM"] !== undefined || env["KERYX_AUTONOMOUS_ANSWERS_FILE"] !== undefined) return "keryx-shell";
  if (env["CLAUDECODE"] === "1" || env["CLAUDE_CODE_ENTRYPOINT"] !== undefined) return "claude-code";
  if (Object.keys(env).some((key) => key.startsWith("CODEX_") && env[key] !== undefined)) return "codex";
  return "other";
}

/** The default wave budget for `host`, never below the slice cap (a wave holds at least one slice). */
export function defaultWaveBytes(host: ReviewHost, maxBytes = 0): number {
  return Math.max(HOST_WAVE_BYTES[host], maxBytes);
}

/** Whether the host kills a reviewer child at a deadline (only the keryx shell does). */
export function hostHasChildDeadline(host: ReviewHost): boolean {
  return host === "keryx-shell";
}

/** Whether `host` gives commands a way to carry an environment variable to the children it spawns. */
export function hostPassesEnvToChildren(host: ReviewHost): boolean {
  return host === "keryx-shell";
}
