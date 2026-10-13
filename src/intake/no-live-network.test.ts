// Flow 403, AC21 invariant: no intake test reaches GitHub, Telegram or a model.
//
//   - Every poll or flush in a test is given deps built by `depsFor` (a fake `gh`, a fake clock, and a fake sink and
//     assessor). The defaults (the real gh runner, the wall clock, no sink) are never what a test exercises.
//   - Delivery runs on `FakeSink`; no test imports a real Telegram client.
//   - No intake test or helper names the Telegram host, imports a socket-level or process module (the one `git init`
//     in a temp directory is the single named exception), calls the global fetch or spawns a process.
//   - The non-test intake modules reach the world only through the seams: they import no socket or process module,
//     call no global fetch and name no Telegram host. `gh` is reached through the digest runner, and Telegram
//     through the `IntakeCardSink` that serve injects.
//
// The scan has its own tests below so a loosened pattern cannot pass silently.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FakeGh, TestClock, depsFor, local, setupIntakeEnv, testConfig } from "./intake.test-helpers";
import { runIntakePoll } from "./poll";
import { readIntakeState } from "./store";

const INTAKE_DIR = import.meta.dir;
const SRC_DIR = path.resolve(INTAKE_DIR, "..");
const SELF = path.basename(import.meta.path);
const TELEGRAM_HOST = ["api", "telegram", "org"].join(".");
const NETWORK_MODULES = ["http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises", "child_process", "worker_threads", "cluster"];
const REAL_CLIENTS = ["bot-api-http", "remote/client", "remote/channels-client"];

/** Remove comments, keeping string and template contents (so a URL in a string is not mistaken for a comment). */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (quote !== undefined) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;

function importedSpecifiers(code: string): string[] {
  return [...code.matchAll(SPECIFIER)].map((match) => match[1] as string);
}

function isNetworkSpecifier(specifier: string): boolean {
  return NETWORK_MODULES.includes(specifier.replace(/^node:/, ""));
}

function isRealClientSpecifier(specifier: string): boolean {
  return REAL_CLIENTS.some((client) => specifier === client || specifier.endsWith(`/${client}`));
}

const GLOBAL_NETWORK_CALLS = [/\bglobalThis\s*\.\s*fetch\b/, /\bBun\s*\.\s*(?:serve|connect|listen|udpSocket|spawn|spawnSync|\$)\b/, /\bBun\s*\.\s*\$/, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /\bEventSource\b/];
const BARE_FETCH_CALL = /(?<![.\w])fetch\s*\(/;

function violations(source: string, options: { allowFetchStub: boolean }): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const specifier of importedSpecifiers(code)) {
    if (isNetworkSpecifier(specifier)) found.push(`imports ${specifier}`);
    if (isRealClientSpecifier(specifier)) found.push(`imports the real client ${specifier}`);
  }
  if (BARE_FETCH_CALL.test(code)) found.push("calls fetch");
  if (!options.allowFetchStub && /\bfetch\b/.test(code)) found.push("names fetch");
  for (const pattern of GLOBAL_NETWORK_CALLS) {
    if (pattern.test(code)) found.push(`uses ${pattern.source}`);
  }
  if (code.includes(TELEGRAM_HOST)) found.push("names the Telegram host");
  return found;
}

const productionViolations = (source: string): string[] => violations(source, { allowFetchStub: false });
const testViolations = (source: string): string[] => violations(source, { allowFetchStub: true });

/** The text between the parenthesis that opens at `open` and its match, skipping string contents. */
function balanced(code: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i] as string;
    if (quote !== undefined) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** The argument text of every call to `name(` in `source`. */
function callArguments(source: string, name: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const pattern = new RegExp(`(?<![.\\w])${name}\\s*\\(`, "g");
  for (const match of code.matchAll(pattern)) {
    if (/function\s+$/.test(code.slice(0, match.index))) continue;
    found.push(balanced(code, (match.index as number) + match[0].length - 1));
  }
  return found;
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

const isTestFile = (name: string): boolean => name.endsWith(".test.ts") || name.endsWith(".test-helpers.ts");
const load = (file: string): { name: string; text: string } => ({ name: path.relative(SRC_DIR, file), text: readFileSync(file, "utf8") });

const intakeSources = listFiles(INTAKE_DIR, (name) => name.endsWith(".ts")).map(load);
const production = [...intakeSources.filter((entry) => !isTestFile(entry.name)), load(path.join(SRC_DIR, "commands", "intake.ts"))];
// This file spells the forbidden constructs out as scan fixtures, so it cannot scan itself.
const intakeTests = intakeSources.filter((entry) => isTestFile(entry.name) && path.basename(entry.name) !== SELF);
const helpers = intakeTests.filter((entry) => entry.name.endsWith(".test-helpers.ts"));
const testFiles = intakeTests.filter((entry) => entry.name.endsWith(".test.ts"));

const POLL_ENTRY_POINTS = ["runIntakePoll", "flushIntakeCards", "runIntakeTick"];

describe("the intake tests cannot reach GitHub, Telegram or a model", () => {
  test("the scan sees the module and test set it is meant to guard", () => {
    expect(production.map((entry) => path.basename(entry.name))).toEqual(expect.arrayContaining(["poll.ts", "events.ts", "store.ts", "report.ts", "status.ts", "config.ts", "types.ts", "intake.ts"]));
    expect(testFiles.map((entry) => path.basename(entry.name)).sort()).toEqual(
      [
        "intake-allowlist.test.ts",
        "intake-baseline.test.ts",
        "intake-buttons.test.ts",
        "intake-card.test.ts",
        "intake-ci-triage.test.ts",
        "intake-dedupe.test.ts",
        "intake-decline-later.test.ts",
        "intake-delivery-integrity.test.ts",
        "intake-events.test.ts",
        "intake-failures.test.ts",
        "intake-limits-accounts.test.ts",
        "intake-no-ports.test.ts",
        "intake-press-guards.test.ts",
        "intake-quiet-limits.test.ts",
        "intake-readonly.test.ts",
        "intake-report.test.ts",
        "intake-restart.test.ts",
        "intake-review-flow.test.ts",
        "intake-status.test.ts",
        "intake-take-failure.test.ts",
        "intake-take.test.ts",
        "intake-work-root.test.ts",
      ].sort(),
    );
    expect(helpers.map((entry) => path.basename(entry.name))).toContain("intake.test-helpers.ts");
  });

  test("no intake test or helper names the Telegram host, spawns a process, opens a socket or calls the global fetch", () => {
    const offenders = intakeTests
      // the helper's `git init` is checked on its own in the next test
      .map((entry) => ({ file: entry.name, violations: testViolations(entry.text).filter((v) => v !== "imports node:child_process") }))
      .filter((entry) => entry.violations.length > 0);
    expect(offenders).toEqual([]);
  });

  test("the one process a test helper starts is `git init` in a temp directory", () => {
    const importers = intakeTests.filter((entry) => importedSpecifiers(stripComments(entry.text)).some((s) => s.replace(/^node:/, "") === "child_process"));
    expect(importers.map((entry) => path.basename(entry.name))).toEqual(["intake.test-helpers.ts"]);
    const calls = callArguments(importers[0]?.text ?? "", "execFileSync");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\s*"git",\s*\["init", "-q", "-b", "main"\],\s*\{ cwd: root \}\s*$/);
    expect(callArguments(importers[0]?.text ?? "", "(?:exec|execSync|spawn|spawnSync|fork|execFile)")).toEqual([]);
  });

  test("no test imports a real client: delivery runs on FakeSink", () => {
    for (const entry of intakeTests) {
      expect(importedSpecifiers(stripComments(entry.text)).filter(isRealClientSpecifier)).toEqual([]);
    }
    expect(stripComments(helpers.find((entry) => entry.name.endsWith("intake.test-helpers.ts"))?.text ?? "")).toContain("class FakeSink");
  });

  test("every poll, flush and tick in a test is given deps built by depsFor, so gh, the clock and the sink are fakes", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const entry of testFiles) {
      for (const name of POLL_ENTRY_POINTS) {
        for (const argument of callArguments(entry.text, name)) {
          calls += 1;
          if (!/\bdeps\b|\bdepsFor\(|\bpersonalDeps\b|\bnoSink\b|\bthrowing\b/.test(argument)) offenders.push(`${entry.name}: ${name}(${argument.trim().slice(0, 60)}) without depsFor deps`);
        }
      }
      // a deps variable is only ever built by depsFor, never by hand or from the defaults
      for (const match of stripComments(entry.text).matchAll(/\b(?:const|let)\s+(\w*[dD]eps|noSink)\s*=\s*([^;]*)/g)) {
        if (!/^\s*(?:\{\s*\.\.\.\s*)?depsFor\(/.test(match[2] as string)) offenders.push(`${entry.name}: ${match[1]} not built by depsFor`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(60);
    expect(offenders).toEqual([]);
  });

  test("no test reaches the default gh runner, the default model, or the real binary lookup", () => {
    for (const entry of intakeTests) {
      const code = stripComments(entry.text);
      expect(code).not.toMatch(/\bdefaultGhRunner\b/);
      expect(code).not.toMatch(/\bdefaultAssess\w*\b/);
      expect(code).not.toMatch(/\bdefaultMakeProvider\b/);
    }
  });

  test("the intake tests that live outside src/intake (TUI, hub callback route, CLI ports) are held to the same rules", () => {
    const outside = [
      load(path.join(SRC_DIR, "tui", "intake-surface.test.ts")),
      load(path.join(SRC_DIR, "remote", "intake-callback-route.test.ts")),
      load(path.join(SRC_DIR, "commands", "intake-ports.test.ts")),
    ];
    expect(outside.map((entry) => path.basename(entry.name))).toEqual(["intake-surface.test.ts", "intake-callback-route.test.ts", "intake-ports.test.ts"]);
    for (const entry of outside) {
      const code = stripComments(entry.text);
      // the ports test runs local `sh` children on purpose (it tests the process runner); everything else may not spawn
      const spawnsLocally = path.basename(entry.name) === "intake-ports.test.ts";
      const found = testViolations(entry.text).filter((v) => !(spawnsLocally && /child_process|Bun/.test(v)));
      expect({ file: entry.name, found }).toEqual({ file: entry.name, found: [] });
      expect(code).not.toMatch(/\bdefaultGhRunner\b|\bdefaultAssess\w*\b|\bdefaultMakeProvider\b/);
      expect(importedSpecifiers(code).filter(isRealClientSpecifier)).toEqual([]);
      for (const name of POLL_ENTRY_POINTS) {
        for (const argument of callArguments(entry.text, name)) expect(argument).toMatch(/\bdeps\b|\bdepsFor\(/);
      }
    }
  });

  test("the test environment points HOME away from the developer's, so no stored key or gh login is read", () => {
    const code = stripComments(helpers.find((entry) => entry.name.endsWith("intake.test-helpers.ts"))?.text ?? "");
    expect(code).toContain('process.env["HOME"] = home');
    expect(code).toContain('process.env["XDG_DATA_HOME"]');
    expect(code).toMatch(/HOME: home/);
  });

  test("every CLI poll in a test runs with the intake disabled, so no gh is started", () => {
    const status = testFiles.find((entry) => entry.name.endsWith("intake-status.test.ts"));
    const code = stripComments(status?.text ?? "");
    const polls = [...code.matchAll(/run\(\[\s*"poll"/g)];
    expect(polls.length).toBeGreaterThan(0);
    expect(code).toContain("setupIntakeEnv({ config: { enabled: false } })");
  });
});

describe("the intake modules reach the world only through their seams", () => {
  test("no non-test intake module imports a socket or process module, calls the global fetch, or names the Telegram host", () => {
    const offenders = production
      .map((entry) => ({ file: entry.name, violations: productionViolations(entry.text) }))
      .filter((entry) => entry.violations.length > 0);
    expect(offenders).toEqual([]);
  });

  test("no non-test intake module imports a real Telegram client; delivery is the injected IntakeCardSink", () => {
    for (const entry of production) {
      expect(importedSpecifiers(stripComments(entry.text)).filter(isRealClientSpecifier)).toEqual([]);
    }
  });

  test("gh is the injected runGh, defaulting to the one digest gh runner", () => {
    const poll = production.find((entry) => entry.name.endsWith("poll.ts"));
    const code = stripComments(poll?.text ?? "");
    expect(code).toMatch(/runGh:\s*deps\.runGh\s*\?\?\s*defaultGhRunner/);
    expect(importedSpecifiers(code)).toContain("../scheduler/digest-gh");
  });

  test("the clock is the injected now, and the wall clock only when none is injected (behaviour, not source text)", async () => {
    const injected = await setupIntakeEnv();
    const wall = await setupIntakeEnv();
    try {
      for (const e of [injected, wall]) e.setBoard([{ id: "F1", title: "A flow", status: "open" }]);
      const fixed = local(12);
      const clock = new TestClock(fixed);
      await runIntakePoll(injected.root, depsFor(injected, { gh: new FakeGh(), clock, config: testConfig() }));
      expect((await readIntakeState(injected.root)).lastPollAt).toBe(fixed.toISOString());

      const before = Date.now();
      const { now: _injectedNow, ...rest } = depsFor(wall, { gh: new FakeGh(), clock: new TestClock(fixed), config: testConfig() });
      void _injectedNow;
      await runIntakePoll(wall.root, rest);
      const stamp = Date.parse((await readIntakeState(wall.root)).lastPollAt ?? "");
      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(Date.now());
    } finally {
      try {
        await wall.teardown();
      } finally {
        await injected.teardown();
      }
    }
  });
});

describe("the scan itself", () => {
  test("flags socket and process imports in every spelling", () => {
    for (const line of [`import http from "node:http";`, `import { request } from "https";`, `const net = require("node:net");`, `const m = await import("node:tls");`, `import { spawn } from "node:child_process";`]) {
      expect(productionViolations(line)).not.toEqual([]);
      expect(testViolations(line)).not.toEqual([]);
    }
  });

  test("flags fetch, spawn and the other network globals, and the Telegram host", () => {
    for (const line of [`await fetch(url);`, `await globalThis.fetch(url);`, `Bun.serve({ port: 0 });`, `Bun.spawn(["gh"]);`, `new WebSocket("wss://x");`, `const u = "https://${TELEGRAM_HOST}/bot";`]) {
      expect(productionViolations(line)).not.toEqual([]);
      expect(testViolations(line)).not.toEqual([]);
    }
  });

  test("flags a real client import", () => {
    expect(testViolations(`import { createBotApi } from "../remote/bot-api-http";`)).toContain("imports the real client ../remote/bot-api-http");
    expect(testViolations(`import { x } from "../remote/remote.test-helpers";`)).toEqual([]);
  });

  test("ignores the same words inside comments, and names such as fetchImpl", () => {
    expect(productionViolations(`// fetch and node:http and ${TELEGRAM_HOST} are discussed here\n/* globalThis.fetch */\nconst fetchImpl = 1;`)).toEqual([]);
  });

  test("tests may stub fetch by type but may not call the global", () => {
    expect(testViolations(`const stub = (async () => new Response("")) as typeof fetch;`)).toEqual([]);
    expect(testViolations(`await fetch("http://x.invalid");`)).toContain("calls fetch");
  });

  test("the call scan reads a multi-line call to its matching parenthesis and skips strings", () => {
    const source = `await runIntakePoll(root, {\n  runGh: gh(")").run,\n  now: clock.now,\n});\nfunction runIntakePoll(a) {}\nrunIntakePollLater();`;
    const calls = callArguments(source, "runIntakePoll");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('runGh: gh(")").run');
  });

  test("a poll given hand-built deps is caught", () => {
    const argument = callArguments(`await runIntakePoll(root, { now: clock.now });`, "runIntakePoll")[0] ?? "";
    expect(/\bdeps\b|\bdepsFor\(/.test(argument)).toBe(false);
    const built = [...`const deps = { runGh: real };`.matchAll(/\b(?:const|let)\s+(\w*[dD]eps)\s*=\s*([^;]*)/g)][0];
    expect(/^\s*(?:\{\s*\.\.\.\s*)?depsFor\(/.test(built?.[2] as string)).toBe(false);
  });
});
