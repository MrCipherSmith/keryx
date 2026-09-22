// Flow 290 T7 (AC4, AC5): the unattended posture, through the REAL agent
// driver (`runAgentTurn`), not a unit of the classifier alone.
//
// Every forbidden case runs under permission mode `trust` — the mode that
// would otherwise auto-approve a non-destructive `shell_exec`/`apply_patch`
// with no prompt — and must come back denied, with the denial recorded and the
// tool never invoked. The allowed controls prove the floor is not simply
// denying everything.

import { describe, expect, test } from "bun:test";
import { runAgentTurn, type AgentDeps, type AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";
import type { ToolRisk } from "../harness/tool/types";
import { UNATTENDED_EXCLUDED_TOOLS, unattendedRefusal } from "../trigger/unattended";
import { buildUnattendedRoster } from "./trigger-dispatch";

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

function scripted(rounds: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function fakeTool(name: string, risk: ToolRisk, ran: string[]): InteractiveTool {
  return {
    definition: {
      name,
      description: name,
      risk,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    },
    invoke: async () => {
      ran.push(name);
      return { output: "ran", isError: false };
    },
  } as unknown as InteractiveTool;
}

async function runUnattended(
  tool: "shell_exec" | "apply_patch",
  input: Record<string, unknown>,
): Promise<{ ran: string[]; denials: { tool: string; reason: string }[]; asked: number }> {
  const ran: string[] = [];
  const denials: { tool: string; reason: string }[] = [];
  let asked = 0;
  const deps: AgentDeps = {
    provider: scripted([
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: tool },
        { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify(input) },
        { kind: "model_end" },
      ],
      [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
    ]),
    providerId: "scripted",
    modelId: "m",
    tools: [fakeTool("shell_exec", "shell", ran), fakeTool("apply_patch", "write", ran)],
    systemInstruction: "sys",
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    unattended: true,
    hardDeny: unattendedRefusal,
  };
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => "trust",
    readOnly: () => false,
    requestApproval: async () => {
      asked += 1;
      return false;
    },
    onUnattendedDenial: (t, reason) => denials.push({ tool: t, reason }),
  };
  await runAgentTurn(io, deps, [], "go");
  return { ran, denials, asked };
}

function patchFor(file: string): string {
  return [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
}

const FORBIDDEN_SHELL: readonly [string, string][] = [
  ["git push", "git push"],
  ["git push to a named remote/branch", "git push origin trigger/290-T1"],
  ["git -C push", "git -C ../other push --force"],
  ["git push hidden in sh -c", "sh -c 'git push origin HEAD'"],
  ["git merge", "git merge main"],
  ["git tag", "git tag v9.9.9"],
  ["gh pr merge", "gh pr merge 12 --squash"],
  ["gh release", "gh release create v1"],
  ["npm publish", "npm publish"],
  ["bun publish", "bun publish --access public"],
  ["flow freeze", "keryx flow freeze 290"],
  ["flow ac update", "keryx flow ac update 290 --reason x"],
  ["flow ac reseal", "keryx flow ac reseal 290 --reason x"],
  ["flow ac confirm", "keryx flow ac confirm 290 AC1"],
  ["flow implemented", "keryx flow implemented 290 --pr https://x"],
  ["flow complete", "keryx flow complete 290"],
  ["flow renumber", "keryx flow renumber 290 --to 291 --reason x"],
  ["flow block", "keryx flow block 290 --reason x"],
  ["flow unblock", "keryx flow unblock 290"],
  ["flow task add", "keryx flow task add 290 --title x --kind implement"],
  ["flow task depends", "keryx flow task depends 290 T2 --on T1 --reason x"],
  ["shell write to flow.json", "echo '{}' > .metaproject/flows/290-x/flow.json"],
  ["shell write to acceptance-criteria.md", "sed -i 's/a/b/' .metaproject/flows/290-x/acceptance-criteria.md"],
  ["shell write to triggers.json", "cp /tmp/x .metaproject/triggers.json"],
  ["shell write to the trigger record", "truncate -s 0 .metaproject/data/trigger/runs.jsonl"],
];

const FORBIDDEN_PATCH: readonly [string, string][] = [
  ["flow.json", ".metaproject/flows/290-x/flow.json"],
  ["acceptance-criteria.md", ".metaproject/flows/290-x/acceptance-criteria.md"],
  ["triggers.json", ".metaproject/triggers.json"],
  ["the trigger run record", ".metaproject/data/trigger/runs.jsonl"],
];

describe("AC5: the unattended floor is checked before the mode — `trust` cannot lift it", () => {
  test.each(FORBIDDEN_SHELL)("shell_exec: %s is denied and recorded", async (_label, command) => {
    const { ran, denials, asked } = await runUnattended("shell_exec", { command });
    expect(ran).toEqual([]);
    expect(asked).toBe(0);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.tool).toBe("shell_exec");
    expect(denials[0]!.reason.length).toBeGreaterThan(0);
  });

  test.each(FORBIDDEN_PATCH)("apply_patch writing %s is denied and recorded", async (_label, file) => {
    const { ran, denials, asked } = await runUnattended("apply_patch", { patch: patchFor(file) });
    expect(ran).toEqual([]);
    expect(asked).toBe(0);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.tool).toBe("apply_patch");
    expect(denials[0]!.reason).toContain(file);
  });

  test("controls: ordinary work still runs under trust (the floor is not a blanket deny)", async () => {
    const shell = await runUnattended("shell_exec", { command: "bun test src/foo.test.ts" });
    expect(shell.ran).toEqual(["shell_exec"]);
    expect(shell.denials).toEqual([]);
    const patch = await runUnattended("apply_patch", { patch: patchFor("src/foo.ts") });
    expect(patch.ran).toEqual(["apply_patch"]);
    expect(patch.denials).toEqual([]);
  });
});

describe("AC4: a call that would ask under trust (credential floor) reaches the approver and is denied, never run", () => {
  test("a command touching the agent's credential files", async () => {
    const { ran, asked } = await runUnattended("shell_exec", { command: "cat ~/.local/share/keryx/auth.json" });
    expect(asked).toBe(1);
    expect(ran).toEqual([]);
  });
});

describe("AC5: the unattended tool roster", () => {
  test("is exactly the enumerated set, and excludes web, MCP, subagent and ask_user tools", () => {
    const names = buildUnattendedRoster("/tmp").map((t) => t.definition.name).sort();
    expect(names).toEqual(["apply_patch", "get_cwd", "list_dir", "read_file", "shell_exec"]);
    for (const excluded of ["web_fetch", "web_search", "search_tool", "use_tool", "spawn_subagent", "ask_user"]) {
      expect(UNATTENDED_EXCLUDED_TOOLS).toContain(excluded);
      expect(names).not.toContain(excluded);
    }
  });
});
