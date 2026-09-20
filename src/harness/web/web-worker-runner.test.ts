import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_ACCEPT,
  BROWSER_ACCEPT_LANGUAGES,
  BROWSER_HEADERS_SOURCE,
  BROWSER_STATIC_HEADERS,
  BROWSER_USER_AGENTS,
  SystemWebWorkerRunner,
} from "./web-worker-runner";

test("system web worker fails closed on an unsupported host", async () => {
  const runner = new SystemWebWorkerRunner({ platform: "win32", workspace: "/project", home: "/home/user" });
  await expect(runner.run({ url: "https://example.com", hostname: "example.com", address: "93.184.216.34", method: "GET" }))
    .resolves.toEqual({ ok: false, reason: "web sandbox launcher is unavailable" });
});

test("browser-shaped headers are real browsers, rotated, and never claim compression", () => {
  expect(BROWSER_USER_AGENTS.length).toBeGreaterThanOrEqual(5);
  for (const ua of BROWSER_USER_AGENTS) {
    expect(ua.startsWith("Mozilla/5.0")).toBe(true);
  }
  expect(BROWSER_ACCEPT_LANGUAGES.length).toBeGreaterThanOrEqual(3);
  expect(BROWSER_ACCEPT).toContain("text/html");
  // The worker reads bodies as text and cannot decode compression, so it must
  // not advertise any.
  expect(BROWSER_STATIC_HEADERS["accept-encoding"]).toBe("identity");
  expect(BROWSER_STATIC_HEADERS["sec-fetch-mode"]).toBe("navigate");
  expect(BROWSER_STATIC_HEADERS["sec-fetch-dest"]).toBe("document");
});

test("the shipped header source embeds exactly the exported lists", () => {
  // The worker is evaluated from a string and cannot import these constants,
  // so the source carries them. Editing one side alone would silently ship a
  // header set no test describes — this is the check that fails when it does.
  expect(BROWSER_HEADERS_SOURCE).toContain(JSON.stringify(BROWSER_USER_AGENTS));
  expect(BROWSER_HEADERS_SOURCE).toContain(JSON.stringify(BROWSER_ACCEPT_LANGUAGES));
  expect(BROWSER_HEADERS_SOURCE).toContain(JSON.stringify(BROWSER_STATIC_HEADERS));
  expect(BROWSER_HEADERS_SOURCE).toContain(JSON.stringify(BROWSER_ACCEPT));
});

test("the worker evaluates that source rather than a second copy of it", () => {
  const source = readFileSync(join(import.meta.dir, "web-worker-runner.ts"), "utf8");
  expect(source).toContain("const browserHeaders = ${BROWSER_HEADERS_SOURCE};");
  expect(source).toContain("input.browserHeaders");
});
