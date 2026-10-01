// AC14 invariant: nothing in src/remote can reach the network except two client
// files, and no test here talks to Telegram.
//
//   - bot-api-http.ts is the one client of Telegram.
//   - client.ts is the shell's client of the LOCAL serve: it may call fetch, but
//     only against an address read from endpoint.json that it has checked is a
//     loopback address, and it never names the Telegram host.
//   - channels-client.ts (flow 377) is the shell's client of the channels plane of the
//     same serve, held to the same rule as client.ts.
//   - Non-test sources other than those three import no socket-level node module
//     and call no global fetch (nor WebSocket, XMLHttpRequest, Bun.serve,
//     Bun.connect, Bun.listen).
//   - Only bot-api-http.ts may name the Telegram host, comments included.
//   - No test or test helper names the Telegram host, imports a socket-level
//     module or calls the global fetch: the HTTP client is tested with an
//     injected stand-in and the rest runs on the in-process fake.
//
// The scan has its own tests below so a loosened pattern cannot pass silently.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REMOTE_DIR = import.meta.dir;
const THE_CLIENT = "bot-api-http.ts";
const THE_LOCAL_CLIENT = "client.ts";
const THE_CHANNELS_CLIENT = "channels-client.ts";
const LOCAL_CLIENTS = [THE_LOCAL_CLIENT, THE_CHANNELS_CLIENT];
const TELEGRAM_HOST = ["api", "telegram", "org"].join(".");
const NETWORK_MODULES = ["http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises", "child_process", "worker_threads", "cluster"];

function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts") || name.endsWith(".test-helpers.ts");
}

function listSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(REMOTE_DIR);
  return out;
}

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
      if (ch === quote) {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
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
  const bare = specifier.replace(/^node:/, "");
  return NETWORK_MODULES.includes(bare);
}

const GLOBAL_NETWORK_CALLS = [/\bglobalThis\s*\.\s*fetch\b/, /\bBun\s*\.\s*(?:serve|connect|listen|udpSocket)\b/, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /\bEventSource\b/];
const BARE_FETCH = /\bfetch\b/;

function productionViolations(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const specifier of importedSpecifiers(code)) {
    if (isNetworkSpecifier(specifier)) {
      found.push(`imports ${specifier}`);
    }
  }
  if (BARE_FETCH.test(code)) {
    found.push("uses fetch");
  }
  for (const pattern of GLOBAL_NETWORK_CALLS) {
    if (pattern.test(code)) {
      found.push(`uses ${pattern.source}`);
    }
  }
  return found;
}

function testViolations(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const specifier of importedSpecifiers(code)) {
    if (isNetworkSpecifier(specifier)) {
      found.push(`imports ${specifier}`);
    }
  }
  for (const pattern of GLOBAL_NETWORK_CALLS) {
    if (pattern.test(code)) {
      found.push(`uses ${pattern.source}`);
    }
  }
  return found;
}

describe("src/remote cannot reach the network except through its one client", () => {
  const files = listSources().map((file) => ({ file, name: path.basename(file), text: readFileSync(file, "utf8") }));
  const production = files.filter((entry) => !isTestFile(entry.name));
  const allTests = files.filter((entry) => isTestFile(entry.name));
  // This file spells the forbidden constructs out as scan fixtures, so it cannot scan itself.
  const tests = allTests.filter((entry) => entry.name !== path.basename(import.meta.path));

  test("the scan sees the module set it is meant to guard", () => {
    expect(production.length).toBeGreaterThanOrEqual(12);
    expect(production.map((entry) => entry.name)).toContain(THE_CLIENT);
    expect(allTests.length).toBeGreaterThanOrEqual(8);
  });

  test("non-test sources other than the client import no socket module and call no global fetch", () => {
    const offenders = production
      .filter((entry) => entry.name !== THE_CLIENT && !LOCAL_CLIENTS.includes(entry.name))
      .map((entry) => ({ file: entry.name, violations: productionViolations(entry.text) }))
      .filter((entry) => entry.violations.length > 0);
    expect(offenders).toEqual([]);
  });

  test("the client itself imports no socket module", () => {
    const client = production.find((entry) => entry.name === THE_CLIENT);
    expect(importedSpecifiers(stripComments(client?.text ?? "")).filter(isNetworkSpecifier)).toEqual([]);
  });

  for (const clientName of LOCAL_CLIENTS) {
    test(`${clientName} imports no socket module, and builds its one URL only after the loopback check`, () => {
      const local = production.find((entry) => entry.name === clientName);
      expect(local).toBeDefined();
      const code = stripComments(local?.text ?? "");
      expect(importedSpecifiers(code).filter(isNetworkSpecifier)).toEqual([]);
      // The one place a URL is built is `target`, and the check sits in it.
      expect(code.match(/`http:\/\//g)?.length).toBe(1);
      const target = code.slice(code.indexOf("private target("), code.indexOf("private async post("));
      expect(target).toContain("isLoopbackAddress(");
      expect(target.indexOf("isLoopbackAddress(")).toBeLessThan(target.indexOf("`http://"));
      // No other network primitive, and no other host.
      for (const pattern of GLOBAL_NETWORK_CALLS) {
        expect(pattern.test(code)).toBe(false);
      }
      expect(code).not.toContain("https://");
    });
  }

  test("only the client names the Telegram host", () => {
    const naming = files.filter((entry) => entry.text.includes(TELEGRAM_HOST)).map((entry) => entry.name);
    expect(naming).toEqual([THE_CLIENT]);
  });

  test("no test or test helper names the Telegram host", () => {
    expect(tests.filter((entry) => entry.text.includes(TELEGRAM_HOST)).map((entry) => entry.name)).toEqual([]);
  });

  test("no test or test helper opens a socket or calls the global fetch", () => {
    const offenders = tests
      .map((entry) => ({ file: entry.name, violations: testViolations(entry.text) }))
      .filter((entry) => entry.violations.length > 0);
    expect(offenders).toEqual([]);
  });

  test("the shared serve listener does not import src/remote (the surface is injected by the composition root)", () => {
    const serveServer = readFileSync(path.join(REMOTE_DIR, "..", "lib", "serve-server.ts"), "utf8");
    expect(importedSpecifiers(stripComments(serveServer)).filter((specifier) => /(^|\/)remote(\/|$)/.test(specifier))).toEqual([]);
  });
});

describe("the scan itself", () => {
  test("flags socket imports in every spelling", () => {
    for (const line of [
      `import http from "node:http";`,
      `import { request } from "https";`,
      `const net = require("node:net");`,
      `const m = await import("node:tls");`,
      `import dns from 'node:dns/promises';`,
    ]) {
      expect(productionViolations(line)).not.toEqual([]);
    }
  });

  test("flags fetch and the other network globals", () => {
    for (const line of [
      `await fetch(url);`,
      `await globalThis.fetch(url);`,
      `const s = Bun.serve({ port: 0 });`,
      `new WebSocket("wss://x");`,
      `const r = new XMLHttpRequest();`,
    ]) {
      expect(productionViolations(line)).not.toEqual([]);
    }
  });

  test("ignores the same words inside comments, and names such as fetchImpl", () => {
    expect(productionViolations(`// fetch and node:http are discussed here\n/* globalThis.fetch */\nconst fetchImpl = 1;`)).toEqual([]);
  });

  test("does not mistake a URL in a string for a comment", () => {
    expect(productionViolations(`const u = "http://example.invalid"; await fetch(u);`)).toContain("uses fetch");
  });

  test("tests may stub fetch by type but may not call the global", () => {
    expect(testViolations(`const stub = (async () => new Response("")) as typeof fetch;`)).toEqual([]);
    expect(testViolations(`await globalThis.fetch("http://x.invalid");`)).not.toEqual([]);
    expect(testViolations(`import net from "node:net";`)).not.toEqual([]);
  });
});
