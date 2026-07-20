// Flow 060 — OpenTUI shell Phase 1 headless tests.
//
// Proves the driver → TuiShell → OpenTUI-buffer render path WITHOUT a real TTY:
// a scripted provider is driven through `runAgentTurn` with the `TuiShell`
// `AgentIO` (createTuiAgentIo), then the captured frame is asserted to contain the
// streamed assistant text and a tool line. `@opentui/core` is optional + loaded
// via dynamic import; the tests skip when it is absent.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createTuiAgentIo, fmtTokens, isShellApproved } from "./tui-shell";
import { AGENT_SLASH_COMMANDS, filterCommands } from "../commands/agent-commands";
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

test("assistant markdown renders bold/bullets without raw markers (headless, chrome parity)", async () => {
  const otui = await loadOpenTui();
  if (otui === undefined) {
    return;
  }
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 12 });
  const transcript = new otui.core.BoxRenderable(renderer, { id: "transcript", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(transcript);
  const io = createTuiAgentIo(otui.core, renderer, transcript);
  const provider = scriptedProvider([
    [{ kind: "text_delta", text: "**Bold** text\n- item one" }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: builtinReadOnlyTools(tmpdir()),
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  await runAgentTurn(io, deps, [], "md");
  await flush();
  const frame = captureCharFrame();
  expect(frame).toContain("Bold"); // bold word rendered
  expect(frame).not.toContain("**"); // raw bold markers stripped
  expect(frame).toContain("•"); // bullet glyph rendered
  renderer.destroy();
});

test("live /-dropdown filters commands as you type (headless reactivity)", async () => {
  const otui = await loadOpenTui();
  if (otui === undefined) {
    return;
  }
  const { renderer, mockInput, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 80, height: 12 });
  const menu = new otui.core.SelectRenderable(renderer, {
    id: "menu",
    width: 80,
    height: 6,
    visible: false,
    options: [...AGENT_SLASH_COMMANDS],
  });
  renderer.root.add(menu);
  const input = new otui.core.InputRenderable(renderer, { id: "prompt" });
  renderer.root.add(input);
  input.focus();
  input.on(otui.core.InputRenderableEvents.INPUT, () => {
    const matches = filterCommands(input.value);
    if (matches.length > 0) {
      menu.options = matches;
      menu.visible = true;
    } else {
      menu.visible = false;
    }
  });

  await mockInput.pressKeys(["/", "h"]);
  await flush();
  expect(input.value).toBe("/h");
  expect(menu.visible).toBe(true);
  const frame = captureCharFrame();
  expect(frame).toContain("/help");
  expect(frame).not.toContain("/clear"); // filtered out by the `h` prefix
  renderer.destroy();
});

test("isShellApproved: only explicit y/yes approves (default-deny)", () => {
  expect(isShellApproved("y")).toBe(true);
  expect(isShellApproved("Y")).toBe(true);
  expect(isShellApproved("yes")).toBe(true);
  expect(isShellApproved(" yes ")).toBe(true);
  expect(isShellApproved("n")).toBe(false);
  expect(isShellApproved("no")).toBe(false);
  expect(isShellApproved("")).toBe(false);
  expect(isShellApproved("yep")).toBe(false);
});

test("fmtTokens: compact K formatting", () => {
  expect(fmtTokens(0)).toBe("0");
  expect(fmtTokens(999)).toBe("999");
  expect(fmtTokens(1000)).toBe("1.0K");
  expect(fmtTokens(1234)).toBe("1.2K");
  expect(fmtTokens(22000)).toBe("22.0K");
});

test("ScrollBox transcript renders appended content (headless)", async () => {
  const otui = await loadOpenTui();
  if (otui === undefined) {
    return;
  }
  const { renderer, flush, captureCharFrame } = await otui.testing.createTestRenderer({ width: 60, height: 10 });
  const scroll = new otui.core.ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column" },
  });
  renderer.root.add(scroll);
  scroll.content.add(new otui.core.TextRenderable(renderer, { id: "line", content: "hello scrollbox" }));
  await flush();
  expect(captureCharFrame()).toContain("hello scrollbox");
  renderer.destroy();
});

test("content survives a terminal resize (headless)", async () => {
  const otui = await loadOpenTui();
  if (otui === undefined) {
    return;
  }
  const { renderer, flush, captureCharFrame, resize } = await otui.testing.createTestRenderer({ width: 60, height: 10 });
  const box = new otui.core.BoxRenderable(renderer, { id: "b", flexGrow: 1, flexDirection: "column" });
  renderer.root.add(box);
  box.add(new otui.core.TextRenderable(renderer, { id: "t", content: "resize me" }));
  await flush();
  expect(captureCharFrame()).toContain("resize me");
  resize(40, 8);
  await flush();
  expect(captureCharFrame()).toContain("resize me"); // survives the resize
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
