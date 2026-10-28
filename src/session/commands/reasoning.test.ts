import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeReasoningCommand } from "./reasoning";
import { runAgentRepl } from "../../commands/shell";
import { makeDeps, okReply, scriptedProvider } from "../../commands/agent.test-helpers";
import { loadShellConfig } from "../../lib/shell-config";
import { createMetaprojectAdapter } from "../../harness/tool/metaproject-adapter";

test("reasoning handler commits only valid permitted changes and preserves off spelling for local clients", () => {
  const seen: string[] = [];
  expect(executeReasoningCommand("high", { current: "off", commit: (effort) => { seen.push(effort); } })).toMatchObject({ ok: true, effort: "high", changed: true });
  expect(executeReasoningCommand("invalid", { current: "high", commit: (effort) => { seen.push(effort); } }).ok).toBe(false);
  expect(executeReasoningCommand("off", { current: "high", commit: (effort) => { seen.push(effort); } })).toMatchObject({ ok: true, effort: "off" });
  expect(seen).toEqual(["high", "off"]);
});

test("actual injected readline command entry executes the same reasoning operation with no model fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "keryx-native-reasoning-parity-"));
  const provider = scriptedProvider([okReply]); const deps = makeDeps(provider.provider, { reasoningEffort: "off" });
  const text: string[] = [];
  try {
    await runAgentRepl((async function* () { yield "/reasoning high"; yield "/reasoning impossible"; yield "/exit"; })(),
      { printPrompt: () => {}, safeBoundary: undefined, write: (value) => { text.push(value); } }, deps, createMetaprojectAdapter(root),
      { cwd: root, enabled: false }, undefined, undefined, undefined, join(root, "config"));
    let headlessEffort = "off";
    executeReasoningCommand("high", { current: headlessEffort, commit: (effort) => { headlessEffort = effort; } });
    expect(loadShellConfig(join(root, "config")).reasoningEffort).toBe(headlessEffort);
    expect(text.join("")).toContain("Unknown reasoning effort"); expect(provider.requests).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
