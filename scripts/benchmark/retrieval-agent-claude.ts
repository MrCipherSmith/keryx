// The real agent adapter: `claude -p --output-format stream-json`.
//
// Streaming rather than the plain JSON result, because the plain form carries
// only totals. Tool-call counts and steps-to-first-gold need the individual
// events, and steps-to-first-gold is the metric closest to what a person means
// by "it got oriented quickly".
//
// Both arms get the SAME tool roster. keryx's advantage, if it has one, must
// come from the context files being present — not from being handed tools the
// other arm does not have. The `keryx` binary is on PATH for both; in
// `context-off` it simply has no workspace to read.

import type { AgentAnswer, AgentPort } from "./retrieval-run";
import { LEGACY_HARNESS } from "./retrieval-scoring";

/**
 * The id this adapter records on every result.
 *
 * Deliberately the same constant `loadResults` uses for a line with no harness
 * field: every such line was written before the field existed, when this was
 * the only adapter there was.
 */
export const CLAUDE_HARNESS = LEGACY_HARNESS;

export interface ClaudeAgentOptions {
  /** Wall-clock ceiling per arm. A hung run must not stall a fifty-task sweep. */
  readonly timeoutMs?: number;
  readonly allowedTools?: readonly string[];
}

interface StreamUsage {
  readonly input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly output_tokens?: number;
}

/**
 * Context tokens as the pre-registration defines them: everything the model
 * read, cache included.
 *
 * Counting `input_tokens` alone would report single digits for both arms — a
 * four-word prompt measured 2 input against 43,000 cached — and the threshold's
 * cost condition would pass unconditionally.
 */
export function contextTokensOf(usage: StreamUsage | undefined): number {
  if (usage === undefined) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export interface ParsedStream {
  readonly text: string;
  readonly toolCalls: number;
  readonly contextTokens: number;
  readonly costUsd: number;
  readonly stepsToFirstGold: number | null;
  readonly isError: boolean;
}

/**
 * Fold a stream-json transcript into the numbers the measurement needs.
 *
 * `stepsToFirstGold` counts tool calls until the agent first HAS a gold path in
 * hand — whether it named the path itself in a tool input, or a tool handed the
 * path back in its result.
 *
 * Inputs alone are not enough, and assuming they were is a mistake this metric
 * already made once. In the smoke run, the context-on arm scored 100% recall on
 * a task and still reported "never": it had asked the graph about a symptom and
 * received the paths in the answer, so no tool INPUT ever contained one. The
 * arm that navigates by query rather than by path was scored as never having
 * arrived. Counting only inputs systematically penalises exactly the behaviour
 * the measurement exists to detect.
 *
 * A malformed line is skipped rather than fatal. These transcripts interleave
 * several event kinds and gain new ones between releases, and a sweep that dies
 * on an unrecognised line would lose the whole run for a field nobody reads.
 */
export function parseStream(lines: readonly string[], gold: readonly string[]): ParsedStream {
  let toolCalls = 0;
  let stepsToFirstGold: number | null = null;
  let text = "";
  let contextTokens = 0;
  let costUsd = 0;
  let isError = false;

  const goldNames = gold.map((file) => file.toLowerCase());
  const namesGold = (value: unknown): boolean => {
    const serialized = JSON.stringify(value ?? {}).toLowerCase();
    return goldNames.some((name) => serialized.includes(name));
  };

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "assistant") {
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const entry = block as { type?: string; input?: unknown };
        if (entry.type !== "tool_use") continue;
        toolCalls += 1;
        if (stepsToFirstGold === null && namesGold(entry.input)) {
          stepsToFirstGold = toolCalls;
        }
      }
    }

    // Tool results arrive as `user` events. A result carrying a gold path means
    // the agent has it as of the call that produced it, which is the call count
    // standing now — the assistant event that issued it has already been seen.
    if (event.type === "user" && stepsToFirstGold === null && toolCalls > 0) {
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const entry = block as { type?: string; content?: unknown };
        if (entry.type !== "tool_result") continue;
        if (namesGold(entry.content)) {
          stepsToFirstGold = toolCalls;
          break;
        }
      }
    }

    if (event.type === "result") {
      text = typeof event.result === "string" ? event.result : "";
      contextTokens = contextTokensOf(event.usage as StreamUsage | undefined);
      costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;
      isError = event.is_error === true;
    }
  }

  return { text, toolCalls, contextTokens, costUsd, stepsToFirstGold, isError };
}

/**
 * The exact argv every arm is run with.
 *
 * Exported so the flags can be asserted rather than trusted. One of them was
 * missing for the whole of the smoke run, and nothing in the output said so —
 * see `--strict-mcp-config` below.
 */
export function buildClaudeArgs(
  prompt: string,
  model: string,
  allowedTools?: readonly string[],
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    // The worktree is a throwaway checkout of a commit that already exists;
    // there is nothing here to protect from the agent, and an approval prompt
    // in a headless sweep is a hang, not a safeguard.
    "--permission-mode",
    "bypassPermissions",
    // No user-global MCP servers. With no --mcp-config alongside it, none at
    // all — measured, not assumed: without this flag the init event reports 88
    // tools of which 59 are MCP, with it 29 and none.
    //
    // Among those 59 is a code-search server with its own index of the
    // repository. It reaches both arms equally, so it does not bias the
    // comparison — but handing the control arm a second retrieval system makes
    // "without keryx" mean something other than what it says, and the smoke run
    // was conducted that way without anyone noticing.
    //
    // The effect runs against keryx rather than for it, which is the safer
    // direction. A measurement should not need that excuse.
    "--strict-mcp-config",
  ];
  if (allowedTools !== undefined) {
    args.push("--allowed-tools", ...allowedTools);
  }
  return args;
}

/**
 * The port the operator's session-facts Stop hook posts transcripts to.
 *
 * That hook sends every finished session to a local bot, which extracts durable
 * project facts into the operator's memory. A sweep is two sessions per task —
 * 126 across the two planned runs — all of them about throwaway checkouts in
 * /tmp. His memory would fill with facts about temporary directories.
 *
 * Pointing the port at a closed one in the CHILD's environment makes the hook's
 * `curl -sf … || true` fail and do nothing. His settings are not touched, so
 * nothing has to be restored afterwards and nothing can be forgotten.
 *
 * The honest weakness: this depends on how that script happens to be written
 * today. If it stops reading PORT, this silently stops working, and the only
 * symptom is memory filling up again. It is not a substitute for removing the
 * hook — it is what can be done without editing a file that is not mine.
 */
const SESSION_HOOK_PORT_SINK = "1";

/**
 * The environment each arm is spawned with.
 *
 * Exported so the override is asserted rather than assumed — the same reason
 * `buildClaudeArgs` is. Both arms get exactly this, so it cannot favour either.
 */
export function buildClaudeEnv(
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) env[key] = value;
  }
  env.PORT = SESSION_HOOK_PORT_SINK;
  return env;
}

export function createClaudeAgent(options: ClaudeAgentOptions = {}): AgentPort {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return {
    harness: CLAUDE_HARNESS,
    async run({ cwd, prompt, model, gold }): Promise<AgentAnswer> {
      const args = buildClaudeArgs(prompt, model, options.allowedTools);

      const proc = Bun.spawn(["claude", ...args], {
        cwd,
        env: buildClaudeEnv(process.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      let stdout: string;
      try {
        stdout = await new Response(proc.stdout).text();
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }

      const parsed = parseStream(stdout.split("\n").filter(Boolean), gold);
      return interpretRun(parsed, { timedOut, timeoutMs, model, cwd });
    },
  };
}

/**
 * Turn a parsed transcript into an answer, or refuse to.
 *
 * Every refusal here exists for one reason: **a run that failed and a run that
 * searched honestly and found nothing both produce zero recall, and they mean
 * opposite things about the context under test.** Scoring the failures would
 * quietly credit whichever arm crashed less often.
 *
 * The `is_error` case was guarded from the start. Two others were not:
 *
 *  - A killed process emits no `result` event, so the transcript parses to
 *    empty text. A twelve-minute timeout in a five-hour sweep would have been
 *    recorded as a confident zero.
 *  - A transcript that simply ends without a final answer, for any other
 *    reason, is the same shape.
 *
 * Separated from the spawn so it can be tested without paying for a model or
 * waiting out a real timeout.
 */
export function interpretRun(
  parsed: ParsedStream,
  context: { timedOut: boolean; timeoutMs: number; model: string; cwd: string },
): AgentAnswer {
  if (context.timedOut) {
    throw new Error(
      `claude exceeded ${Math.round(context.timeoutMs / 1000)}s for model ${context.model} in ${context.cwd}`,
    );
  }
  if (parsed.isError) {
    throw new Error(`claude reported an error for model ${context.model} in ${context.cwd}`);
  }
  if (parsed.text.trim().length === 0) {
    throw new Error(`claude produced no final answer for model ${context.model} in ${context.cwd}`);
  }
  return {
    text: parsed.text,
    toolCalls: parsed.toolCalls,
    contextTokens: parsed.contextTokens,
    costUsd: parsed.costUsd,
    stepsToFirstGold: parsed.stepsToFirstGold,
  };
}
