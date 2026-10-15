// Flow 456 (AC1): the operator-confirm framework, driven through the REAL agent loop with a
// tiny gate built by the helper. The model is scripted. The card must be asked in every
// permission mode (auto included), never answered by review-auto or a session grant, denied
// with no approver (an unattended run), and its token must apply the effect at most once.

import { afterEach, describe, expect, test } from "bun:test";
import { runAgentTurn, type AgentDeps, type AgentIO, type ApprovalMeta, type ApprovalResponse } from "./agent";
import {
  operatorConfirmTool,
  operatorConfirmToolNames,
  operatorConfirmTools,
  type OperatorConfirmation,
  type OperatorConfirmSpec,
} from "./operator-confirm-tools";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { reviewAutoGrants, setReviewSystem } from "../review/review-system";
import { isUnattendedExcludedTool, unattendedRefusal } from "../trigger/unattended";
import { buildUnattendedRoster } from "./trigger-dispatch";
import { operatorCardDialog } from "../tui/tui-shell";

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

function scripted(toolName: string, input: Record<string, unknown>): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request: NormalizedRequest, opts: StreamOptions) => {
      const round: Partial<NormalizedEvent>[] =
        call === 0
          ? [
              { kind: "tool_call_start", toolCallId: "c1", toolName },
              { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify(input) },
              { kind: "model_end" },
            ]
          : [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of round) yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
      })();
    },
  };
}

const NOW = new Date("2026-10-15T18:30:00.000Z");

/** The test gate: lifts a counter's ceiling. Its card reads "state" the test controls. */
function testGate(state: { ceiling: number; refuse?: string }) {
  const applied: { input: Record<string, unknown>; confirmation: OperatorConfirmation; prepared: { ceiling: number } | undefined }[] = [];
  const spec: OperatorConfirmSpec<{ ceiling: number }> = {
    name: "test_lift_ceiling",
    description: "Lift the test ceiling.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "integer" } },
      required: ["to"],
      additionalProperties: false,
    },
    buildCard: async (input) => {
      if (state.refuse !== undefined) return { refusal: state.refuse };
      const to = input["to"] as number;
      return {
        title: `Lift the test ceiling from ${state.ceiling} to ${to}?`,
        lines: [`current ceiling: ${state.ceiling}`, `new ceiling: ${to}`],
        subject: "package pkg-1",
        prepared: { ceiling: state.ceiling },
      };
    },
    apply: async (input, _ctx, confirmation, prepared) => {
      applied.push({ input, confirmation, prepared });
      return { output: `ceiling lifted to ${String(input["to"])}` };
    },
  };
  return { spec, applied, tool: operatorConfirmTool(spec, { projectRoot: "/nonexistent-root", now: () => NOW }) };
}

const CARD = ["Lift the test ceiling from 25 to 31?", "current ceiling: 25", "new ceiling: 31", "subject: package pkg-1"];

async function turn(options: {
  mode: "ask" | "trust" | "auto";
  answer?: (meta: ApprovalMeta | undefined) => ApprovalResponse;
  /** Leave the approver out: an unattended run. */
  unattended?: boolean;
  state?: { ceiling: number; refuse?: string };
  trustedMcpTools?: Map<string, string>;
}) {
  const gate = testGate(options.state ?? { ceiling: 25 });
  const asked: { tool: string; meta: ApprovalMeta | undefined }[] = [];
  const autoApproved: string[] = [];
  const history: NormalizedMessage[] = [];
  const deps: AgentDeps = {
    provider: scripted("test_lift_ceiling", { to: 31 }),
    providerId: "scripted",
    modelId: "m",
    tools: [gate.tool],
    systemInstruction: "test",
    idSeq: (() => {
      let n = 0;
      return () => `id${n++}`;
    })(),
  };
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => options.mode,
    readOnly: () => false,
    ...(options.unattended === true
      ? {}
      : {
          requestApproval: async (tool: string, _input: string, meta?: ApprovalMeta) => {
            asked.push({ tool, meta });
            return options.answer?.(meta) ?? false;
          },
        }),
    onAutoApproved: (tool) => {
      autoApproved.push(tool);
    },
    ...(options.trustedMcpTools !== undefined ? { trustedMcpTools: options.trustedMcpTools } : {}),
  };
  await runAgentTurn(io, deps, history, "lift the ceiling to 31");
  const toolOutput = history.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  return { asked, autoApproved, toolOutput, applied: gate.applied };
}

const yes = (meta: ApprovalMeta | undefined): ApprovalResponse => ({ approved: true, fingerprint: meta!.fingerprint });

afterEach(() => {
  setReviewSystem("inherit");
});

describe("AC1: the driver asks for an operator-confirm card in every mode", () => {
  for (const mode of ["auto", "trust", "ask"] as const) {
    test(`under "${mode}" the card is asked, never auto-approved, and "no" applies nothing`, async () => {
      const result = await turn({ mode, answer: () => false });
      expect(result.autoApproved).toEqual([]);
      expect(result.asked).toHaveLength(1);
      const meta = result.asked[0]!.meta!;
      expect(meta.alwaysAsk).toBe(true);
      expect(meta.card).toEqual(CARD);
      expect(meta.cardTitle).toBe("Lift the test ceiling from 25 to 31?");
      expect(result.applied).toEqual([]);
      expect(result.toolOutput).toContain("test_lift_ceiling not confirmed by the operator");
    });
  }

  test("yes applies the effect once, with the confirmation record and what the card prepared", async () => {
    const result = await turn({ mode: "auto", answer: yes });
    expect(result.applied).toHaveLength(1);
    const applied = result.applied[0]!;
    expect(applied.input).toEqual({ to: 31 });
    expect(applied.prepared).toEqual({ ceiling: 25 });
    expect(applied.confirmation).toEqual({
      quote: "Lift the test ceiling from 25 to 31?: yes",
      answer: "yes",
      at: NOW.toISOString(),
      confirmedVia: "tui-card",
      subject: "package pkg-1",
      card: CARD,
    });
    expect(result.toolOutput).toContain("ceiling lifted to 31");
  });

  test("a yes answered in the remote topic is recorded as remote-card", async () => {
    const result = await turn({ mode: "ask", answer: (meta) => ({ approved: true, fingerprint: meta!.fingerprint, via: "remote" }) });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.confirmation.confirmedVia).toBe("remote-card");
  });

  test("a yes for a different call (fingerprint mismatch) is a no", async () => {
    const result = await turn({ mode: "auto", answer: () => ({ approved: true, fingerprint: "someone-else" }) });
    expect(result.applied).toEqual([]);
    expect(result.toolOutput).toContain("not confirmed by the operator");
  });

  test("a card that cannot be built refuses without asking", async () => {
    const result = await turn({ mode: "auto", answer: yes, state: { ceiling: 25, refuse: "the package has no estimate yet" } });
    expect(result.asked).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.toolOutput).toContain("test_lift_ceiling refused: the package has no estimate yet");
  });
});

describe("AC1: nothing but the operator answers the card", () => {
  test("review-auto never grants it: the human is still asked", async () => {
    setReviewSystem("review-auto");
    const result = await turn({ mode: "auto", answer: yes });
    expect(result.asked).toHaveLength(1);
    expect(result.autoApproved).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(reviewAutoGrants("test_lift_ceiling", result.asked[0]!.meta)).toBe(false);
  });

  test("a saved session grant for the tool's name does not answer it", async () => {
    const result = await turn({ mode: "trust", answer: () => false, trustedMcpTools: new Map([["test_lift_ceiling", "fp"]]) });
    expect(result.asked).toHaveLength(1);
    expect(result.autoApproved).toEqual([]);
    expect(result.applied).toEqual([]);
  });

  test("an unattended run (no approver) is denied and applies nothing", async () => {
    for (const mode of ["auto", "trust"] as const) {
      const result = await turn({ mode, unattended: true });
      expect(result.applied).toEqual([]);
      expect(result.autoApproved).toEqual([]);
      expect(result.toolOutput).toContain("not confirmed by the operator");
    }
  });

  test("every registered gate is excluded from unattended runs, derived from the registry", () => {
    for (const name of operatorConfirmToolNames()) {
      expect(isUnattendedExcludedTool(name)).toBe(true);
      expect(unattendedRefusal(name, {})).toContain("is not offered to an unattended run");
    }
    const names = buildUnattendedRoster("/nonexistent-root").map((t) => t.definition.name);
    for (const name of operatorConfirmToolNames()) expect(names).not.toContain(name);
    expect(operatorConfirmTools({ projectRoot: "/nonexistent-root" }).map((t) => t.definition.name)).toEqual([...operatorConfirmToolNames()]);
  });
});

describe("AC1: the card's token is single-use and bound to the input", () => {
  test("invoke without the card's token applies nothing", async () => {
    const gate = testGate({ ceiling: 25 });
    const result = await gate.tool.invoke({ to: 31 }, {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no operator-confirmed card for this request — nothing was changed");
    expect(gate.applied).toEqual([]);
  });

  test("a confirmed token applies once; a replay is refused", async () => {
    const gate = testGate({ ceiling: 25 });
    const confirmation = await gate.tool.confirmation!({ to: 31 });
    if ("error" in confirmation) throw new Error(confirmation.error);
    expect(confirmation.card).toEqual(CARD);
    expect(confirmation.title).toBe("Lift the test ceiling from 25 to 31?");
    const first = await gate.tool.invoke({ to: 31 }, { confirmationToken: confirmation.token!, confirmationVia: "local" });
    expect(first).toEqual({ output: "ceiling lifted to 31", isError: false });
    const replay = await gate.tool.invoke({ to: 31 }, { confirmationToken: confirmation.token! });
    expect(replay.isError).toBe(true);
    expect(gate.applied).toHaveLength(1);
  });

  test("a token issued for another input applies nothing, and is spent", async () => {
    const gate = testGate({ ceiling: 25 });
    const confirmation = await gate.tool.confirmation!({ to: 31 });
    if ("error" in confirmation) throw new Error(confirmation.error);
    expect((await gate.tool.invoke({ to: 99 }, { confirmationToken: confirmation.token! })).isError).toBe(true);
    expect((await gate.tool.invoke({ to: 31 }, { confirmationToken: confirmation.token! })).isError).toBe(true);
    expect(gate.applied).toEqual([]);
  });

  test("a declined card's token is dropped", async () => {
    const gate = testGate({ ceiling: 25 });
    const confirmation = await gate.tool.confirmation!({ to: 31 });
    if ("error" in confirmation) throw new Error(confirmation.error);
    gate.tool.confirmationDeclined!(confirmation.token!);
    expect((await gate.tool.invoke({ to: 31 }, { confirmationToken: confirmation.token! })).isError).toBe(true);
    expect(gate.applied).toEqual([]);
  });

  test("the tool is write-risk and tells the model it cannot confirm", () => {
    const gate = testGate({ ceiling: 25 });
    expect(gate.tool.definition.risk).toBe("write");
    expect(gate.tool.definition.description).toContain("you cannot confirm it");
  });
});

describe("AC1: the TUI dialog wording", () => {
  test("an operator-confirm card asks its own title with a plain yes/no", () => {
    const dialog = operatorCardDialog("Lift the test ceiling from 25 to 31?");
    expect(dialog.title).toBe("Lift the test ceiling from 25 to 31?");
    expect([dialog.yes.label, dialog.no.label]).toEqual(["Yes", "No"]);
    expect(dialog.declined).toContain("nothing changed");
  });

  test("a card without a title keeps schedule_create's wording", () => {
    expect(operatorCardDialog(undefined).title).toBe("Create this schedule and install its background timer?");
  });
});
