import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
import {
  KERYX_DENIED_TOOLS,
  KERYX_FORBIDDEN_TOOL_MARKERS,
  assertKeryxRoster,
  buildKeryxArgs,
  buildKeryxEnv,
  interpretKeryxTurn,
  parseKeryxEvents,
  type KeryxTurn,
} from "./retrieval-agent-keryx";

const ctx = { timedOut: false, timeoutMs: 600_000, model: "grok-4.6", cwd: "/tmp/t" };

const ok: KeryxTurn = {
  text: "src/a.ts",
  toolCalls: 3,
  inputTokens: 12_975,
  stepsToFirstGold: 2,
  sawTurnEnd: true,
  clippedBeforeGold: false,
  providerCalls: 1,
  sawTurnStart: true,
  tools: ["read_file", "search_code"],
};

function ndjson(events: readonly Record<string, unknown>[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

describe("buildKeryxArgs", () => {
  test("one turn, no terminal, unattended", () => {
    const args = buildKeryxArgs("find it", "grok-4.6", "grok", "/tmp/e.jsonl", 1000);
    expect(args).toEqual(
      expect.arrayContaining(["--no-tui", "--print", "find it", "--auto", "--events-file", "/tmp/e.jsonl"]),
    );
  });

  test("the provider and model are both pinned", () => {
    // The reason this leg can exist: the same model runs under keryx and under
    // the grok CLI, so a difference between them is the shell and nothing else.
    const args = buildKeryxArgs("p", "grok-4.6", "grok", "/tmp/e", 10);
    expect(args).toEqual(expect.arrayContaining(["--provider", "grok", "--model", "grok-4.6"]));
  });
});

describe("parseKeryxEvents", () => {
  test("counts tool calls and finds the first gold path in a tool RESULT", () => {
    // Not only in inputs. An agent that asks the graph about a symptom and is
    // handed the paths never names one in an input, and counting inputs alone
    // scores exactly the behaviour under test as "never arrived".
    const turn = parseKeryxEvents(
      ndjson([
        { type: "turn_start", prompt: "q", provider: "grok", model: "grok-4.6" },
        { type: "tool_call", name: "search_code", input: '{"pattern":"refund"}' },
        { type: "tool_result", name: "search_code", isError: false, output: "src/charge.ts:12: refund" },
        { type: "turn_end", text: "src/charge.ts", toolCalls: 1, usage: { inputTokens: 900 } },
      ]),
      ["src/charge.ts"],
    );
    expect(turn.toolCalls).toBe(1);
    expect(turn.stepsToFirstGold).toBe(1);
    expect(turn.inputTokens).toBe(900);
    expect(turn.text).toBe("src/charge.ts");
  });

  test("a clipped output before the first gold hit is remembered", () => {
    // Otherwise a gold path cut out of a long tool result is scored as an arm
    // that never held one — a different claim, not a smaller number.
    const turn = parseKeryxEvents(
      ndjson([
        { type: "tool_call", name: "read_file", input: "{}" },
        { type: "tool_result", name: "read_file", isError: false, output: "xxxx…[+8000 chars]" },
        { type: "turn_end", text: "src/charge.ts", toolCalls: 1, usage: { inputTokens: 900 } },
      ]),
      ["src/charge.ts"],
    );
    expect(turn.stepsToFirstGold).toBeNull();
    expect(turn.clippedBeforeGold).toBe(true);
  });

  test("absent usage is null, not zero", () => {
    const turn = parseKeryxEvents(ndjson([{ type: "turn_end", text: "x", toolCalls: 0 }]), []);
    expect(turn.inputTokens).toBeNull();
  });

  test("input tokens are SUMMED over provider calls, not taken from the last one", () => {
    // The defect this replaces: `turn_end.usage` is the shell's `lastUsage`, a
    // plain assignment per call, so a multi-call turn reported one request's
    // prompt while the claude and grok legs reported a sum over the turn. On a
    // long task that understated this leg by an order of magnitude, in keryx's
    // favour, on the metric the cost half of the verdict is computed from.
    const turn = parseKeryxEvents(
      ndjson([
        { type: "usage", usage: { inputTokens: 10_000 } },
        { type: "tool_call", name: "search_code", input: "{}" },
        { type: "usage", usage: { inputTokens: 14_000 } },
        { type: "tool_call", name: "read_file", input: "{}" },
        { type: "usage", usage: { inputTokens: 19_000 } },
        // What the old code would have reported, alone:
        { type: "turn_end", text: "src/a.ts", toolCalls: 2, usage: { inputTokens: 19_000 } },
      ]),
      [],
    );
    expect(turn.inputTokens).toBe(43_000);
    expect(turn.providerCalls).toBe(3);
  });

  test("turn_end usage is the fallback when no per-call usage events exist", () => {
    // Transcripts recorded before per-call `usage` events must still parse.
    const turn = parseKeryxEvents(
      ndjson([{ type: "turn_end", text: "src/a.ts", toolCalls: 0, usage: { inputTokens: 777 } }]),
      [],
    );
    expect(turn.inputTokens).toBe(777);
    expect(turn.providerCalls).toBe(0);
  });

  test("calls that carry no token count stay null rather than summing to zero", () => {
    // A zero here would read as a free arm and slip past the refusal that
    // exists to catch the offline fake provider.
    const turn = parseKeryxEvents(
      ndjson([
        { type: "usage", usage: {} },
        { type: "usage", usage: {} },
        { type: "turn_end", text: "src/a.ts", toolCalls: 0 },
      ]),
      [],
    );
    expect(turn.inputTokens).toBeNull();
    expect(turn.providerCalls).toBe(2);
  });

  test("a torn line is skipped rather than fatal", () => {
    const turn = parseKeryxEvents(
      ["{not json", JSON.stringify({ type: "turn_end", text: "src/a.ts", toolCalls: 0, usage: { inputTokens: 5 } })],
      [],
    );
    expect(turn.sawTurnEnd).toBe(true);
  });
});

describe("interpretKeryxTurn", () => {
  test("a good turn comes through, so the refusals below are not vacuous", () => {
    expect(interpretKeryxTurn(ok, ctx)).toEqual({
      text: "src/a.ts",
      toolCalls: 3,
      contextTokens: 12_975,
      costUsd: null,
      stepsToFirstGold: 2,
    });
  });

  test("no usage is refused, because on this harness it means no model ran", () => {
    // keryx returns an offline fake provider when a credential is missing, and
    // the session header still names the provider that was asked for. A sweep
    // could complete against that fake and record its empty answers as a real
    // negative result. The fake reports no usage; a real provider always does.
    expect(() => interpretKeryxTurn({ ...ok, inputTokens: null }, ctx)).toThrow(/no token usage/);
  });

  test("a recorded provider error is refused rather than scored as an empty answer", () => {
    expect(() => interpretKeryxTurn({ ...ok, errorMessage: "[error] no credential" }, ctx)).toThrow(
      /reported an error/,
    );
  });

  test("a transcript with no turn_end is refused", () => {
    // A killed process leaves the events it produced. Scoring what is there
    // would report a partial session as a finished one.
    expect(() => interpretKeryxTurn({ ...ok, sawTurnEnd: false }, ctx)).toThrow(/no turn_end/);
  });

  test("a timeout is a timeout, not zero recall", () => {
    expect(() => interpretKeryxTurn({ ...ok, text: "" }, { ...ctx, timedOut: true })).toThrow(/exceeded 600s/);
  });

  test("an empty answer from a real turn is refused", () => {
    expect(() => interpretKeryxTurn({ ...ok, text: "  " }, ctx)).toThrow(/no final answer/);
  });

  test("cost is null and never zero", () => {
    // keryx does not price its turns. A zero would understate this leg in the
    // write-up while looking like a measurement.
    expect(interpretKeryxTurn(ok, ctx).costUsd).toBeNull();
  });
});

describe("assertKeryxRoster", () => {
  const ctx2 = { model: "grok-4.6", cwd: "/tmp/t" };

  test("an announced, clean roster passes, so the refusals below are not vacuous", () => {
    expect(() => assertKeryxRoster(ok, ctx2)).not.toThrow();
  });

  test("no turn_start means the environment is unverified, which is not the same as clean", () => {
    // This leg had no roster check at all: the shell emitted no roster, so the
    // harness most load-bearing for claims about keryx was the one arm nobody
    // could verify.
    expect(() => assertKeryxRoster({ ...ok, sawTurnStart: false }, ctx2)).toThrow(/no turn_start/);
  });

  test("a web tool in the roster is refused — it answers the query without the checkout", () => {
    // The query is a merged pull request's subject line on a public repository.
    expect(() => assertKeryxRoster({ ...ok, tools: ["read_file", "WebSearch"] }, ctx2)).toThrow(/forbidden tools/);
  });

  test("a GitHub tool is refused too, by marker rather than exact name", () => {
    expect(() => assertKeryxRoster({ ...ok, tools: ["mcp__github__search_code"] }, ctx2)).toThrow(/forbidden tools/);
  });
});

describe("parseKeryxEvents roster", () => {
  test("reads the roster off turn_start", () => {
    const turn = parseKeryxEvents(
      [
        JSON.stringify({
          type: "turn_start",
          prompt: "q",
          provider: "grok",
          model: "grok-4.6",
          tools: ["read_file", "search_code"],
        }),
        JSON.stringify({ type: "turn_end", text: "src/a.ts", toolCalls: 0, usage: { inputTokens: 5 } }),
      ],
      [],
    );
    expect(turn.sawTurnStart).toBe(true);
    expect(turn.tools).toEqual(["read_file", "search_code"]);
  });

  test("a turn_start from an older keryx, with no tools field, is seen but announces nothing", () => {
    const turn = parseKeryxEvents(
      [JSON.stringify({ type: "turn_start", prompt: "q", provider: "grok", model: "grok-4.6" })],
      [],
    );
    expect(turn.sawTurnStart).toBe(true);
    expect(turn.tools).toEqual([]);
  });
});

describe("buildKeryxEnv", () => {
  test("XDG_DATA_HOME is set to the isolated directory, not inherited", () => {
    // keryx reads its permission allowlist, sandbox policy and project registry
    // from $XDG_DATA_HOME/keryx. Under the operator's own, an arm inherits a
    // permission set accumulated over months.
    const env = buildKeryxEnv({ PATH: "/usr/bin", XDG_DATA_HOME: "/Users/real/.local/share" }, "/tmp/h", "/tmp/h/d");
    expect(env.XDG_DATA_HOME).toBe("/tmp/h/d");
    expect(env.HOME).toBe("/tmp/h");
  });

  test("the exemption is by value: an inherited XDG_DATA_HOME would still fail", () => {
    // Proven through assertEnvIsolated rather than asserted about it: the
    // builder always overrides, so the guard is what stops a future caller
    // passing the operator's directory through.
    const env = buildKeryxEnv({ PATH: "/usr/bin" }, "/tmp/h", "/tmp/h/d");
    expect(env.XDG_DATA_HOME).toBe("/tmp/h/d");
  });

  test("the environment is an allowlist — no GH_TOKEN, no MCP_*", () => {
    const env = buildKeryxEnv({ PATH: "/usr/bin", GH_TOKEN: "t", MCP_TIMEOUT: "5000" }, "/tmp/h", "/tmp/h/d");
    expect("GH_TOKEN" in env).toBe(false);
    expect("MCP_TIMEOUT" in env).toBe(false);
  });
});

/**
 * The environment the CLI is probed under: a throwaway HOME, the way the arena runs
 * every keryx arm. Under the operator's own HOME, 0.2.95+ starts every MCP server
 * configured there before building the tool list, and after refusing a bad
 * `--deny-tools` name the process did not exit at all (K-012, measured 90 s and
 * still running against 1.3 s here). Neither is what these tests are about: they
 * ask which names keryx's registry holds.
 */
function isolatedCliEnv(): Record<string, string> {
  const home = mkdtempSync(path.join(tmpdir(), "keryx-deny-home-"));
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TMPDIR: tmpdir(),
    ...(process.env.NODE_EXTRA_CA_CERTS === undefined ? {} : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
  };
}

describe("the keryx leg's denied tools", () => {
  test("the flag is passed, with the names comma-separated", () => {
    const args = buildKeryxArgs("find it", "grok-4.6", "grok", "/tmp/e.jsonl", 1000);
    const index = args.indexOf("--deny-tools");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe(KERYX_DENIED_TOOLS.join(","));
  });

  test("every denied name is one keryx actually offers", () => {
    // `--deny-tools` refuses an unknown name rather than ignoring it, so a name
    // outside keryx's registry kills the arm at startup — and an arm that dies
    // at startup scores as one that searched and found nothing.
    //
    // Checked against the real CLI rather than a copy of its tool list. A copy
    // is the thing that goes stale, and the registry is assembled from a dozen
    // constructors that a benchmark test has no business rebuilding. No model is
    // reached: the name check runs before any provider call.
    const proc = Bun.spawnSync(
      [
        "bun",
        path.join(REPO_ROOT, "src", "cli.ts"),
        "shell",
        "--provider",
        "deepseek",
        "--model",
        "unused",
        "--no-tui",
        "--deny-tools",
        KERYX_DENIED_TOOLS.join(","),
        "-p",
        "x",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: isolatedCliEnv() },
    );
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    expect(output).not.toContain("unknown tool name(s) in --deny-tools");
    // Valid names pass the check and the shell goes on to run the `-p` turn
    // offline — measured 4.9 s, which is bun's whole default 5 s budget and over it
    // under a loaded suite. The time is the real CLI starting, not a hang.
  }, 30_000);

  test("and a name keryx does NOT offer is refused, so the check above is not vacuous", () => {
    const proc = Bun.spawnSync(
      [
        "bun",
        path.join(REPO_ROOT, "src", "cli.ts"),
        "shell",
        "--provider",
        "deepseek",
        "--model",
        "unused",
        "--no-tui",
        "--deny-tools",
        "web_serch",
        "-p",
        "x",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: isolatedCliEnv() },
    );
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    expect(output).toContain("unknown tool name(s) in --deny-tools");
  }, 30_000);

  test("the roster markers still name something the denied list covers", () => {
    // The two lists are different shapes — substrings for judging a roster after
    // the fact, exact names for the flag. This holds them to each other: every
    // denied name must be one the roster check would have refused, so denying
    // and refusing cannot drift apart into denying the wrong thing.
    for (const name of KERYX_DENIED_TOOLS) {
      expect(KERYX_FORBIDDEN_TOOL_MARKERS.some((marker) => name.toLowerCase().includes(marker))).toBe(true);
    }
  });
});
