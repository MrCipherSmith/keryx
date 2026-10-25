import path from "node:path";
import { runAgentTurn, type AgentDeps } from "../../commands/agent";
import type { ProbeSession } from "../../learning/probe";
import type { ProbeTask } from "../../learning/probe-schema";
import { builtinReadOnlyTools } from "../tool/builtin/interactive-tools";
import { makeProvider } from "../provider/make-provider";
import type { NormalizedMessage, ProviderPort } from "../provider/types";
import { loadModelProfiles, profileKey } from "../routing/model-profile";
import { createProbeGitPort } from "./git-port";
import { executeProbe, type ProbeTurnInput, type ProbeTurnResult } from "./runner";

export const PROBE_BASELINE = "Investigate this repository with read-only tools. Return only FILE: <relative-path> SYMBOL: <symbol>.";
const REQUEST_LIMIT = 4;
const INPUT_BYTES = 32768;
const OUTPUT_TOKENS = 1024;
export interface ProbePrices { input: number; output: number }
export function probeReservationUsd(prices: ProbePrices | undefined): number {
  if (!prices || !Number.isFinite(prices.input) || !Number.isFinite(prices.output)
    || prices.input < 0 || prices.output < 0) return Infinity;
  // Byte-sized input bound plus provider framing slack, across ALL attempts.
  return Math.max(0.000001, 1.1 * REQUEST_LIMIT * (65536 * prices.input + OUTPUT_TOKENS * prices.output) / 1e6);
}
export function probePrices(provider: string, model: string): ProbePrices | undefined {
  const profile = loadModelProfiles()[profileKey(provider, model)];
  const input = profile?.priceInputPerMillion.value;
  const output = profile?.priceOutputPerMillion.value;
  return typeof input === "number" && typeof output === "number" ? { input, output } : undefined;
}
export class ProbeTurnLimitError extends Error {
  readonly code = "PROBE_TURN_LIMIT";
}
/** Count attempts, including retries, at the last boundary before network I/O. */
export function boundedProbeProvider(provider: ProviderPort): ProviderPort {
  let requests = 0;
  return {
    describe: () => provider.describe(),
    async *stream(request, options) {
      if (++requests > REQUEST_LIMIT || Buffer.byteLength(JSON.stringify(request), "utf8") > INPUT_BYTES
        || request.budget.maxOutputTokens > OUTPUT_TOKENS)
        throw new ProbeTurnLimitError("Probe request exceeded its reserved bounds");
      yield* provider.stream(request, options);
    },
  };
}
export const PROBE_TURN_TIMEOUT_MS = 120_000;
export class ProbeTurnFailedError extends Error {
  readonly code = "PROBE_TURN_FAILED";
}
export interface NativeProbeTurnOptions { provider?: ProviderPort; timeoutMs?: number }
export async function nativeProbeTurn(input: ProbeTurnInput, providerId: string, modelId: string,
  options: NativeProbeTurnOptions = {}): Promise<ProbeTurnResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TURN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ProbeTurnFailedError("Invalid probe deadline");
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  // Abort before headers and during streaming; await settlement before cleanup.
  // A Promise.race would leave a paid request running after worktree removal.
  try {
    if (controller.signal.aborted) throw new ProbeTurnFailedError("Probe was cancelled");
    const bounded = boundedProbeProvider(options.provider ?? makeProvider(providerId, modelId, { fetch }));
    let terminalSeen = false;
    let streamFailed = false;
    const provider: ProviderPort = {
      describe: () => bounded.describe(),
      async *stream(request, streamOptions) {
        terminalSeen = false;
        try {
          for await (const event of bounded.stream(request, streamOptions)) {
            if (event.kind === "provider_error") streamFailed = true;
            if (event.kind === "model_end") terminalSeen = true;
            yield event;
          }
        } catch (error) { streamFailed = true; throw error; }
        finally { if (!terminalSeen) streamFailed = true; }
      },
    };
    const events: unknown[] = [];
    const history: NormalizedMessage[] = [];
    let sequence = 0;
    const deps: AgentDeps = { provider, providerId, modelId,
      tools: builtinReadOnlyTools(input.root), systemInstruction: input.instructions,
      idSeq: () => `probe-${input.arm}-${input.seed}-${++sequence}`,
      maxRounds: REQUEST_LIMIT, maxToolCalls: 12, maxOutputTokens: OUTPUT_TOKENS,
      unattended: true, planFollowThrough: false };
    const result = await runAgentTurn({ write: () => undefined,
      onUsage: (usage) => events.push({ type: "usage", usage }),
      onToolCall: (name, args) => events.push({ type: "tool-call", name, args }),
      onToolResult: (name, result) => events.push({ type: "tool-result", name, result }),
      onSystem: (message) => events.push({ type: "system", message }),
    }, deps, history, input.prompt, { signal: controller.signal });
    const last = history.at(-1);
    if (controller.signal.aborted || result.finishReason !== undefined || streamFailed || !terminalSeen
      || last?.role !== "assistant" || (last.toolCalls?.length ?? 0) > 0 || !last.content.trim()) {
      throw new ProbeTurnFailedError("Probe did not complete a terminal text answer");
    }
    return { answer: last.content, events };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
export async function runNativeProbe(session: ProbeSession, task: ProbeTask | undefined) {
  const { provider, model, commit } = session.plan.environment;
  const port = createProbeGitPort({ repoRoot: session.root,
    worktreesDir: path.join(session.root, ".metaproject/data/learning/probes/worktrees"),
    probeId: session.plan.probeId, commit,
    turn: (input) => nativeProbeTurn(input, provider, model) });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await executeProbe(session, task, port, { baseline: PROBE_BASELINE,
      reservationUsd: probeReservationUsd(probePrices(provider, model)), signal: controller.signal });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
