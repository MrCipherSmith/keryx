// Flow 346 — `/external` command matching + status rendering. Pure
// functions, no I/O — mirrors `route-command.test.ts`'s own shape.

import { describe, expect, test } from "bun:test";
import { DEFAULT_EXTERNAL_PROVIDERS_CONFIG } from "../lib/external-providers";
import { EXTERNAL_COMMAND, isExternalCommand, renderExternalSidebarValue, renderExternalStatusLines } from "./external-command";

test("EXTERNAL_COMMAND is /external", () => {
  expect(EXTERNAL_COMMAND).toBe("/external");
});

describe("isExternalCommand", () => {
  test("matches the bare token, with or without arguments", () => {
    expect(isExternalCommand("/external")).toBe(true);
    expect(isExternalCommand("/external on")).toBe(true);
    expect(isExternalCommand("/external off")).toBe(true);
    expect(isExternalCommand("  /external  ")).toBe(true);
  });

  test("does not match an unrelated line or a different command", () => {
    expect(isExternalCommand("/externally")).toBe(false);
    expect(isExternalCommand("/route")).toBe(false);
    expect(isExternalCommand("hello /external")).toBe(false);
  });
});

describe("renderExternalSidebarValue", () => {
  test("is the bare state word", () => {
    expect(renderExternalSidebarValue({ value: "on", source: "default" })).toBe("on");
    expect(renderExternalSidebarValue({ value: "off", source: "user" })).toBe("off");
  });
});

describe("renderExternalStatusLines", () => {
  test("external on: no block list, notes it plainly", () => {
    const lines = renderExternalStatusLines({ value: "on", source: "default" }, false, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    expect(lines[0]).toContain("external: on");
    expect(lines[0]).toContain("source: default");
    expect(lines.some((l) => l.includes("not resolved"))).toBe(true);
    expect(lines.some((l) => l.includes("blocked right now: nothing"))).toBe(true);
  });

  test("external off: lists every provider/pattern with its reason", () => {
    const lines = renderExternalStatusLines({ value: "off", source: "project" }, true, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    expect(lines[0]).toContain("external: off");
    expect(lines.some((l) => l.includes("available"))).toBe(true);
    expect(lines.some((l) => l.includes("jev"))).toBe(true);
    expect(lines.some((l) => l.includes("deepseek/*"))).toBe(true);
  });
});
