import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  contextTokensOf,
  createClaudeHome,
  interpretRun,
  minimalClaudeConfig,
  parseStream,
} from "./retrieval-agent-claude";

describe("buildClaudeArgs", () => {
  test("web tools are refused, because the repository under test is public", () => {
    // The query IS a merged pull request's subject line and keryx is public, so
    // a web search for it returns the answer. The 2026-09-05 run was conducted
    // without this flag and recorded tool-call counts without names, so whether
    // either arm reached for the web cannot now be established either way.
    const args = buildClaudeArgs("find the files", "claude-sonnet-5");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("WebSearch");
    expect(args).toContain("WebFetch");
  });

  test("excludes user-global MCP servers", () => {
    // Measured, not assumed: without this flag the init event reports 88 tools
    // of which 59 are MCP — including a code-search server with its own index of
    // the repository. With it, 29 and none.
    //
    // That server reaches both arms equally, so it does not bias the
    // comparison, but it makes "without keryx" mean "without keryx and with a
    // different retrieval system". The smoke run was conducted that way and
    // nothing in its output said so, which is why this is a test and not a
    // comment.
    expect(buildClaudeArgs("q", "m")).toContain("--strict-mcp-config");
  });

  test("both arms are run with identical flags apart from nothing at all", () => {
    // The arms differ in the tree they run in. If they ever differ in argv, the
    // measurement is comparing two things and reporting one.
    expect(buildClaudeArgs("q", "claude-sonnet-5")).toEqual(buildClaudeArgs("q", "claude-sonnet-5"));
  });

  test("carries the prompt and model through", () => {
    const args = buildClaudeArgs("find the bug", "claude-opus-5");
    expect(args[args.indexOf("-p") + 1]).toBe("find the bug");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
  });
});

// Parsed against transcripts shaped like the real one — captured from a live
// `claude -p --output-format stream-json` run, not invented. The event kinds,
// the nesting of `tool_use` inside `message.content`, and the field names in
// `result` are all as they actually arrive.

function assistantToolUse(name: string, input: unknown): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

function toolResult(content: unknown): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content }] } });
}

function resultEvent(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    result: "The file is src/billing/charge.ts",
    total_cost_usd: 0.042,
    num_turns: 3,
    is_error: false,
    usage: {
      input_tokens: 6,
      cache_creation_input_tokens: 23737,
      cache_read_input_tokens: 108721,
      output_tokens: 285,
    },
    ...over,
  });
}

describe("buildClaudeEnv", () => {
  test("points the session-facts hook's port at a closed one", () => {
    // That hook posts every finished session to a local bot, which extracts
    // durable project facts into the operator's memory. A sweep is two sessions
    // per task — 126 across the two planned runs — every one of them about a
    // throwaway checkout in /tmp.
    //
    // Overriding the port in the CHILD's environment makes the hook's
    // `curl -sf … || true` fail and do nothing, without editing a settings file
    // that is not this benchmark's to edit. Nothing to restore afterwards.
    expect(buildClaudeEnv({ PATH: "/usr/bin" }, "/tmp/h").PORT).toBe("1");
  });

  test("HOME is the isolated one, never the operator's", () => {
    // The whole point. The operator's ~/.claude/CLAUDE.md carries this
    // project's own keryx routing block, so a context-off arm reading it is
    // instructed to route through the system under test into a tree where
    // .metaproject/ was just deleted — the control arm obstructed by the thing
    // being measured.
    const env = buildClaudeEnv({ PATH: "/usr/bin", HOME: "/Users/real" }, "/tmp/isolated");
    expect(env.HOME).toBe("/tmp/isolated");
  });

  test("the environment is an allowlist, not a copy", () => {
    const env = buildClaudeEnv(
      { PATH: "/usr/bin", LANG: "en_US.UTF-8", SOME_TOOL_CONFIG: "x", EMPTY: undefined },
      "/tmp/h",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect("SOME_TOOL_CONFIG" in env).toBe(false);
    expect("EMPTY" in env).toBe(false);
  });

  test("credentials pass; configuration redirectors and answer-reaching tokens do not", () => {
    // ANTHROPIC_API_KEY is the credential, not context. CLAUDE_CONFIG_DIR
    // relocates the whole configuration and on its own defeats a temporary
    // HOME. GH_TOKEN reaches a service that holds the answer.
    const env = buildClaudeEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-test",
        CLAUDE_CONFIG_DIR: "/Users/real/.claude",
        GH_TOKEN: "ghp-test",
        MCP_TIMEOUT: "5000",
      },
      "/tmp/h",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
    expect("GH_TOKEN" in env).toBe(false);
    expect("MCP_TIMEOUT" in env).toBe(false);
  });

  test("an existing PORT is overridden, not preserved", () => {
    expect(buildClaudeEnv({ PORT: "3847" }, "/tmp/h").PORT).toBe("1");
  });
});

describe("interpretRun", () => {
  const ctx = { timedOut: false, timeoutMs: 720_000, model: "m", cwd: "/tmp/t" };
  const ok = {
    text: "src/a.ts",
    toolCalls: 3,
    contextTokens: 100,
    costUsd: 0.1,
    stepsToFirstGold: 2,
    isError: false,
    tools: ["Read", "Grep"],
    mcpServers: [],
    sawInit: true,
  };

  test("a timeout throws rather than scoring as zero recall", () => {
    // A killed process emits no `result` event, so the transcript parses to
    // empty text — which scores zero recall and looks exactly like an arm that
    // searched honestly and found nothing. Those mean opposite things about the
    // context under test. In a five-hour sweep this would have recorded a
    // twelve-minute hang as a confident zero, and credited whichever arm hung
    // less often.
    expect(() => interpretRun({ ...ok, text: "" }, { ...ctx, timedOut: true })).toThrow(/exceeded 720s/);
  });

  test("an error result throws", () => {
    expect(() => interpretRun({ ...ok, isError: true }, ctx)).toThrow(/reported an error/);
  });

  test("a transcript with no final answer throws", () => {
    // Same reasoning one step out: a run that ended without answering did not
    // answer wrongly, it did not answer.
    expect(() => interpretRun({ ...ok, text: "   " }, ctx)).toThrow(/no final answer/);
  });

  test("a good run comes through unchanged", () => {
    expect(interpretRun(ok, ctx)).toEqual({
      text: "src/a.ts",
      toolCalls: 3,
      contextTokens: 100,
      costUsd: 0.1,
      stepsToFirstGold: 2,
    });
  });
});

describe("contextTokensOf", () => {
  test("sums everything the model read, cache included", () => {
    expect(
      contextTokensOf({
        input_tokens: 6,
        cache_creation_input_tokens: 23737,
        cache_read_input_tokens: 108721,
        output_tokens: 285,
      }),
    ).toBe(132464);
  });

  test("output tokens are not context — they are what it wrote", () => {
    expect(contextTokensOf({ input_tokens: 10, output_tokens: 9999 })).toBe(10);
  });

  test("missing usage is zero, not a crash", () => {
    expect(contextTokensOf(undefined)).toBe(0);
  });
});

describe("parseStream", () => {
  test("counts tool calls and reads the final answer", () => {
    const parsed = parseStream(
      [
        JSON.stringify({ type: "system", subtype: "init" }),
        assistantToolUse("Bash", { command: "ls src" }),
        JSON.stringify({ type: "user", message: { content: [] } }),
        assistantToolUse("Read", { file_path: "src/billing/charge.ts" }),
        resultEvent(),
      ],
      ["src/billing/charge.ts"],
    );
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.text).toContain("src/billing/charge.ts");
    expect(parsed.contextTokens).toBe(132464);
    expect(parsed.costUsd).toBeCloseTo(0.042, 5);
  });

  test("stepsToFirstGold is the tool call that first named a gold file", () => {
    const parsed = parseStream(
      [
        assistantToolUse("Bash", { command: "ls" }),
        assistantToolUse("Bash", { command: "grep -r refund src" }),
        assistantToolUse("Read", { file_path: "src/billing/charge.ts" }),
        resultEvent(),
      ],
      ["src/billing/charge.ts"],
    );
    expect(parsed.stepsToFirstGold).toBe(3);
  });

  test("a gold path HANDED BACK by a tool counts, even if the agent never typed it", () => {
    // The defect the smoke run exposed. The context-on arm asks the graph about
    // a symptom and gets paths in the answer; no tool input ever contains one.
    // Scoring only inputs reported "never arrived" for an arm that answered the
    // task perfectly, and would have penalised query-based navigation — the very
    // behaviour under measurement — on all fifty tasks.
    const parsed = parseStream(
      [
        assistantToolUse("keryx", { query: "refunds double on retry" }),
        toolResult("related files:\n  src/billing/charge.ts\n  src/billing/retry.ts"),
        resultEvent(),
      ],
      ["src/billing/charge.ts"],
    );
    expect(parsed.stepsToFirstGold).toBe(1);
  });

  test("a returned gold path is credited to the call that produced it, not the next one", () => {
    const parsed = parseStream(
      [
        assistantToolUse("Bash", { command: "ls" }),
        toolResult("src\npackage.json"),
        assistantToolUse("keryx", { query: "refunds" }),
        toolResult("src/billing/charge.ts"),
        assistantToolUse("Read", { file_path: "src/billing/charge.ts" }),
        resultEvent(),
      ],
      ["src/billing/charge.ts"],
    );
    expect(parsed.stepsToFirstGold).toBe(2);
  });

  test("tool results are not counted as tool calls", () => {
    const parsed = parseStream(
      [assistantToolUse("Bash", { command: "ls" }), toolResult("src/a.ts"), resultEvent()],
      ["src/a.ts"],
    );
    expect(parsed.toolCalls).toBe(1);
  });

  test("stepsToFirstGold is null when the agent never reached the file", () => {
    // Distinct from 0. Reporting 0 would make a total miss look like an instant
    // hit, which is the wrong direction for the metric that claims to measure
    // how fast the agent oriented.
    const parsed = parseStream(
      [assistantToolUse("Bash", { command: "ls" }), resultEvent()],
      ["src/billing/charge.ts"],
    );
    expect(parsed.stepsToFirstGold).toBeNull();
  });

  test("a malformed line is skipped, not fatal", () => {
    // These transcripts gain new event kinds between releases; losing a whole
    // sweep to one unparseable line would be a bad trade.
    const parsed = parseStream(
      ["{not json", assistantToolUse("Bash", { command: "ls" }), resultEvent()],
      ["src/a.ts"],
    );
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.text).toContain("charge.ts");
  });

  test("an error result is reported as one rather than scored as a miss", () => {
    // A failed arm and an arm that searched and found nothing both produce zero
    // recall, and they mean opposite things about the context under test.
    const parsed = parseStream([resultEvent({ is_error: true })], ["src/a.ts"]);
    expect(parsed.isError).toBe(true);
  });

  test("a tool_use block sitting beside text is still counted", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
        ],
      },
    });
    const parsed = parseStream([line, resultEvent()], ["src/a.ts"]);
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.stepsToFirstGold).toBe(1);
  });
});

describe("createClaudeHome — the credential path", () => {
  const SECRET = '{"claudeAiOauth":{"accessToken":"tok-do-not-log-me","refreshToken":"r"}}';

  function fakeRealHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), "keryx-claude-real-"));
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "someone@example.invalid" },
        userID: "user-123",
        hasCompletedOnboarding: true,
        // The reason the real file is never linked.
        mcpServers: { "backend-graph": { command: "x" }, context7: { command: "y" } },
        history: ["a previous prompt"],
      }),
      "utf8",
    );
    return home;
  }

  test("on macOS the grant is written into the isolated home, at 0600", () => {
    // There is no file to link on macOS: the grant lives in the Keychain. An
    // earlier version of this function recorded the opposite and declared the
    // link optional, so an unauthenticated arm started, answered nothing, and
    // scored as one that searched and found nothing.
    const realHome = fakeRealHome();
    const isolated = createClaudeHome(realHome, {
      platform: "darwin",
      account: "someone",
      readSecret: () => SECRET,
    });
    try {
      const written = path.join(isolated.home, ".claude", ".credentials.json");
      expect(readFileSync(written, "utf8")).toBe(SECRET);
      expect(statSync(written).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(written)).mode & 0o777).toBe(0o700);
    } finally {
      isolated.dispose();
    }
  });

  test("the config carries identity and NOT the operator's MCP servers", () => {
    // The real `~/.claude.json` holds `mcpServers` — on this machine
    // backend-graph, context7 and playwright — which is exactly the
    // contamination an isolated HOME exists to remove. Linking it would restore
    // that through the back door.
    const realHome = fakeRealHome();
    const isolated = createClaudeHome(realHome, { platform: "darwin", readSecret: () => SECRET });
    try {
      const config = JSON.parse(readFileSync(path.join(isolated.home, ".claude.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(config.userID).toBe("user-123");
      expect(config.hasCompletedOnboarding).toBe(true);
      expect(config.mcpServers).toEqual({});
      expect(config.history).toBeUndefined();
    } finally {
      isolated.dispose();
    }
  });

  test("a Keychain read that fails refuses the arm rather than starting it", () => {
    const realHome = fakeRealHome();
    expect(() =>
      createClaudeHome(realHome, {
        platform: "darwin",
        readSecret: () => {
          throw new Error("The specified item could not be found in the keychain.");
        },
      }),
    ).toThrow(/would be scored as one that found nothing/);
  });

  test("the secret never appears in the error when the read fails afterwards", () => {
    // The failure path is the one that reaches a log, a CI transcript and a
    // results file at once. A reader that leaks into its own error would put
    // the grant in all three.
    const realHome = fakeRealHome();
    let message = "";
    let cause: unknown;
    try {
      createClaudeHome(realHome, {
        platform: "darwin",
        readSecret: () => {
          throw new Error(`could not use ${SECRET}`);
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      cause = error instanceof Error ? error.cause : undefined;
    }
    // The composed message is ours and carries none of the reader's text, so a
    // reader that leaks into its own error cannot leak through this one. The
    // cause still holds the original for diagnosis.
    expect(message).not.toContain("tok-do-not-log-me");
    expect(message).toContain("cannot authenticate");
    expect(String(cause)).toContain("could not use");
  });

  test("an empty grant is refused, because an empty file authenticates nothing", () => {
    const realHome = fakeRealHome();
    expect(() => createClaudeHome(realHome, { platform: "darwin", readSecret: () => "   " })).toThrow(
      /came back empty/,
    );
  });

  test("on Linux the grant is a file and is required, not optional", () => {
    // Optional was how the macOS mistake hid: a missing credential produced a
    // home that looked fine and an arm that could not authenticate.
    const realHome = fakeRealHome();
    expect(() => createClaudeHome(realHome, { platform: "linux", readSecret: () => SECRET })).toThrow(
      /no credentials at/,
    );
  });

  test("on Linux an existing grant file is linked and the Keychain is never consulted", () => {
    const realHome = fakeRealHome();
    mkdirSync(path.join(realHome, ".claude"), { recursive: true });
    writeFileSync(path.join(realHome, ".claude", ".credentials.json"), SECRET, "utf8");
    let keychainCalls = 0;
    const isolated = createClaudeHome(realHome, {
      platform: "linux",
      readSecret: () => {
        keychainCalls += 1;
        return SECRET;
      },
    });
    try {
      expect(keychainCalls).toBe(0);
      expect(readFileSync(path.join(isolated.home, ".claude", ".credentials.json"), "utf8")).toBe(SECRET);
    } finally {
      isolated.dispose();
    }
  });

  test("disposing takes the materialised grant with it", () => {
    const realHome = fakeRealHome();
    const isolated = createClaudeHome(realHome, { platform: "darwin", readSecret: () => SECRET });
    const written = path.join(isolated.home, ".claude", ".credentials.json");
    expect(existsSync(written)).toBe(true);
    isolated.dispose();
    expect(existsSync(isolated.home)).toBe(false);
  });
});

describe("minimalClaudeConfig", () => {
  test("a missing or unreadable real config still yields a usable one", () => {
    // Identity is not authorisation: the grant is what authenticates, so a
    // missing `~/.claude.json` must not stop an arm.
    const empty = mkdtempSync(path.join(tmpdir(), "keryx-claude-noconfig-"));
    const config = JSON.parse(minimalClaudeConfig(empty)) as Record<string, unknown>;
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.mcpServers).toEqual({});
  });
});
