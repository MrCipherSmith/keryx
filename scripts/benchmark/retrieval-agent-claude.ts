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

import { homedir } from "node:os";
import path from "node:path";
import {
  assertEnvIsolated,
  assertNoManagedSettings,
  buildIsolatedEnv,
  createIsolatedHome,
  type IsolatedHome,
} from "./retrieval-isolation";
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
  /** The home a credential is linked from. Overridable so a test never reads a real one. */
  readonly realHome?: string;
  /**
   * The id written on every result row from this agent.
   *
   * Defaults to the harness constant. Overridable because the id belonged to the
   * ADAPTER rather than to the harness spec, so two specs over one adapter — the
   * shape of "the same CLI on two models" — silently wrote the same id on every
   * row. That collapses them in the results file, makes `completedKeys` skip the
   * second leg as already done, pools them in `decideByHarness`, and collides
   * their worktree paths. One field, four bugs.
   */
  readonly harnessId?: string;
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
  /**
   * The tool roster the CLI reported at startup, and the MCP servers behind it.
   *
   * Captured so the arm's environment is asserted rather than assumed. Both are
   * empty when the transcript carried no init event, which `assertRoster` treats
   * as a refusal rather than as "nothing was loaded" — an absent roster and an
   * empty one are the same shape and mean opposite things.
   */
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly sawInit: boolean;
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
  let tools: string[] = [];
  let mcpServers: string[] = [];
  let sawInit = false;

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

    // Both CLIs announce their environment in one init event before any turn.
    // grok's is shaped like claude's, which is why one parser serves both.
    if (event.type === "system" && event.subtype === "init") {
      sawInit = true;
      tools = Array.isArray(event.tools) ? (event.tools as string[]) : [];
      const servers = event.mcp_servers;
      mcpServers = Array.isArray(servers)
        ? servers.map((entry) => {
            const named = entry as { name?: unknown };
            return typeof named.name === "string" ? named.name : String(entry);
          })
        : [];
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

  return { text, toolCalls, contextTokens, costUsd, stepsToFirstGold, isError, tools, mcpServers, sawInit };
}

/**
 * Tool names no arm may hold, matched case-insensitively as substrings.
 *
 * The web ones are not caution. keryx is a PUBLIC repository, the query IS a
 * merged pull request's subject line, and the gold set is the files it changed:
 * a web search for that sentence returns the pull request. The 2026-09-05 run
 * was conducted with `WebSearch` and `WebFetch` in the roster and no record of
 * whether either was called — the harness counted tool calls without naming
 * them. That is not a bias between the arms, since both had them, but it does
 * undercut the claim that the files were found by searching the repository.
 *
 * `github` and `gitkraken` are here because grok discovered six MCP servers
 * from the operator's global configuration, among them a code searcher over
 * GitHub and a set of git tools — the same "the control arm has a second
 * retrieval system" defect this document already recorded once, arriving
 * through a different door.
 */
export const FORBIDDEN_TOOL_MARKERS: readonly string[] = [
  "websearch",
  "webfetch",
  "web_search",
  "web_fetch",
  "github__",
  "gitkraken__",
];

/**
 * Refuse an arm whose environment is not the one the pre-registration describes.
 *
 * A missing init event is a refusal, not a pass. An absent roster and an empty
 * roster are the same shape in the transcript and mean opposite things, and the
 * permissive reading is the one that silently accepts an arm running with a
 * hundred tools nobody looked at.
 */
export function assertRoster(parsed: ParsedStream, harness: string): void {
  if (!parsed.sawInit) {
    throw new Error(
      `${harness}: the transcript carried no init event, so the tool roster could not be checked — ` +
        "refusing rather than assuming it was clean",
    );
  }
  if (parsed.mcpServers.length > 0) {
    throw new Error(
      `${harness}: ${parsed.mcpServers.length} MCP server(s) reached this arm (${parsed.mcpServers.join(", ")}) — ` +
        "an arm with a second retrieval system is not the arm this measures",
    );
  }
  const forbidden = parsed.tools.filter((tool) =>
    FORBIDDEN_TOOL_MARKERS.some((marker) => tool.toLowerCase().includes(marker)),
  );
  if (forbidden.length > 0) {
    throw new Error(`${harness}: forbidden tools in the roster: ${forbidden.join(", ")}`);
  }
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
    // The repository under test is public and the query is a merged pull
    // request's subject line. Left in the roster, the shortest path to the gold
    // set is a web search, not a search of the tree. The flag is belt; the
    // roster assertion after the run is braces — a flag that stops being
    // honoured would otherwise change nothing visible.
    "--disallowedTools",
    "WebSearch",
    "WebFetch",
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
 * A HOME holding nothing this operator configured.
 *
 * macOS Claude Code keeps its credential in the Keychain, which is scoped to
 * the user rather than to HOME, so a temporary HOME authenticates normally and
 * there is nothing to link. On Linux the same leg reads
 * `~/.claude/.credentials.json`; the link is declared optional so one call
 * covers both without branching on platform.
 */
export function createClaudeHome(realHome: string = homedir()): IsolatedHome {
  return createIsolatedHome({
    prefix: "keryx-claude-home-",
    realHome,
    credentials: [{ from: path.join(".claude", ".credentials.json"), to: ".claude/.credentials.json", required: false }],
  });
}

/**
 * The environment each arm is spawned with.
 *
 * Exported so the result is asserted rather than assumed — the same reason
 * `buildClaudeArgs` is. Both arms get exactly this, so it cannot favour either.
 *
 * This was a copy of the whole parent environment with one key overridden,
 * which meant the operator's `~/.claude/CLAUDE.md` — carrying this project's
 * own keryx routing block — reached the `context-off` arm, along with 79
 * skills, six MCP servers and every `ANTHROPIC_*`, `CLAUDE_*` and `GH_TOKEN`
 * in the shell. The published 2026-09-05 figures are from that leg. A copy
 * cannot be repaired by excluding keys, because the dangerous ones are the
 * ones nobody listed, so this is an allowlist instead.
 *
 * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` pass because they are the
 * credential, not context. `ANTHROPIC_BASE_URL` and `CLAUDE_CONFIG_DIR` do
 * not: the first changes which service answers, the second relocates the
 * configuration a temporary HOME exists to hide.
 */
export function buildClaudeEnv(parent: Record<string, string | undefined>, home: string): Record<string, string> {
  const env = buildIsolatedEnv({
    parent,
    home,
    allowExtra: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    overrides: { PORT: SESSION_HOOK_PORT_SINK },
  });
  assertEnvIsolated(env, CLAUDE_HARNESS);
  return env;
}

export function createClaudeAgent(options: ClaudeAgentOptions = {}): AgentPort {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  const harness = options.harnessId ?? CLAUDE_HARNESS;

  return {
    harness,
    async run({ cwd, prompt, model, gold }): Promise<AgentAnswer> {
      const args = buildClaudeArgs(prompt, model, options.allowedTools);
      assertNoManagedSettings();
      const isolated = createClaudeHome(options.realHome ?? homedir());
      try {
        const proc = Bun.spawn(["claude", ...args], {
          cwd,
          env: buildClaudeEnv(process.env, isolated.home),
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
        // interpretRun first, so a timeout is reported as a timeout rather than
        // as "no init event" — a killed process can lose the transcript entirely,
        // and the less specific message would hide the real cause.
        const answer = interpretRun(parsed, { timedOut, timeoutMs, model, cwd, harness });
        assertRoster(parsed, harness);
        return answer;
      } finally {
        isolated.dispose();
      }
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
  context: { timedOut: boolean; timeoutMs: number; model: string; cwd: string; harness?: string },
): AgentAnswer {
  // Named so a grok failure does not report itself as a claude failure. The
  // default keeps every existing call site and its tests unchanged.
  const who = context.harness ?? CLAUDE_HARNESS;
  if (context.timedOut) {
    throw new Error(
      `${who} exceeded ${Math.round(context.timeoutMs / 1000)}s for model ${context.model} in ${context.cwd}`,
    );
  }
  if (parsed.isError) {
    throw new Error(`${who} reported an error for model ${context.model} in ${context.cwd}`);
  }
  if (parsed.text.trim().length === 0) {
    throw new Error(`${who} produced no final answer for model ${context.model} in ${context.cwd}`);
  }
  return {
    text: parsed.text,
    toolCalls: parsed.toolCalls,
    contextTokens: parsed.contextTokens,
    costUsd: parsed.costUsd,
    stepsToFirstGold: parsed.stepsToFirstGold,
  };
}
