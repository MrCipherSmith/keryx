// Type validation in `entryProblems`, and the crash its absence caused.
//
// Reported in the review of PR #522: `entryProblems` checked the name, the
// command/url exclusivity and two timeouts — and nothing else. `expandEntry`
// then called `.map` on `args` and `.replace` on every `env`/`headers` value.
// A single committed `"args": "oops"` threw a TypeError out of
// `loadMcpServers`, through `createMcpRuntime` — documented as never throwing
// — and stopped `keryx shell` opening for everyone who checked the repo out.
//
// Each case below asserts BOTH halves: nothing throws, AND the bad entry is
// reported rather than silently skipped. A rejected entry nobody is told
// about is indistinguishable from one that was never written.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpServers } from "./config";
import { createMcpRuntime } from "./runtime";

function withServers(servers: Record<string, unknown>): { configDir: string; cwd: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-types-"));
  const configDir = path.join(base, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers }));
  return { configDir, cwd: base };
}

function load(servers: Record<string, unknown>): ReturnType<typeof loadMcpServers> {
  const { configDir, cwd } = withServers(servers);
  return loadMcpServers({ cwd, gitRoot: cwd, configDir, env: {} });
}

describe("a wrongly typed field is reported, not thrown", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["args as a string", { command: "x", args: "oops" }, "args must be an array of strings"],
    ["args holding a number", { command: "x", args: ["ok", 5] }, "args must be an array of strings"],
    ["env value as a number", { command: "x", env: { A: 5 } }, "values must all be strings"],
    ["env as an array", { command: "x", env: ["A=1"] }, "env must be an object"],
    ["headers value as a number", { url: "https://x", headers: { A: 1 } }, "values must all be strings"],
    ["command as a number", { command: 7 }, "sets neither command nor url"],
    ["cwd as a number", { command: "x", cwd: 3 }, "cwd must be a string"],
    ["tool_timeouts holding zero", { command: "x", tool_timeouts: { a: 0 } }, "tool_timeouts values"],
    ["tool_timeouts as a string", { command: "x", tool_timeouts: "fast" }, "tool_timeouts must be an object"],
  ];

  for (const [label, entry, expected] of cases) {
    test(label, () => {
      let result: ReturnType<typeof loadMcpServers> | undefined;
      expect(() => {
        result = load({ bad: entry });
      }).not.toThrow();

      expect(result?.servers).toEqual([]);
      expect(result?.problems.map((p) => p.message).join(" | ")).toContain(expected);
    });
  }
});

describe('"enabled" must be a boolean', () => {
  test('"false" as a string does NOT enable the server', () => {
    // Every non-empty string is truthy, so a server the operator meant to
    // switch off started, showed no `(disabled)` tag, and was reported
    // nowhere as a problem.
    const result = load({ off: { command: "x", enabled: "false" } });

    expect(result.servers).toEqual([]);
    expect(result.problems[0]?.message).toContain("enabled must be true or false");
  });

  test("a real boolean still works — anti-vacuity", () => {
    const result = load({ off: { command: "x", enabled: false } });
    expect(result.problems).toEqual([]);
    expect(result.servers[0]?.enabled).toBe(false);
  });
});

describe("a name that cannot be qualified is refused at load", () => {
  test("a leading digit is reported, instead of connecting with zero usable tools", () => {
    // `1password` is legal per specification §3 (letters, digits, hyphen,
    // underscore) but `catalog.ts`'s FQN_PATTERN requires a leading letter or
    // underscore. Before this, the server connected, `doctor` reported a tool
    // count, and every single tool was skipped from the catalog — visible
    // only as "the tools are not there".
    const result = load({ "1password": { command: "x" } });

    expect(result.servers).toEqual([]);
    expect(result.problems[0]?.message).toContain("must start with a letter or underscore");
  });

  test("a leading hyphen likewise", () => {
    expect(load({ "-verbose": { command: "x" } }).servers).toEqual([]);
  });

  test("a leading underscore is fine, and a normal name is fine", () => {
    expect(load({ _internal: { command: "x" } }).problems).toEqual([]);
    expect(load({ linear2: { command: "x" } }).problems).toEqual([]);
  });
});

describe("the shell survives every one of these", () => {
  test("createMcpRuntime does not throw on a config that used to crash it", async () => {
    // The end of the chain the crash actually travelled:
    // loadMcpServers → createMcpRuntime → shell.ts, unguarded.
    const { configDir, cwd } = withServers({ bad: { command: "x", args: "oops" } });

    let runtime: ReturnType<typeof createMcpRuntime> | undefined;
    expect(() => {
      runtime = createMcpRuntime({ cwd, gitRoot: cwd, configDir, connect: async () => ({}) as never });
    }).not.toThrow();

    await runtime?.ready();
    expect(runtime?.servers()).toEqual([]);
    // And the operator is told, which is what `reportMcpProblems` prints.
    expect(runtime?.problems().length).toBeGreaterThan(0);
    await runtime?.close();
  });
});
