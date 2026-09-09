import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRoster, parseStream, type ParsedStream } from "./retrieval-agent-claude";
import { buildGrokArgs, createIsolatedHome, GROK_HARNESS } from "./retrieval-agent-grok";

const clean: ParsedStream = {
  text: "src/a.ts",
  toolCalls: 1,
  contextTokens: 100,
  costUsd: 0.01,
  stepsToFirstGold: 1,
  isError: false,
  tools: ["read_file", "grep", "list_dir"],
  mcpServers: [],
  sawInit: true,
};

describe("buildGrokArgs", () => {
  test("web access is off, and by both the flag and the tool name", () => {
    // keryx is a public repository and the query is a merged pull request's
    // subject line. A web search for that sentence returns the answer, so this
    // is not caution about egress — it is the shortest path to the gold set.
    const args = buildGrokArgs("find the files", "grok-4.6");
    expect(args).toContain("--disable-web-search");
    expect(args.join(" ")).toContain("web_search,web_fetch");
  });

  test("plan mode and subagents are off, so the legs differ in wrapper only", () => {
    const args = buildGrokArgs("p", "m");
    expect(args).toContain("--no-plan");
    expect(args).toContain("--no-subagents");
  });

  test("the model is passed explicitly", () => {
    // The whole reason this leg exists: `codex` resolves its own model and
    // cannot be pointed at one, so it can never hold the model constant.
    expect(buildGrokArgs("p", "grok-4.6")).toEqual(expect.arrayContaining(["-m", "grok-4.6"]));
  });
});

describe("assertRoster", () => {
  test("a clean roster passes, so the refusals below are not vacuous", () => {
    expect(() => assertRoster(clean, GROK_HARNESS)).not.toThrow();
  });

  test("an MCP server reaching the arm is refused", () => {
    // Measured on this machine: under the operator's real HOME, grok loads six
    // MCP servers including a GitHub code searcher. An arm holding a second
    // retrieval system is not the arm "without keryx" is supposed to mean.
    expect(() => assertRoster({ ...clean, mcpServers: ["github"] }, GROK_HARNESS)).toThrow(
      /MCP server\(s\) reached this arm/,
    );
  });

  test("a web tool in the roster is refused even when the flag was passed", () => {
    // The flag is belt, this is braces. A flag that silently stops being
    // honoured between CLI releases would otherwise change nothing visible.
    expect(() => assertRoster({ ...clean, tools: ["read_file", "web_search"] }, GROK_HARNESS)).toThrow(
      /forbidden tools/,
    );
    expect(() => assertRoster({ ...clean, tools: ["Read", "WebFetch"] }, "claude")).toThrow(/forbidden tools/);
    expect(() => assertRoster({ ...clean, tools: ["github__search_code"] }, GROK_HARNESS)).toThrow(
      /forbidden tools/,
    );
  });

  test("a transcript with no init event is refused, not passed", () => {
    // An absent roster and an empty one are the same shape here and mean
    // opposite things. The permissive reading silently accepts an arm that ran
    // with a hundred tools nobody looked at.
    expect(() => assertRoster({ ...clean, tools: [], sawInit: false }, GROK_HARNESS)).toThrow(
      /no init event/,
    );
  });
});

describe("parseStream on a grok transcript", () => {
  test("reads grok's roster, usage and result — the shapes match the claude CLI's", () => {
    // Captured from a real `grok -p --output-format streaming-messages-json`
    // run, trimmed. The point of this test is that one parser serves both
    // harnesses, which is what makes the context-cost definition identical
    // across them rather than approximately similar.
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "grok-4.6",
        tools: ["read_file", "grep"],
        mcp_servers: [],
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", input: { path: "src/a.ts" } }],
          usage: { input_tokens: 12_975, output_tokens: 34, cache_read_input_tokens: 640 },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "src/a.ts",
        total_cost_usd: 0.0045,
        usage: { input_tokens: 12_975, output_tokens: 34, cache_read_input_tokens: 640, cache_creation_input_tokens: 0 },
      }),
    ];
    const parsed = parseStream(lines, ["src/a.ts"]);
    expect(parsed.sawInit).toBe(true);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.tools).toEqual(["read_file", "grep"]);
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.stepsToFirstGold).toBe(1);
    // input + cache_read + cache_creation, exactly as the pre-registration says.
    expect(parsed.contextTokens).toBe(13_615);
    expect(parsed.costUsd).toBe(0.0045);
  });

  test("an MCP server list is read by name", () => {
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: [],
        mcp_servers: [{ name: "github", status: "connected" }],
      }),
    ];
    expect(parseStream(lines, []).mcpServers).toEqual(["github"]);
  });
});

describe("createIsolatedHome", () => {
  test("links the credential rather than copying it, and brings nothing else", () => {
    const realHome = mkdtempSync(path.join(tmpdir(), "keryx-grok-fake-home-"));
    mkdirSync(path.join(realHome, ".grok"), { recursive: true });
    writeFileSync(path.join(realHome, ".grok", "auth.json"), "{}", "utf8");
    // The files that make the real HOME unusable for a measurement.
    writeFileSync(path.join(realHome, ".grok", "config.toml"), "[mcp]\n", "utf8");
    mkdirSync(path.join(realHome, ".claude"), { recursive: true });
    writeFileSync(path.join(realHome, ".claude", "CLAUDE.md"), "route through keryx\n", "utf8");

    const isolated = createIsolatedHome(realHome);
    try {
      expect(existsSync(path.join(isolated.home, ".grok", "auth.json"))).toBe(true);
      expect(readlinkSync(path.join(isolated.home, ".grok", "auth.json"))).toBe(
        path.join(realHome, ".grok", "auth.json"),
      );
      // Nothing else came across. The instruction file is the one that matters:
      // it carries this project's routing block, and under it the context-off
      // arm would be told to route through a `.metaproject/` that was deleted.
      expect(existsSync(path.join(isolated.home, ".claude", "CLAUDE.md"))).toBe(false);
      expect(existsSync(path.join(isolated.home, ".grok", "config.toml"))).toBe(false);
    } finally {
      isolated.dispose();
    }
    expect(existsSync(isolated.home)).toBe(false);
  });

  test("missing credentials fail loudly before the sweep starts", () => {
    // Not at the first model call. An unauthenticated arm produces an empty
    // answer, which scores zero recall and is indistinguishable from an arm
    // that searched and found nothing.
    const empty = mkdtempSync(path.join(tmpdir(), "keryx-grok-noauth-"));
    expect(() => createIsolatedHome(empty)).toThrow(/no credentials/);
  });
});
