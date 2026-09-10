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
import { addServer } from "./store";
import { createMcpRuntime } from "./runtime";

function withServers(
  servers: Record<string, unknown>,
  schemaVersion: unknown = 1,
): { configDir: string; cwd: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-types-"));
  const configDir = path.join(base, "config");
  mkdirSync(configDir, { recursive: true });
  const doc = schemaVersion === undefined ? { servers } : { schemaVersion, servers };
  writeFileSync(path.join(configDir, "mcp-servers.json"), JSON.stringify(doc));
  return { configDir, cwd: base };
}

/** Write EXACT JSON text, for values `JSON.stringify` cannot round-trip. */
function loadRaw(text: string): ReturnType<typeof loadMcpServers> {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-raw-"));
  const configDir = path.join(base, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "mcp-servers.json"), text);
  return loadMcpServers({ cwd: base, gitRoot: base, configDir, env: {} });
}

function load(
  servers: Record<string, unknown>,
  schemaVersion: unknown = 1,
): ReturnType<typeof loadMcpServers> {
  const { configDir, cwd } = withServers(servers, schemaVersion);
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

describe("things a second round of verification found still wrong", () => {
  // Every case here reproduced AFTER the first fix, on a green suite. They
  // are grouped so it stays visible that "fixed" and "verified fixed" are
  // different states.

  test("a long name is refused, instead of connecting and dropping tools", () => {
    // 56 characters loaded with ZERO problems, reported `connected`, and
    // silently dropped every tool whose `server__tool` exceeded 64 — and
    // `startServers` reports `toolCount` without `skipped`, so in a shell
    // there was no signal at all.
    const long = "github-copilot-language-server-for-the-monorepo-frontend";
    expect(long.length).toBe(56);
    const result = load({ [long]: { command: "x" } });

    expect(result.servers).toEqual([]);
    expect(result.problems[0]?.message).toContain("the limit is 40");
  });

  test("a 40-character name is accepted and a 41-character one is not", () => {
    expect(load({ ["a".repeat(40)]: { command: "x" } }).problems).toEqual([]);
    expect(load({ ["a".repeat(41)]: { command: "x" } }).servers).toEqual([]);
  });

  test("a future schemaVersion is refused rather than read with today's meaning", () => {
    // `schemaVersion` was never checked at all. `2` means "written by a
    // later keryx", and applying v1 semantics to it in silence is how a
    // newer field's meaning gets ignored.
    const result = load({}, 2);
    expect(result.problems[0]?.message).toContain("Upgrade keryx");
  });

  for (const [label, version] of [["zero", 0], ["string", "1"], ["float", 1.5], ["null", null]] as const) {
    test(`a ${label} schemaVersion is refused`, () => {
      expect(load({}, version).problems.length).toBeGreaterThan(0);
    });
  }

  test("an absent schemaVersion still reads as 1", () => {
    // The common case for a hand-written file, and the documented
    // divergence from the schema.
    expect(load({ ok: { command: "x" } }, undefined).problems).toEqual([]);
  });

  test("an empty url does not silently reclassify the transport", () => {
    // `{"command":"x","url":""}` loaded as stdio, so deleting the VALUE of
    // a url changed what the server was.
    const result = load({ s: { command: "x", url: "" } });
    expect(result.problems[0]?.message).toContain("empty url");
  });

  test("oauth is validated — the schema specifies it fully and nothing looked", () => {
    // The "unknown fields round-trip" allowance covers unknown fields; this
    // one is known.
    expect(load({ s: { url: "https://x", oauth: true } }).problems[0]?.message).toContain("oauth");
    expect(load({ s: { url: "https://x", oauth: "yes" } }).problems.length).toBeGreaterThan(0);
    // `false` disables discovery and an object configures it: both legal.
    expect(load({ s: { url: "https://x", oauth: false } }).problems).toEqual([]);
    expect(load({ s: { url: "https://x", oauth: { clientId: "a" } } }).problems).toEqual([]);
  });

  test("an unrepresentable timeout is refused, not silently turned into 1ms", () => {
    // `1e400` parses to Infinity, is a number, and is greater than zero. It
    // reached `setTimeout`, overflowed the 32-bit range, and Node
    // substituted 1ms — so the longest possible request became the
    // shortest, and the server was reported `failed`.
    //
    // Written as RAW JSON TEXT, not via `JSON.stringify`. The first version
    // of this test built the object in JS, where `1e400` is already
    // `Infinity` and `JSON.stringify` emits `null` — so the file contained
    // no large number at all and the assertion passed against a null. The
    // same defect class this whole round is about, in the test for it.
    expect(loadRaw('{"schemaVersion":1,"servers":{"s":{"command":"x","startup_timeout_sec":1e400}}}')
      .problems[0]?.message).toContain("finite");
    expect(loadRaw('{"schemaVersion":1,"servers":{"s":{"command":"x","tool_timeouts":{"a":1e400}}}}')
      .problems.length).toBeGreaterThan(0);

    // Finite but past what `setTimeout` can hold.
    expect(load({ s: { command: "x", startup_timeout_sec: 999_999_999 } }).problems[0]?.message).toContain(
      "at most",
    );
    // A sane value is untouched.
    expect(load({ s: { command: "x", startup_timeout_sec: 30 } }).problems).toEqual([]);
  });

  test("the raw-JSON helper really does deliver a non-finite number", () => {
    // Anti-vacuity for the test above: if `1e400` did not survive to the
    // parser as Infinity, the "finite" assertion would be checking
    // something else again.
    const doc = JSON.parse('{"n":1e400}') as { n: number };
    expect(Number.isFinite(doc.n)).toBe(false);
  });

  test("a UTF-8 BOM does not make a valid config 'not valid JSON'", () => {
    // Windows editors write one by default, and the error named JSON
    // rather than the byte.
    const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-bom-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      `\uFEFF${JSON.stringify({ schemaVersion: 1, servers: { s: { command: "x" } } })}`,
    );

    const result = loadMcpServers({ cwd: base, gitRoot: base, configDir, env: {} });
    expect(result.problems).toEqual([]);
    expect(result.servers.map((s) => s.name)).toEqual(["s"]);
  });
});

describe("what a THIRD round of verification found", () => {
  test("a server named __proto__ does not load clean and produce nothing", () => {
    // It passes the name rule, and `servers[name] = entry` then hits
    // `Object.prototype`'s setter instead of creating an own property — so
    // the file reported ZERO problems and ZERO servers. Not pollution;
    // exactly the load-clean-and-vanish shape this package keeps finding.
    // RAW JSON. `{ __proto__: x }` in a JavaScript object literal sets the
    // PROTOTYPE and creates no key at all, so building this case in JS
    // would test something else entirely — the same shape of mistake as
    // the `1e400` one above.
    const result = loadRaw(
      '{"schemaVersion":1,"servers":{"__proto__":{"command":"x"},"ok":{"command":"y"}}}',
    );

    expect(result.problems).toEqual([]);
    expect(result.servers.map((s) => s.name).sort()).toEqual(["__proto__", "ok"]);
    // And nothing was written to the real prototype.
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  test("other prototype-ish names still work", () => {
    const result = loadRaw(
      '{"schemaVersion":1,"servers":{"constructor":{"command":"a"},"toString":{"command":"b"}}}',
    );
    expect(result.servers.map((s) => s.name).sort()).toEqual(["constructor", "toString"]);
  });

  test("oauth's INTERIOR is validated, not just its type", () => {
    // The first pass checked "object or false" and left six
    // schema-specified rules unenforced. The unknown-field allowance
    // covers unknown fields, not a known one's contents.
    const bad: Array<[string, unknown]> = [
      ["clientId as a number", { clientId: 5 }],
      ["an unknown field", { bogus: 1 }],
      ["a port above the range", { callbackPort: 99999 }],
      ["a port below the range", { callbackPort: 0 }],
      ["scopes of numbers", { scopes: [1, 2] }],
      ["scopes as a string", { scopes: "a" }],
    ];
    for (const [label, oauth] of bad) {
      expect({ label, problems: load({ s: { url: "https://x", oauth } }).problems.length > 0 }).toEqual({
        label,
        problems: true,
      });
    }
    // And a valid one is accepted — anti-vacuity.
    expect(
      load({ s: { url: "https://x", oauth: { clientId: "a", scopes: ["b"], callbackPort: 8080 } } }).problems,
    ).toEqual([]);
  });

  test("a BOM is tolerated by every reader of these files, not just the loader", () => {
    // The strip landed in `parseConfigFile` alone — one of three readers.
    // The result was two surfaces disagreeing about one file: `list` read
    // it and `add` refused it, and a BOM on the OVERLAY made `disable` not
    // take effect while reporting success.
    const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-bom3-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      `\uFEFF${JSON.stringify({ schemaVersion: 1, servers: { s: { command: "x", enabled: false } } })}`,
    );
    writeFileSync(
      path.join(configDir, "mcp-servers-disabled.json"),
      `\uFEFF${JSON.stringify({ overrides: { s: false } })}`,
    );

    const loaded = loadMcpServers({ cwd: base, gitRoot: base, configDir, env: {} });
    expect(loaded.problems).toEqual([]);
    // The overlay was READ, so `disable` took effect rather than being
    // "ignored" while the server started.
    expect(loaded.servers[0]?.enabled).toBe(false);

    // And the writer agrees with the reader about the same file.
    const written = addServer({ name: "t", entry: { command: "y" }, scope: "user", configDir });
    expect(written.ok).toBe(true);
  });

  test("a BOM plus a genuine syntax error still reports the syntax error", () => {
    const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-bom4-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "mcp-servers.json"), '\uFEFF{"servers":{,}}');

    const result = loadMcpServers({ cwd: base, gitRoot: base, configDir, env: {} });
    expect(result.problems[0]?.message).toContain("not valid JSON");
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
