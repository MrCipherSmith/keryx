// The keryx adapter: `keryx shell --print --events-file`.
//
// This leg exists for a question the other two cannot answer. `claude` and
// `grok` differ in wrapper AND model at once, so a difference between them says
// nothing about either. keryx's x.ai provider and the grok CLI can drive the
// SAME model, and then the only variable left is the shell around it. The
// comparative ladder was abandoned in August precisely because no third-party
// harness would let the model be pinned.
//
// It reads the NDJSON transcript rather than the rendered output. Parsing a
// terminal rendering would measure the renderer, and would break on the next
// change to it.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentAnswer, AgentPort } from "./retrieval-run";

export const KERYX_HARNESS = "keryx";

export interface KeryxAgentOptions {
  /** Wall-clock ceiling per arm. */
  readonly timeoutMs?: number;
  /** The keryx provider id the model belongs to, e.g. `grok`. */
  readonly provider: string;
  /** `keryx` on PATH by default; a path to `src/cli.ts` under bun for a dev build. */
  readonly command?: readonly string[];
  /**
   * Per-field cap in the transcript.
   *
   * Raised well above the default because `stepsToFirstGold` is read from tool
   * inputs and results: a gold path clipped out of a long tool output is scored
   * as an arm that never held it, which is a measurement error and not a
   * smaller number. Redaction still runs first at any limit.
   */
  readonly maxField?: number;
}

export interface KeryxTurn {
  readonly text: string;
  readonly toolCalls: number;
  readonly inputTokens: number | null;
  readonly stepsToFirstGold: number | null;
  readonly errorMessage?: string;
  readonly sawTurnEnd: boolean;
  /** True when any field this metric reads was truncated before the first gold hit. */
  readonly clippedBeforeGold: boolean;
  /** Provider calls the turn made. `inputTokens` is a sum over exactly these. */
  readonly providerCalls: number;
}

const CLIP_MARK = " chars]";

/**
 * Fold the NDJSON transcript into the numbers the measurement needs.
 *
 * `stepsToFirstGold` counts tool calls until the agent first HELD a gold path,
 * whether it named one in a tool input or a tool handed one back — the same
 * definition the other adapters use, for the same reason: counting inputs alone
 * penalises exactly the behaviour a code graph is supposed to produce, where
 * the agent asks about a symptom and receives paths.
 *
 * `inputTokens` is summed over every `usage` event, one per provider call. It
 * previously read `turn_end.usage`, which is `lastUsage` in the shell — a plain
 * assignment on each call, so the LAST request won and a multi-call turn
 * reported one prompt. The claude and grok legs report the sum over a turn's
 * requests, so the two were never the same quantity: on a 25-tool-call task the
 * keryx leg understated its own context cost by an order of magnitude, in
 * keryx's favour, on the metric the cost half of the verdict is computed from.
 * `run-ablation-mutating.ts` already accumulates; this brings the retrieval leg
 * to the same convention.
 *
 * `turn_end.usage` remains a fallback for transcripts recorded before per-call
 * `usage` events existed. A turn that emitted neither still yields `null`,
 * which `interpretKeryxTurn` treats as a broken arm rather than a free one.
 */
export function parseKeryxEvents(lines: readonly string[], gold: readonly string[]): KeryxTurn {
  let text = "";
  let toolCalls = 0;
  let stepsToFirstGold: number | null = null;
  let errorMessage: string | undefined;
  let sawTurnEnd = false;
  let clippedBeforeGold = false;
  let providerCalls = 0;
  let summedInputTokens = 0;
  let sawInputTokenCount = false;
  let turnEndInputTokens: number | null = null;

  const goldNames = gold.map((file) => file.toLowerCase());
  const namesGold = (value: string): boolean => {
    const lowered = value.toLowerCase();
    return goldNames.some((name) => lowered.includes(name));
  };

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const noteClip = (value: string): void => {
      if (stepsToFirstGold === null && value.endsWith(CLIP_MARK)) clippedBeforeGold = true;
    };

    if (event.type === "tool_call") {
      toolCalls += 1;
      const input = typeof event.input === "string" ? event.input : "";
      if (stepsToFirstGold === null && namesGold(input)) stepsToFirstGold = toolCalls;
      noteClip(input);
    }
    if (event.type === "tool_result") {
      const output = typeof event.output === "string" ? event.output : "";
      if (stepsToFirstGold === null && toolCalls > 0 && namesGold(output)) stepsToFirstGold = toolCalls;
      noteClip(output);
    }
    if (event.type === "usage") {
      const usage = event.usage as { inputTokens?: unknown } | undefined;
      providerCalls += 1;
      if (typeof usage?.inputTokens === "number") {
        summedInputTokens += usage.inputTokens;
        sawInputTokenCount = true;
      }
    }
    if (event.type === "turn_end") {
      sawTurnEnd = true;
      text = typeof event.text === "string" ? event.text : "";
      toolCalls = typeof event.toolCalls === "number" ? event.toolCalls : toolCalls;
      const usage = event.usage as { inputTokens?: unknown } | undefined;
      turnEndInputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : null;
      if (typeof event.errorMessage === "string") errorMessage = event.errorMessage;
    }
  }

  // Calls that reported no number are not free calls. Falling back to the sum
  // would turn "we cannot say" into a zero, which is the failure the refusal in
  // `interpretKeryxTurn` exists to prevent.
  const inputTokens = sawInputTokenCount ? summedInputTokens : turnEndInputTokens;

  return {
    text,
    toolCalls,
    inputTokens,
    providerCalls,
    stepsToFirstGold,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    sawTurnEnd,
    clippedBeforeGold,
  };
}

/**
 * Turn a transcript into an answer, or refuse to.
 *
 * The refusals matter more here than on the other legs, because keryx has a
 * failure mode the others do not: asked for a provider whose credential is
 * missing, `makeProvider` silently returns an offline fake, and the session
 * header still names the provider that was requested. A sweep could complete
 * entirely against that fake and record its empty answers as a real negative
 * result — the arm would look like one that searched and found nothing.
 *
 * Two things separate the cases. A failed turn carries an error message, which
 * is now recorded on the event. And a fake provider reports no usage at all,
 * where a real one always does: absent usage is treated as a broken arm rather
 * than as an unknown cost, because on this harness it means the model never
 * ran.
 */
export function interpretKeryxTurn(
  turn: KeryxTurn,
  context: { timedOut: boolean; timeoutMs: number; model: string; cwd: string },
): AgentAnswer {
  if (context.timedOut) {
    throw new Error(
      `keryx exceeded ${Math.round(context.timeoutMs / 1000)}s for model ${context.model} in ${context.cwd}`,
    );
  }
  if (!turn.sawTurnEnd) {
    throw new Error(`keryx wrote no turn_end for model ${context.model} in ${context.cwd} — the turn did not finish`);
  }
  if (turn.errorMessage !== undefined) {
    throw new Error(`keryx reported an error for model ${context.model} in ${context.cwd}: ${turn.errorMessage}`);
  }
  if (turn.inputTokens === null) {
    throw new Error(
      `keryx reported no token usage for model ${context.model} in ${context.cwd} — ` +
        "on this harness that means no provider turn happened (a missing credential yields an offline fake), " +
        "and an arm that never called a model must not be scored",
    );
  }
  if (turn.text.trim().length === 0) {
    throw new Error(`keryx produced no final answer for model ${context.model} in ${context.cwd}`);
  }
  return {
    text: turn.text,
    toolCalls: turn.toolCalls,
    // Summed over the turn's provider calls, so it is the same SHAPE as the
    // other legs' input + cache_read + cache_creation over a turn's requests.
    //
    // What remains an assumption is the per-call quantity: keryx's
    // OpenAI-compatible path maps `prompt_tokens` to `inputTokens`, and
    // `NormalizedUsage` carries no cache fields, so if x.ai excludes a cached
    // prefix from `prompt_tokens` this leg still undercounts. That residual is
    // bounded by running one prompt through both this leg and the grok CLI and
    // comparing; an order of magnitude apart means the cost half is not
    // comparable and only recall is reportable.
    contextTokens: turn.inputTokens,
    // keryx does not price its own turns. Null, never zero: a zero understates
    // this leg's cost in the write-up while looking like a measurement.
    costUsd: null,
    // A gold path clipped out of a tool output would be scored as "never held
    // one", which is a different claim. Unknown is reported as unknown.
    stepsToFirstGold: turn.clippedBeforeGold && turn.stepsToFirstGold === null ? null : turn.stepsToFirstGold,
  };
}

export function buildKeryxArgs(
  prompt: string,
  model: string,
  provider: string,
  eventsFile: string,
  maxField: number,
): string[] {
  return [
    "shell",
    "--provider",
    provider,
    "--model",
    model,
    // The readline surface, one turn, no terminal to own.
    "--no-tui",
    "--print",
    prompt,
    // A throwaway checkout of a commit that already exists. An approval prompt
    // in a headless sweep is a hang, not a safeguard — and `auto` is what an
    // unattended keryx run means, which is the thing being compared.
    "--auto",
    "--events-file",
    eventsFile,
    "--events-max-field",
    String(maxField),
  ];
}

export function createKeryxAgent(options: KeryxAgentOptions): AgentPort {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const command = options.command ?? ["keryx"];
  const maxField = options.maxField ?? 200_000;

  return {
    harness: KERYX_HARNESS,
    async run({ cwd, prompt, model, gold }): Promise<AgentAnswer> {
      const dir = mkdtempSync(path.join(tmpdir(), "keryx-events-"));
      const eventsFile = path.join(dir, "events.jsonl");
      try {
        const args = buildKeryxArgs(prompt, model, options.provider, eventsFile, maxField);
        const proc = Bun.spawn([...command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
        try {
          await new Response(proc.stdout).text();
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }

        const lines = existsSync(eventsFile)
          ? readFileSync(eventsFile, "utf8").split("\n").filter((line) => line.trim().length > 0)
          : [];
        return interpretKeryxTurn(parseKeryxEvents(lines, gold), { timedOut, timeoutMs, model, cwd });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
