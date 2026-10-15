// Flow 389, AC10 invariant: no digest test reaches GitHub, Telegram or a model.
//
//   - Every digest run in a test is given a fake `gh` (`runGh`), a fake clock (`now`) and either a
//     fake summariser (`summarize`) or a scripted model provider (`makeProvider`). The defaults
//     (the real `gh`, the real model, the wall clock) are therefore never reached.
//   - Delivery runs on the in-process fake Bot API of src/remote, or on `FakeSink`; no test imports
//     the real Telegram client.
//   - No digest test or test helper names the Telegram host, imports a socket-level or process
//     module (the one `git init` in a temp directory is the single named exception), calls the
//     global fetch or spawns a process.
//   - The non-test digest modules reach the world only through the seams: they import no socket
//     or process module, call no global fetch and name no Telegram host. `gh` is reached through
//     `commands/trigger-agent-task`, and Telegram through the `DigestSink` serve injects.
//
// The scan has its own tests below so a loosened pattern cannot pass silently.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SCHEDULER_DIR = import.meta.dir;
const SRC_DIR = path.resolve(SCHEDULER_DIR, "..");
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
    // a declaration (`function name(`) is not a call
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

const schedulerSources = listFiles(SCHEDULER_DIR, (name) => name.endsWith(".ts")).map(load);
const production = [...schedulerSources.filter((entry) => !isTestFile(entry.name)), load(path.join(SRC_DIR, "commands", "serve-digest.ts")), load(path.join(SRC_DIR, "trigger", "digest-config.ts"))];
// This file spells the forbidden constructs out as scan fixtures, so it cannot scan itself.
const digestTests = [...schedulerSources.filter((entry) => isTestFile(entry.name) && path.basename(entry.name) !== SELF), load(path.join(SRC_DIR, "tui", "digest-surface.test.ts"))];
const helpers = digestTests.filter((entry) => entry.name.endsWith(".test-helpers.ts"));
const testFiles = digestTests.filter((entry) => entry.name.endsWith(".test.ts"));

describe("the digest tests cannot reach GitHub, Telegram or a model", () => {
  test("the scan sees the module and test set it is meant to guard", () => {
    expect(production.map((entry) => path.basename(entry.name))).toEqual(expect.arrayContaining(["digest-run.ts", "digest-delivery.ts", "digest-gh.ts", "digest-summary.ts", "digest-ticker.ts", "serve-digest.ts"]));
    expect(testFiles.map((entry) => path.basename(entry.name)).sort()).toEqual(
      [
        "digest-board-project.test.ts",
        "digest-board.test.ts",
        "digest-content.test.ts",
        "digest-delivery.test.ts",
        "digest-diff.test.ts",
        "digest-env.test.ts",
        "digest-limits.test.ts",
        "digest-report-locator.test.ts",
        "digest-run.test.ts",
        "digest-schedule.test.ts",
        "digest-surface.test.ts",
        "digest-tools-readonly.test.ts",
        "research-sync-job.test.ts",
        "scheduled-digest-docs.test.ts",
      ].sort(),
    );
    expect(helpers.map((entry) => path.basename(entry.name))).toContain("digest.test-helpers.ts");
  });

  test("no digest test or helper names the Telegram host, spawns a process, opens a socket or calls the global fetch", () => {
    const offenders = digestTests
      // the helper's `git init` is checked on its own in the next test
      .map((entry) => ({ file: entry.name, violations: testViolations(entry.text).filter((v) => v !== "imports node:child_process") }))
      .filter((entry) => entry.violations.length > 0);
    expect(offenders).toEqual([]);
  });

  test("the one process a test helper starts is `git init` in a temp directory", () => {
    const importers = digestTests.filter((entry) => importedSpecifiers(stripComments(entry.text)).some((s) => s.replace(/^node:/, "") === "child_process"));
    expect(importers.map((entry) => path.basename(entry.name))).toEqual(["digest.test-helpers.ts"]);
    const calls = callArguments(importers[0]?.text ?? "", "execFile");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\s*"git",\s*\["init", "-q", "-b", "main"\],\s*\{\s*cwd: root, env: \{ \.\.\.process\.env \}, timeout: 3_000, killSignal: "SIGKILL",\s*\},\s*\(error\) => error \? reject\(error\) : resolve\(\)\s*$/);
    // and nothing else of the process module is used
    expect(callArguments(importers[0]?.text ?? "", "(?:exec|execSync|spawn|spawnSync|fork|execFileSync)")).toEqual([]);
  });

  test("no test imports a real client: delivery runs on the in-process fake Bot API or on FakeSink", () => {
    for (const entry of digestTests) {
      expect(importedSpecifiers(stripComments(entry.text)).filter(isRealClientSpecifier)).toEqual([]);
    }
    const delivery = digestTests.find((entry) => entry.name.endsWith("digest-delivery.test.ts"));
    expect(importedSpecifiers(stripComments(delivery?.text ?? ""))).toContain("../remote/remote.test-helpers");
  });

  test("every digest run in a test is given a fake gh, a clock, and a fake or scripted model", () => {
    const offenders: string[] = [];
    let runs = 0;
    for (const entry of testFiles) {
      for (const argument of callArguments(entry.text, "runDigest")) {
        runs += 1;
        const missing = [/\brunGh:/.test(argument) ? "" : "runGh", /\bnow:/.test(argument) ? "" : "now", /\b(?:summarize|makeProvider):/.test(argument) ? "" : "summarize or makeProvider"].filter((m) => m !== "");
        if (missing.length > 0) offenders.push(`${entry.name}: runDigest without ${missing.join(", ")}`);
      }
    }
    expect(runs).toBeGreaterThanOrEqual(40);
    expect(offenders).toEqual([]);
  });

  test("a run that scripts a provider through makeProvider does not also reach the default summariser", () => {
    const offenders: string[] = [];
    for (const entry of testFiles) {
      for (const argument of callArguments(entry.text, "runDigest")) {
        if (/\bmakeProvider:/.test(argument) && /\bdefaultSummarize\b/.test(argument)) offenders.push(entry.name);
      }
      expect(stripComments(entry.text)).not.toMatch(/\bdefaultMakeProvider\b/);
      expect(stripComments(entry.text)).not.toMatch(/\bdefaultGhRunner\b/);
    }
    expect(offenders).toEqual([]);
  });

  test("a ticker in a test has a fake clock and a `fire` that is a fake, never the default serve wiring", () => {
    let tickers = 0;
    const offenders: string[] = [];
    for (const entry of testFiles) {
      for (const argument of callArguments(entry.text, "createDigestTicker")) {
        tickers += 1;
        if (!/\bnow:/.test(argument)) offenders.push(`${entry.name}: createDigestTicker without now`);
        if (!/\bfire:/.test(argument)) offenders.push(`${entry.name}: createDigestTicker without fire`);
        if (!/\bflush:/.test(argument)) offenders.push(`${entry.name}: createDigestTicker without flush`);
      }
      expect(importedSpecifiers(stripComments(entry.text)).filter((s) => /serve-digest$/.test(s))).toEqual([]);
    }
    expect(tickers).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });

  test("every schedule command in a test is given a recording host, so no OS timer and no process is started", () => {
    const surface = digestTests.find((entry) => entry.name.endsWith("digest-surface.test.ts"));
    const calls = callArguments(surface?.text ?? "", "scheduleCommand");
    expect(calls.length).toBeGreaterThan(0);
    for (const argument of calls) {
      expect(argument).toMatch(/\bhost\b/);
      expect(argument).toMatch(/\bnow:/);
      expect(argument).toMatch(/\benv: \{\}/);
    }
  });

  test("the test environment points HOME away from the developer's, so no stored key or gh login is read", () => {
    const code = stripComments(helpers.find((entry) => entry.name.endsWith("digest.test-helpers.ts"))?.text ?? "");
    expect(code).toContain('process.env["HOME"] = keyHome');
    expect(code).toContain('process.env["XDG_DATA_HOME"]');
  });
});

describe("the digest modules reach the world only through their seams", () => {
  test("no non-test digest module imports a socket or process module, calls the global fetch, or names the Telegram host", () => {
    const offenders = production
      .map((entry) => ({ file: entry.name, violations: productionViolations(entry.text) }))
      .filter((entry) => entry.violations.length > 0);
    expect(offenders).toEqual([]);
  });

  test("no non-test digest module imports a real Telegram client; delivery is the injected DigestSink", () => {
    for (const entry of production) {
      expect(importedSpecifiers(stripComments(entry.text)).filter(isRealClientSpecifier)).toEqual([]);
    }
  });

  test("gh and the model are the injected runGh and summarize, defaulting to the one gh runner and summariser of the trigger path", () => {
    const run = production.find((entry) => entry.name.endsWith("digest-run.ts"));
    const code = stripComments(run?.text ?? "");
    expect(code).toContain("runGh: deps.runGh ?? defaultGhRunner");
    expect(code).toContain("deps.summarize ?? defaultSummarize");
    expect(code).toContain("deps.now ?? (() => new Date())");
    // the default runner is a thin wrapper of the granted-command runner the rest of the trigger
    // path uses (execFile, no shell), not a second gh client
    const gh = production.find((entry) => entry.name.endsWith("digest-gh.ts"));
    const ghCode = stripComments(gh?.text ?? "");
    expect(importedSpecifiers(ghCode)).toContain("../commands/trigger-agent-task");
    expect(ghCode).toContain("runGrantedCommand(call.bin, call.argv, call.cwd, call.env, call.signal, call.secrets)");
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
    const source = `await runDigest(env, name, {\n  runGh: gh(")").run,\n  now: clock.now,\n});\nfunction runDigest(a) {}\nrunDigestLater();`;
    const calls = callArguments(source, "runDigest");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('runGh: gh(")").run');
    expect(calls[0]).toContain("now: clock.now");
  });

  test("a run missing a fake is caught", () => {
    const argument = callArguments(`await runDigest(env, name, { now: clock.now });`, "runDigest")[0] ?? "";
    expect(/\brunGh:/.test(argument)).toBe(false);
    expect(/\b(?:summarize|makeProvider):/.test(argument)).toBe(false);
  });
});
