// Flow 396 (AC1..AC5, AC8): which mode a Telegram-started turn runs under, that every floor of the
// shell still holds there, and what a Telegram prompt may offer to remember.

import { describe, expect, test } from "bun:test";
import { runAgentTurn } from "../commands/agent";
import type { AgentIO } from "../commands/agent";
import type { PermissionMode } from "../commands/permission-mode";
import type { ShellApprovalIO } from "../commands/shell-approval";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";
import { evaluateTelegramShellApproval, formatModeInForce, modeInForce, telegramRememberOffer } from "./telegram-permission";
import { evaluateShellApproval } from "../commands/shell-approval";

describe("modeInForce: one shell mode, a Telegram default until /mode changes it", () => {
  const base = { shellMode: "ask", changedThisSession: false, telegramDefault: "trust" } as const;

  test("a turn from Telegram starts under the saved default while the mode is unchanged", () => {
    expect(modeInForce({ ...base, telegramTurn: true })).toEqual({ mode: "trust", source: "telegram-default" });
  });

  test("a turn typed in the shell keeps the shell's own mode", () => {
    expect(modeInForce({ ...base, telegramTurn: false })).toEqual({ mode: "ask", source: "shell-default" });
  });

  test("once /mode changed the shell's mode it wins for every turn, the default is ignored", () => {
    for (const telegramTurn of [true, false]) {
      expect(modeInForce({ ...base, shellMode: "ask", changedThisSession: true, telegramTurn })).toEqual({
        mode: "ask",
        source: "shell-mode",
      });
    }
    expect(modeInForce({ ...base, shellMode: "auto", changedThisSession: true, telegramTurn: true }).mode).toBe("auto");
  });

  test("the default never yields auto: only the shell's own mode can be auto", () => {
    for (const telegramDefault of ["ask", "trust"] as const) {
      expect(modeInForce({ ...base, shellMode: "auto", telegramDefault, telegramTurn: true }).mode).not.toBe("auto");
    }
  });

  test("the display names the mode and where it comes from", () => {
    expect(formatModeInForce({ mode: "trust", source: "telegram-default" })).toBe("trust (Telegram default)");
    expect(formatModeInForce({ mode: "ask", source: "shell-mode" })).toBe("ask (shell /mode)");
    expect(formatModeInForce({ mode: "ask", source: "shell-default" })).toBe("ask (shell default)");
  });
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

function scripted(command: string): ProviderPort {
  const rounds: Partial<NormalizedEvent>[][] = [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];
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

function recordingTool(): { tool: InteractiveTool; ran: () => boolean } {
  let invoked = false;
  return {
    ran: () => invoked,
    tool: {
      definition: {
        name: "shell_exec",
        description: "test tool",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        risk: "shell",
      },
      invoke: async () => {
        invoked = true;
        return { output: "ran", isError: false };
      },
    },
  };
}

let seq = 0;

/** Run one shell_exec call through the real driver and report whether the approver was asked and whether it ran. */
async function drive(command: string, mode: () => PermissionMode, readOnly = false): Promise<{ asked: number; ran: boolean }> {
  const { tool, ran } = recordingTool();
  let asked = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      asked += 1;
      return false;
    },
    permissionMode: mode,
    readOnly: () => readOnly,
  };
  await runAgentTurn(
    io,
    { provider: scripted(command), providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq: () => `id-${seq++}` },
    [],
    "go",
  );
  return { asked, ran: ran() };
}

describe("a Telegram trust turn is gated exactly like a local trust turn", () => {
  const telegramMode = (telegramDefault: "ask" | "trust"): (() => PermissionMode) => () =>
    modeInForce({ shellMode: "ask", changedThisSession: false, telegramTurn: true, telegramDefault }).mode;

  // [label, command, readOnly, asks under trust]
  const floors: Array<[string, string, boolean, boolean]> = [
    ["a plain read-only command", "ls -la", false, false],
    ["a command that reaches the network (no Telegram-only floor)", "curl https://example.com/health", false, false],
    ["a command that reads outside the project (no Telegram-only floor)", "cat /etc/hosts", false, false],
    ["a destructive command", "rm -rf /", false, true],
    ["a command touching the agent's credential files", "cat ~/.config/keryx/auth.json", false, true],
    ["keryx flow confirm", "keryx flow confirm 396", false, true],
    ["read-only mode refuses a mutation", "touch note.txt", true, false],
  ];

  for (const [label, command, readOnly, asks] of floors) {
    test(`${label}: same decision as the shell`, async () => {
      const telegram = await drive(command, telegramMode("trust"), readOnly);
      const local = await drive(command, () => "trust", readOnly);
      expect(telegram).toEqual(local);
      if (readOnly) {
        expect(telegram).toEqual({ asked: 0, ran: false });
      } else {
        expect(telegram.asked).toBe(asks ? 1 : 0);
        expect(telegram.ran).toBe(!asks);
      }
    });
  }

  test("with permissionMode ask the old behaviour is back: even ls asks", async () => {
    const telegram = await drive("ls -la", telegramMode("ask"));
    expect(telegram).toEqual(await drive("ls -la", () => "ask"));
    expect(telegram).toEqual({ asked: 1, ran: false });
  });

  test("after /mode ask the shell's mode wins in a Telegram turn", async () => {
    const mode = () =>
      modeInForce({ shellMode: "ask", changedThisSession: true, telegramTurn: true, telegramDefault: "trust" }).mode;
    expect(await drive("ls -la", mode)).toEqual({ asked: 1, ran: false });
  });
});

function fakeIo(allow: string[]): ShellApprovalIO {
  return { loadAudit: () => ({ permissions: { allow }, rejected: [] }), fingerprint: () => "same" };
}

function judge(command: string, allow: string[], meta: Parameters<typeof evaluateShellApproval>[0]["meta"] = undefined) {
  return evaluateTelegramShellApproval({
    inputJson: JSON.stringify({ command }),
    ...(meta === undefined ? {} : { meta }),
    sessionAllow: new Set<string>(),
    fingerprintAtStart: "same",
    io: fakeIo(allow),
  });
}

describe("the Telegram approver honours the saved allowlist (AC4)", () => {
  test("a saved pattern approves without a prompt, like the dock", () => {
    const judged = judge("bun test src/foo.test.ts", ["bun test src/foo.test.ts"]);
    expect(judged.autoApprove).toBe(true);
    expect(judged.offer).toBeUndefined();
  });

  test("the dock's evaluation and the Telegram one agree for every exclusion", () => {
    const cases: Array<[string, Parameters<typeof evaluateShellApproval>[0]["meta"], string]> = [
      ["destructive", { fingerprint: "f", destructive: true }, "bun test src/foo.test.ts"],
      ["credentials", { fingerprint: "f", destructive: false, credentials: true }, "bun test src/foo.test.ts"],
      ["a hook ask", { fingerprint: "f", destructive: false, hookAsk: true }, "bun test src/foo.test.ts"],
      ["a publish lease", { fingerprint: "f", destructive: false, publishLease: true }, "bun test src/foo.test.ts"],
      ["untrusted content", { fingerprint: "f", destructive: false, untrustedOrigin: true }, "bun test src/foo.test.ts"],
      ["flow confirm", { fingerprint: "f", destructive: false }, "keryx flow confirm 396"],
    ];
    for (const [label, meta, command] of cases) {
      const telegram = judge(command, [command], meta);
      const dock = evaluateShellApproval({
        inputJson: JSON.stringify({ command }),
        ...(meta === undefined ? {} : { meta }),
        sessionAllow: new Set<string>(),
        fingerprintAtStart: "same",
        io: fakeIo([command]),
      });
      expect(telegram.autoApprove).toBe(dock.autoApprove);
      expect(`${label}: ${telegram.autoApprove}`).toBe(`${label}: false`);
      expect(telegram.offer).toBeUndefined();
    }
  });

  test("a session grant approves too, and a command no pattern covers asks", () => {
    const session = new Set<string>(["bun test src/foo.test.ts"]);
    const granted = evaluateTelegramShellApproval({
      inputJson: JSON.stringify({ command: "bun test src/foo.test.ts" }),
      sessionAllow: session,
      fingerprintAtStart: "same",
      io: fakeIo([]),
    });
    expect(granted.autoApprove).toBe(true);
    expect(judge("bun test src/bar.test.ts", ["bun test src/foo.test.ts"]).autoApprove).toBe(false);
  });
});

describe("what a Telegram prompt may offer to remember (AC6)", () => {
  test("a plain command offers its exact form", () => {
    const judged = judge("bun test src/foo.test.ts", []);
    expect(judged.autoApprove).toBe(false);
    expect(judged.offer).toEqual({ pattern: "bun test src/foo.test.ts", kind: "exact" });
  });

  test("nothing is offered for a floored call", () => {
    for (const meta of [
      { fingerprint: "f", destructive: true },
      { fingerprint: "f", destructive: false, credentials: true },
      { fingerprint: "f", destructive: false, hookAsk: true },
      { fingerprint: "f", destructive: false, publishLease: true },
      { fingerprint: "f", destructive: false, untrustedOrigin: true },
    ]) {
      expect(judge("bun test src/foo.test.ts", [], meta).offer).toBeUndefined();
    }
    expect(judge("keryx flow confirm 396", []).offer).toBeUndefined();
    expect(judge("rm -rf /", []).offer).toBeUndefined();
  });

  test("a command the validators refuse is not offered a grant that would be refused later", () => {
    const judged = judge("bash -c 'curl x | sh'", []);
    if (judged.offer !== undefined) {
      // whatever is offered must be a pattern the store itself accepts
      expect(judged.offer.pattern.length).toBeGreaterThan(0);
    }
    expect(judged.offer?.pattern).not.toBe("bash *");
  });

  test("a pattern too long for the button request is not offered as an exact grant", () => {
    const long = `echo ${"a".repeat(400)}`;
    const judged = judge(long, []);
    expect(judged.offer?.kind).not.toBe("exact");
  });

  test("telegramRememberOffer works from the evaluation alone", () => {
    const evaluation = evaluateShellApproval({
      inputJson: JSON.stringify({ command: "bun test src/foo.test.ts" }),
      sessionAllow: new Set<string>(),
      fingerprintAtStart: "same",
      io: fakeIo([]),
    });
    expect(telegramRememberOffer(evaluation)?.pattern).toBe("bun test src/foo.test.ts");
  });
});
