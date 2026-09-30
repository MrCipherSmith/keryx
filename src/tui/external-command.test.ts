// Flow 346 — `/external` command matching + status rendering. Pure
// functions, no I/O — mirrors `route-command.test.ts`'s own shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadExternalAgentsConfig } from "../capability/external-agents";
import { DEFAULT_EXTERNAL_PROVIDERS_CONFIG } from "../lib/external-providers";
import {
  EXTERNAL_AGENTS_COMMAND,
  EXTERNAL_COMMAND,
  isExternalAgentsCommand,
  isExternalCommand,
  renderExternalSidebarValue,
  renderExternalStatusLines,
  runExternalAgentsCommand,
} from "./external-command";

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

describe("/external-agents (flow 373)", () => {
  test("is its own token and never collides with /external", () => {
    expect(EXTERNAL_AGENTS_COMMAND).toBe("/external-agents");
    expect(isExternalAgentsCommand("/external-agents")).toBe(true);
    expect(isExternalAgentsCommand("  /external-agents on ")).toBe(true);
    expect(isExternalAgentsCommand("/external")).toBe(false);
    expect(isExternalAgentsCommand("/external on")).toBe(false);
    expect(isExternalCommand("/external-agents on")).toBe(false);
  });

  test("on / off write the user flag through the same functions as the CLI, bare shows the state", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keryx-ea-cmd-"));
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-ea-cfg-"));
    try {
      const off = await runExternalAgentsCommand("", root, dir);
      expect(off).toContain("keryx agents external enable");

      const on = await runExternalAgentsCommand("ON", root, dir);
      expect(on).toContain("enabled");
      expect(loadExternalAgentsConfig(dir).enabled).toBe(true);

      const again = await runExternalAgentsCommand("on", root, dir);
      expect(again).toContain("nothing changed");

      const back = await runExternalAgentsCommand("off", root, dir);
      expect(back).not.toContain("nothing changed");
      expect(loadExternalAgentsConfig(dir).enabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown argument prints the usage and says it is not /external", async () => {
    const text = await runExternalAgentsCommand("maybe", "/nonexistent-root", "/nonexistent-cfg");
    expect(text).toContain("Unknown /external-agents argument 'maybe'");
    expect(text).toContain("/external-agents [on|off]");
    expect(text).toContain("privacy switch");
  });
});
