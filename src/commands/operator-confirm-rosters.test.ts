// Flow 456: the operator card tools exist in ONE roster — the interactive TUI shell's. They are absent from
// the MCP tool registry, ACP sessions, spawn_subagent child rosters and the readline (non-TUI) shell, so a
// second surface never grows a way to put a decision to the operator that it cannot render or protect.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildAcpSessionTools } from "../acp/roster";
import { createSpawnSubagentTool } from "../harness/tool/builtin/spawn-subagent-tool";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort } from "../harness/provider/types";
import { buildToolRegistry } from "../mcp/tools";
import { OPERATOR_CONFIRM_TOOL_NAMES } from "../trigger/unattended";
import { operatorConfirmToolNames } from "./operator-confirm-tools";

const NAMES = operatorConfirmToolNames();

test("there are 17 operator card tools to keep out of the other rosters", () => {
  expect(NAMES).toHaveLength(17);
});

test("the unattended exclusion list names exactly the registered operator card tools", () => {
  expect([...OPERATOR_CONFIRM_TOOL_NAMES].sort()).toEqual([...NAMES].sort());
});

test("the MCP tool registry offers none of them", () => {
  const names = buildToolRegistry().map((entry) => entry.name);
  for (const name of NAMES) expect(names).not.toContain(name);
});

test("an ACP session roster offers none of them", () => {
  const names = buildAcpSessionTools({
    root: "/nonexistent-root",
    clientCapabilities: undefined,
    readViaClient: async () => "",
  }).map((tool) => tool.definition.name);
  for (const name of NAMES) expect(names).not.toContain(name);
});

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

test("a spawn_subagent child is offered none of them, in either mode", async () => {
  for (const mode of ["read_only", "general"] as const) {
    const offered: string[] = [];
    const provider: ProviderPort = {
      describe: () => DESCRIPTION,
      stream: (request: NormalizedRequest, opts) => {
        for (const tool of request.tools ?? []) offered.push(tool.name);
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "done" } as NormalizedEvent;
          yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
        })();
      },
    };
    let seq = 0;
    const tool = createSpawnSubagentTool({
      cwd: process.cwd(),
      getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
      makeProvider: () => provider,
      getDetectedProviders: () => [{ name: "anthropic" }],
      idSeq: () => `id-${seq++}`,
      clock: () => "2026-10-15T00:00:00.000Z",
    });
    await tool.invoke({ task: "list your tools", mode });
    expect(offered.length).toBeGreaterThan(0);
    for (const name of NAMES) expect(offered).not.toContain(name);
  }
});

test("the readline shell's roster is built without the operatorConfirm binding; only the TUI's is", () => {
  const source = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const calls: string[] = [];
  const re = /buildInteractiveAgentTools\(\{\s*\n/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const open = source.indexOf("{", m.index);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && --depth === 0) {
        calls.push(source.slice(open, i + 1));
        break;
      }
    }
  }
  expect(calls).toHaveLength(2);
  expect(calls.filter((call) => /\boperatorConfirm:/.test(call))).toHaveLength(1);
  const readline = calls.find((call) => call.includes("slateSessionBox.current?.dir"));
  expect(readline).toBeDefined();
  expect(readline).not.toMatch(/\boperatorConfirm\b/);
});
