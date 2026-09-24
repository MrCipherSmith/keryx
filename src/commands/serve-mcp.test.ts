// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC6.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { serveMcpCommand, resolveServeHarness } from "./serve-mcp";

test("resolveServeHarness: --harness wins over KERYX_HARNESS", () => {
  expect(resolveServeHarness(["--harness", "claude"], { KERYX_HARNESS: "codex" })).toBe("claude");
});

test("resolveServeHarness: KERYX_HARNESS is used when --harness is absent", () => {
  expect(resolveServeHarness([], { KERYX_HARNESS: "codex" })).toBe("codex");
});

test("resolveServeHarness: neither set -> undefined (unbound)", () => {
  expect(resolveServeHarness([], {})).toBeUndefined();
});

test("resolveServeHarness: an empty KERYX_HARNESS is treated as unset", () => {
  expect(resolveServeHarness([], { KERYX_HARNESS: "" })).toBeUndefined();
});

let originalLog: typeof console.log;
let originalError: typeof console.error;
let loggedErr: string[] = [];

beforeEach(() => {
  loggedErr = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = () => {};
  console.error = (...parts: unknown[]) => {
    loggedErr.push(parts.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = 0;
});

test("W4-AC6: an unknown --harness id fails closed (exit 1, named error) without starting the server", async () => {
  await serveMcpCommand(["--harness", "not-a-real-harness"], process.cwd());

  expect(process.exitCode).toBe(1);
  expect(loggedErr.join("\n")).toContain("Unknown --harness/KERYX_HARNESS identity");
  expect(loggedErr.join("\n")).toContain("not-a-real-harness");
});

test("W4-AC6: an unknown KERYX_HARNESS env id also fails closed", async () => {
  const previous = process.env.KERYX_HARNESS;
  process.env.KERYX_HARNESS = "not-a-real-harness";
  try {
    await serveMcpCommand([], process.cwd());
    expect(process.exitCode).toBe(1);
    expect(loggedErr.join("\n")).toContain("Unknown --harness/KERYX_HARNESS identity");
  } finally {
    if (previous === undefined) delete process.env.KERYX_HARNESS;
    else process.env.KERYX_HARNESS = previous;
  }
});
