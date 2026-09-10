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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { assertEnvIsolated, buildIsolatedEnv, createIsolatedHome, type IsolatedHome } from "./retrieval-isolation";
import type { AgentAnswer, AgentPort } from "./retrieval-run";
import { writeTranscript } from "./retrieval-transcript";

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
  /** The home a credential is linked from. Overridable so a test never reads a real one. */
  readonly realHome?: string;
  /** The id written on every result row. See the note on `ClaudeAgentOptions.harnessId`. */
  readonly harnessId?: string;
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
  /** True when a turn_start was seen at all — the arm's roster is otherwise unverified. */
  readonly sawTurnStart: boolean;
  /** Tool names the turn ran with, from turn_start. */
  readonly tools: readonly string[];
}

const CLIP_MARK = " chars]";

/**
 * Substrings that disqualify a tool from an arm, matched case-insensitively.
 *
 * The same list the other legs use, for the same reason: this repository is
 * public and a task's query is a merged pull request's subject line, so a web
 * search or a GitHub tool answers the question without reading the checkout.
 */
export const KERYX_FORBIDDEN_TOOL_MARKERS: readonly string[] = [
  "websearch",
  "webfetch",
  "web_search",
  "web_fetch",
  "github__",
  "gitkraken__",
];

/**
 * The exact tool names passed to `keryx shell --deny-tools`.
 *
 * Separate from the markers above and NOT derived from them by string surgery:
 * those are case-insensitive substrings used to judge a roster after the fact
 * (`websearch`, `github__`), while this flag takes names from keryx's own
 * registry and refuses an unknown one. Feeding it a marker would kill every arm
 * on `unknown tool name(s) in --deny-tools`.
 *
 * Two lists that must agree is exactly how a guard rots, so they are held to
 * each other by a test rather than by care: every name here must match a marker,
 * and every tool keryx offers that matches a marker must appear here — derived
 * from the real registry, so a tool added later is caught without anyone
 * remembering to look.
 */
export const KERYX_DENIED_TOOLS: readonly string[] = ["web_search", "web_fetch"];

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
  let sawTurnStart = false;
  let tools: readonly string[] = [];
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
    if (event.type === "turn_start") {
      sawTurnStart = true;
      if (Array.isArray(event.tools)) tools = event.tools.filter((name): name is string => typeof name === "string");
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
    sawTurnStart,
    tools,
  };
}

/**
 * Refuse a keryx arm whose tool roster was never announced, or is wrong.
 *
 * The claude and grok legs have had this since the start, reading the roster
 * out of the CLI's init event. This leg had NOTHING: no environment isolation
 * and no roster check, because the shell emitted no roster to check. So the
 * harness most load-bearing for claims about keryx was the one arm nobody could
 * verify. `turn_start` now carries the names and this holds them to account.
 *
 * The two refusals mean different things. A missing roster means the arm's
 * environment is unverified, which is not the same as clean. A forbidden tool
 * means the answer was reachable by a route the ablation does not control — and
 * on a public repository with a merged pull request's subject line as the query,
 * a web search returns the answer outright.
 */
export function assertKeryxRoster(turn: KeryxTurn, context: { model: string; cwd: string }): void {
  if (!turn.sawTurnStart) {
    throw new Error(
      `keryx wrote no turn_start for model ${context.model} in ${context.cwd} — ` +
        "the arm's tool roster could not be read back, so its environment is unverified; " +
        "refusing rather than assuming it was clean",
    );
  }
  const forbidden = turn.tools.filter((name) =>
    KERYX_FORBIDDEN_TOOL_MARKERS.some((marker) => name.toLowerCase().includes(marker)),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `keryx ran with forbidden tools in the roster for model ${context.model} in ${context.cwd}: ` +
        `${forbidden.sort().join(", ")} — these can reach the answer from outside the checkout`,
    );
  }
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
    // The roster the other two legs already have. keryx is the last of the three
    // to be able to say "this session does not need the web", and until it could,
    // `assertKeryxRoster` refused every arm — correctly: the target repository's
    // task text is a real pull request's, and a web tool can reach the answer
    // from outside the checkout. Denied rather than merely disapproved: a denied
    // tool is not offered to the model, so it cannot be attempted or reasoned
    // about. Names come from `--deny-tools`' own list, which refuses an unknown
    // one instead of leaving the session with web search and a clear conscience.
    "--deny-tools",
    KERYX_DENIED_TOOLS.join(","),
    "--events-file",
    eventsFile,
    "--events-max-field",
    String(maxField),
  ];
}

/**
 * A keryx home and data directory holding nothing but the credential.
 *
 * keryx reads its user-global state from `$XDG_DATA_HOME/keryx`, falling back to
 * `~/.local/share/keryx` (`src/lib/config-dir.ts`). That directory holds
 * `permissions.json` — the shell's auto-approval allowlist — plus
 * `sandbox.json`, `projects.json` and `auth.json`. Run under the operator's
 * own, an arm inherits a permission set and a project registry accumulated over
 * months, and twenty throwaway checkouts are registered into it per sweep.
 *
 * HOME is redirected too, so `~/.claude/CLAUDE.md` and the rest cannot reach the
 * arm by the route the grok leg already measured at ~16,600 tokens.
 */
export function createKeryxHome(realHome: string = homedir()): { isolated: IsolatedHome; dataHome: string } {
  const isolated = createIsolatedHome({
    prefix: "keryx-keryx-home-",
    realHome,
    credentials: [
      {
        from: path.join(".local", "share", "keryx", "auth.json"),
        to: ".local/share/keryx/auth.json",
        required: true,
        hint:
          "run `keryx auth login grok` before the sweep; without a credential keryx constructs an " +
          "offline fake provider whose turns report no usage, and the arm is refused rather than scored",
      },
    ],
  });
  return { isolated, dataHome: path.join(isolated.home, ".local", "share") };
}

/**
 * The environment each keryx arm is spawned with.
 *
 * `XDG_DATA_HOME` is set here ON PURPOSE and exempted by value: it is this
 * leg's isolation mechanism, and an inherited one — which would point back at
 * the operator's own keryx state — still fails the assertion.
 */
export function buildKeryxEnv(
  parent: Record<string, string | undefined>,
  home: string,
  dataHome: string,
): Record<string, string> {
  const env = buildIsolatedEnv({
    parent,
    home,
    allowExtra: ["XAI_API_KEY"],
    overrides: { XDG_DATA_HOME: dataHome },
  });
  assertEnvIsolated(env, KERYX_HARNESS, { XDG_DATA_HOME: dataHome });
  return env;
}

export function createKeryxAgent(options: KeryxAgentOptions): AgentPort {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const command = options.command ?? ["keryx"];
  const maxField = options.maxField ?? 200_000;

  const harness = options.harnessId ?? KERYX_HARNESS;

  return {
    harness,
    async run({ cwd, prompt, model, gold, transcriptFile }): Promise<AgentAnswer> {
      const dir = mkdtempSync(path.join(tmpdir(), "keryx-events-"));
      const eventsFile = path.join(dir, "events.jsonl");
      const { isolated, dataHome } = createKeryxHome(options.realHome ?? homedir());
      try {
        const args = buildKeryxArgs(prompt, model, options.provider, eventsFile, maxField);
        const proc = Bun.spawn([...command, ...args], {
          cwd,
          env: buildKeryxEnv(process.env, isolated.home, dataHome),
          stdout: "pipe",
          stderr: "pipe",
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
        // stderr is drained alongside stdout: left unread, a child that fills the
        // pipe buffer simply stops, and it is also where a shell error is printed.
        let stderr = "";
        try {
          [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }

        const raw = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : "";
        // Kept before interpretation, so a refused arm still leaves its evidence.
        writeTranscript(transcriptFile, raw, stderr);
        const lines = raw.split("\n").filter((line) => line.trim().length > 0);
        const turn = parseKeryxEvents(lines, gold);
        // interpretKeryxTurn first, so a timeout is reported as a timeout rather
        // than as "no turn_start" — a killed process can lose the transcript
        // entirely, and the less specific message would hide the real cause.
        const answer = interpretKeryxTurn(turn, { timedOut, timeoutMs, model, cwd });
        assertKeryxRoster(turn, { model, cwd });
        return answer;
      } finally {
        isolated.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
