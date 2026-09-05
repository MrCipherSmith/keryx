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

interface ParsedStream {
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

export function createClaudeAgent(options: ClaudeAgentOptions = {}): AgentPort {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return {
    async run({ cwd, prompt, model, gold }): Promise<AgentAnswer> {
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        // The worktree is a throwaway checkout of a commit that already exists;
        // there is nothing here to protect from the agent, and an approval
        // prompt in a headless sweep is a hang, not a safeguard.
        "--permission-mode",
        "bypassPermissions",
      ];
      if (options.allowedTools !== undefined) {
        args.push("--allowed-tools", ...options.allowedTools);
      }

      const proc = Bun.spawn(["claude", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      let stdout: string;
      try {
        stdout = await new Response(proc.stdout).text();
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }

      const parsed = parseStream(stdout.split("\n").filter(Boolean), gold);
      if (parsed.isError) {
        // Surfaced rather than scored. A failed arm scored as zero recall would
        // be indistinguishable from an arm that searched and found nothing,
        // and the two mean opposite things about the context under test.
        throw new Error(`claude reported an error for model ${model} in ${cwd}`);
      }

      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        contextTokens: parsed.contextTokens,
        costUsd: parsed.costUsd,
        stepsToFirstGold: parsed.stepsToFirstGold,
      };
    },
  };
}
