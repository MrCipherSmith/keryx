// Flow 060 — OpenTUI shell Phase 1 headless tests.
//
// Proves the driver → TuiShell → OpenTUI-buffer render path WITHOUT a real TTY:
// a scripted provider is driven through `runAgentTurn` with the `TuiShell`
// `AgentIO` (createTuiAgentIo), then the captured frame is asserted to contain the
// streamed assistant text and a tool line. `@opentui/core` is optional + loaded
// via dynamic import; the tests skip when it is absent.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createTuiAgentIo } from "./tui-shell";
import { runAgentTurn } from "../commands/agent";
import type { AgentDeps } from "../commands/agent";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, ProviderDescription } from "../harness/provider/types";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    const [core, testing] = await Promise.all([import("@opentui/core"), import("@opentui/core/testing")]);
    return { core, testing };
  } catch {
    return undefined;
  }
}

/** Minimal scripted ProviderPort: replays a fixed event list per stream() call. */
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): AgentDeps["provider"] {
  let call = 0;
  const description: ProviderDescription = {
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
  return {
    describe: () => description,
    stream: (_request, opts) => {
      const events = scripts[call] ?? [];
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

let idCounter = 0;
const fixedIdSeq = (): (() => string) => {
  idCounter = 0;
  return () => `id-${idCounter++}`;
};

test("driver → TuiShell renders streamed assistant text + a tool line (headless)", async () => {
  const otui = await loadOpenTui();
  if (otui === undefined) {
    return; // optional dependency absent — skip
  }
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 20 });
  const transcript = new otui.core.BoxRenderable(renderer, { id: "transcript", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(transcript);
  const io = createTuiAgentIo(otui.core, renderer, transcript);

  const provider = scriptedProvider([
    // Round 1: a get_cwd tool call.
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    // Round 2: the final answer text.
    [{ kind: "text_delta", text: "Your directory is set." }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };

  await runAgentTurn(io, deps, [], "where am I?");
  await flush();
  const frame = captureCharFrame();
  expect(frame).toContain("Your directory is set."); // streamed assistant text rendered
  expect(frame).toContain("get_cwd"); // tool call line rendered
  renderer.destroy();
});

test("OpenTUI Input accepts typed keys (composer primitive)", async () => {
  const otui = await loadOpenTui();
  if (otui === undefined) {
    return;
  }
  const { renderer, mockInput } = await otui.testing.createTestRenderer({ width: 70, height: 4 });
  const input = new otui.core.InputRenderable(renderer, { id: "prompt" });
  renderer.root.add(input);
  input.focus();
  await mockInput.pressKeys(["h", "i"]);
  expect(input.value).toBe("hi");
  renderer.destroy();
});
