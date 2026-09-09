// The grok adapter: `grok -p --output-format streaming-messages-json`.
//
// grok emits the same event shapes as the Claude CLI — a `system`/`init`
// announcing the roster, `assistant` events carrying `tool_use` blocks and a
// `usage` with the cache fields broken out, and a final `result` with
// `total_cost_usd`. So `parseStream` serves both, and the context-cost
// definition the pre-registration fixes is computable here identically. That
// is the whole reason this leg can answer the cost half of the rule while a
// `codex` leg cannot.
//
// What differs is the environment, and it differs enough that this file is
// mostly about that.

import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { assertRoster, interpretRun, parseStream } from "./retrieval-agent-claude";
import type { AgentAnswer, AgentPort } from "./retrieval-run";

export const GROK_HARNESS = "grok";

export interface GrokAgentOptions {
  /** Wall-clock ceiling per arm. A hung run must not stall a sweep. */
  readonly timeoutMs?: number;
  /** Overridden in tests; the real home is only read for credentials. */
  readonly realHome?: string;
}

/**
 * The exact argv every grok arm is run with. Exported so it is asserted.
 */
export function buildGrokArgs(prompt: string, model: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "streaming-messages-json",
    "-m",
    model,
    // A throwaway checkout of a commit that already exists. An approval prompt
    // in a headless sweep is a hang, not a safeguard.
    "--always-approve",
    // The repository under test is public and the query is a merged pull
    // request's subject line: a web search for it returns the answer.
    "--disable-web-search",
    "--disallowed-tools",
    "web_search,web_fetch",
    // Plan mode and subagents are both turn multipliers whose cost lands in the
    // same usage totals the comparison is made from, and neither exists on the
    // claude leg. Off, so the legs differ in wrapper rather than in loop shape.
    "--no-plan",
    "--no-subagents",
  ];
}

/**
 * A HOME holding nothing but this operator's grok credentials.
 *
 * Measured, not assumed, and the numbers are the argument. Run under the real
 * HOME, `grok inspect` reports three global instruction files — `~/.claude/
 * CLAUDE.md`, `~/.claude/rules/context7.md` and `~/.cursor/rules/AGENTS.md`,
 * some 16,600 tokens — a settings file with 27 permissions, 74 skills, six MCP
 * servers and about 130 tools. Among those tools are a GitHub code searcher and
 * a set of git commands, either of which can reach the answer, and a
 * cross-model prompt tool.
 *
 * Two of those are disqualifying rather than merely noisy. `~/.claude/CLAUDE.md`
 * carries this project's own routing block, so the `context-off` arm would be
 * instructed to route through keryx into a tree where `.metaproject/` has been
 * deleted — the control arm obstructed by the system under test, which is
 * exactly the defect the 2026-09-05 amendment records for the other leg. And a
 * GitHub code searcher makes "without keryx" mean something other than what it
 * says.
 *
 * A clean HOME with only `.grok/auth.json` linked in reports 0 instruction
 * files, 0 permissions, 0 MCP servers and 27 tools, and the same four-word
 * prompt costs 12,975 input tokens instead of 27,863. `GROK_HOME` was tried
 * first and changes none of this; HOME is what the discovery actually reads.
 *
 * Linked rather than copied: a credential is not duplicated to run a benchmark.
 * Sessions, memory and logs land in the temporary home and go with it, which
 * also keeps 126 throwaway sessions out of the operator's own grok history.
 */
export function createIsolatedHome(realHome: string = homedir()): { home: string; dispose: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "keryx-grok-home-"));
  mkdirSync(path.join(home, ".grok"), { recursive: true });
  const auth = path.join(realHome, ".grok", "auth.json");
  if (!existsSync(auth)) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(
      `grok: no credentials at ${auth} — run \`grok login\` before the sweep; ` +
        "an unauthenticated arm fails at the first call and would be recorded as a failure of the arm",
    );
  }
  symlinkSync(auth, path.join(home, ".grok", "auth.json"));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

export function createGrokAgent(options: GrokAgentOptions = {}): AgentPort {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return {
    harness: GROK_HARNESS,
    async run({ cwd, prompt, model, gold }): Promise<AgentAnswer> {
      const isolated = createIsolatedHome(options.realHome ?? homedir());
      try {
        const proc = Bun.spawn(["grok", ...buildGrokArgs(prompt, model)], {
          cwd,
          env: { ...process.env, HOME: isolated.home },
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
        const answer = interpretRun(parsed, { timedOut, timeoutMs, model, cwd, harness: GROK_HARNESS });
        assertRoster(parsed, GROK_HARNESS);
        return answer;
      } finally {
        isolated.dispose();
      }
    },
  };
}
