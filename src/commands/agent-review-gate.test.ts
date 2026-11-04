// A managed review is finished when `keryx review complete` accepts the package. Live run 10:
// the repeated-signature guard ended the turn through the no-progress branch, which skipped
// the text-only completion gate, and the model's last words were "resend the request".

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO, RunAgentTurnOptions } from "./agent";
import { ReviewGateAbortedError, type findReviewGateState } from "../review/completion-gate";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription, ProviderPort } from "../harness/provider/types";

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

function scriptedProvider(rounds: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "resend the request" }, { kind: "model_end" }];
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

/** {@link scriptedProvider} that also counts the model calls it answers. */
function countingProvider(rounds: Partial<NormalizedEvent>[][]): { provider: ProviderPort; calls: () => number } {
  const inner = scriptedProvider(rounds);
  let calls = 0;
  const provider: ProviderPort = {
    describe: () => inner.describe(),
    stream: (request, opts) => {
      calls += 1;
      return inner.stream(request, opts);
    },
  };
  return { provider, calls: () => calls };
}

const sameFailingCall = (id: string): Partial<NormalizedEvent>[] => [
  { kind: "tool_call_start", toolCallId: id, toolName: "probe" },
  { kind: "tool_call_end", toolCallId: id, input: JSON.stringify({ value: "same" }) },
  { kind: "model_end" },
];

const probe: InteractiveTool = {
  definition: {
    name: "probe",
    description: "fails identically on every attempt",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    risk: "read",
  },
  invoke: async () => ({ output: "probe failure", isError: true }),
};

function reviewHistory(): NormalizedMessage[] {
  return [
    { role: "user", content: "review PR 7435", provenance: "trusted" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "s1", name: "skill_load", arguments: JSON.stringify({ name: "review-orchestrator" }) }],
    },
    { role: "tool", content: "loaded", toolCallId: "s1" } as NormalizedMessage,
    // The package was opened before this turn began; this session's own `review status` names it, so the gate
    // recognises it (flow 460 review: a resumed review named in history is used).
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "s2", name: "shell_exec", arguments: JSON.stringify({ command: "keryx review status pr-1-all" }) }],
    },
    { role: "tool", content: "status: draft", toolCallId: "s2" } as NormalizedMessage,
  ];
}

let root: string;
let previousCwd: string;

beforeEach(async () => {
  previousCwd = process.cwd();
  root = await mkdtemp(path.join(tmpdir(), "agent-review-gate-"));
  const pkg = path.join(root, ".metaproject", "reviews", "pr-1-all");
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, "manifest.json"), JSON.stringify({ reviewId: "pr-1-all", mode: "review-flow", status: "draft" }));
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(root, { recursive: true, force: true });
});

async function run(
  over: Partial<AgentDeps>,
  options: RunAgentTurnOptions = {},
  ioOver: Partial<AgentIO> = {},
): Promise<{ history: NormalizedMessage[]; system: string[]; finishReason: string | undefined }> {
  const system: string[] = [];
  const io: AgentIO = { write: () => undefined, onSystem: (t) => system.push(t), ...ioOver };
  const history = reviewHistory();
  let id = 0;
  const result = await runAgentTurn(
    io,
    {
      provider: scriptedProvider([sameFailingCall("a1"), sameFailingCall("a2"), sameFailingCall("a3"), sameFailingCall("a4")]),
      providerId: "scripted",
      modelId: "m",
      tools: [probe],
      systemInstruction: "sys",
      idSeq: () => `gate-${id++}`,
      maxRounds: 30,
      maxToolCalls: 60,
      ...over,
    },
    history,
    "continue the review",
    options,
  );
  return { history, system, finishReason: result.finishReason };
}

test("a no-progress stop in a main session with an incomplete managed review is held by the gate", async () => {
  const { history, system } = await run({});
  const nudge = history.find((m) => m.provenance === "harness" && m.content.includes("The managed review pr-1-all is not finished"));
  expect(nudge).toBeDefined();
  expect(nudge?.content).toContain("not a reason to ask the operator to resend the request");
  expect(system.join("")).toContain("[review-gate]");
});

test("AC4: the turn's abort signal reaches the gate scan, and an aborted turn is not nudged", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  // Deterministic stand-in for a scan that is still walking when the operator presses Ctrl+C: it settles only when the
  // signal it was handed aborts. A scan that was never handed the turn's signal reports an open review at once, which
  // is the nudge this test forbids.
  const reviewGateState: typeof findReviewGateState = async (_cwd, _since, _named, scanOptions) => {
    const signal = scanOptions?.signal;
    seenSignal = signal;
    if (signal === undefined) {
      return { reviewId: "pr-1-all", packageDir: path.join(root, ".metaproject", "reviews", "pr-1-all"), blockers: ["missing artifacts: report.md"], signature: "never-aborted" };
    }
    queueMicrotask(() => controller.abort());
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new ReviewGateAbortedError();
  };
  const { history, system } = await run({ reviewGateState }, { signal: controller.signal });
  expect(seenSignal).toBe(controller.signal);
  expect(history.some((m) => m.provenance === "harness" && m.content.includes("The managed review"))).toBe(false);
  expect(system.join("")).not.toContain("[review-gate]");
});

const openReview = (): Awaited<ReturnType<typeof findReviewGateState>> => ({
  reviewId: "pr-1-all",
  packageDir: path.join(root, ".metaproject", "reviews", "pr-1-all"),
  blockers: ["missing artifacts: report.md"],
  signature: "open",
});

test("TP-004: a scan that aborts the turn and then RESOLVES the open review is not nudged", async () => {
  const controller = new AbortController();
  // A scan that throws AbortError is swallowed by the caller's own `.catch`; only the check after the scan can stop a
  // scan that settles normally once the signal has fired.
  const reviewGateState: typeof findReviewGateState = async () => {
    controller.abort();
    return openReview();
  };
  const { history, system } = await run({ reviewGateState }, { signal: controller.signal });
  expect(history.some((m) => m.provenance === "harness" && m.content.includes("The managed review"))).toBe(false);
  expect(system.join("")).not.toContain("[review-gate]");
});

test("LOGIC-003: a text-only stop whose turn was aborted during the gate prints the [stopped] line", async () => {
  const controller = new AbortController();
  const reviewGateState: typeof findReviewGateState = async () => {
    controller.abort();
    return openReview();
  };
  const textOnly = scriptedProvider([[{ kind: "text_delta", text: "all done" }, { kind: "model_end" }]]);
  const { history, system } = await run({ reviewGateState, provider: textOnly }, { signal: controller.signal });
  expect(system.join("")).toContain("[stopped] Model turn interrupted by user.");
  expect(history.some((m) => m.provenance === "harness" && m.content.includes("The managed review"))).toBe(false);
});

test("LOGIC-003 / LOGIC-R2-001: a no-progress stop whose turn was aborted during the gate ends there, with no wrap-up", async () => {
  const controller = new AbortController();
  let callsAtGate = -1;
  const { provider, calls: modelCalls } = countingProvider([sameFailingCall("a1"), sameFailingCall("a2"), sameFailingCall("a3"), sameFailingCall("a4")]);
  const reviewGateState: typeof findReviewGateState = async () => {
    callsAtGate = modelCalls();
    controller.abort();
    return openReview();
  };
  const { history, system, finishReason } = await run({ reviewGateState, provider }, { signal: controller.signal });
  const printed = system.join("");
  expect(callsAtGate).toBeGreaterThan(0);
  // The turn was already stopping on no progress: it is interrupted, not a clean finish.
  expect(finishReason).toBe("interrupted");
  expect(printed).toContain("[stopped] Model turn interrupted by user.");
  // The wrap-up path prints the [budget] line, asks the model again and leaves a harness "Tool loop stopped" message.
  expect(printed).not.toContain("[budget]");
  expect(history.some((m) => typeof m.content === "string" && m.content.includes("Tool loop stopped"))).toBe(false);
  expect(modelCalls()).toBe(callsAtGate);
});

test("TP-004: a turn already aborted when the gate runs never calls the scan and gets no nudge", async () => {
  const controller = new AbortController();
  let scans = 0;
  const reviewGateState: typeof findReviewGateState = async () => {
    scans += 1;
    return openReview();
  };
  const { provider, calls: modelCalls } = countingProvider([[{ kind: "text_delta", text: "all done" }, { kind: "model_end" }]]);
  // `permissionMode` is read between the last abort check of the text-only stop and the gate: the operator presses
  // Ctrl+C in that window, so only the check ahead of the scan can keep the scan from running.
  const permissionMode = () => {
    if (modelCalls() > 0) controller.abort();
    return "ask" as const;
  };
  const { history } = await run({ reviewGateState, provider }, { signal: controller.signal }, { permissionMode });
  expect(controller.signal.aborted).toBe(true);
  expect(scans).toBe(0);
  expect(history.some((m) => m.provenance === "harness" && m.content.includes("The managed review"))).toBe(false);
});

test("an unattended run is not held: there is no one to re-prompt", async () => {
  const { history, finishReason } = await run({ unattended: true });
  expect(history.some((m) => m.content.includes("The managed review"))).toBe(false);
  expect(finishReason).toBe("no-progress");
});
