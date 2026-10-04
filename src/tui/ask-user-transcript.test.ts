// Flow 401 (AC2): the own answer is shown in the transcript right after the question breadcrumb.
import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { showComposerChoiceDetailed } from "./composer-choice";
import { mountAskAnswerLine } from "./ask-user-transcript";
import { createShellChrome } from "./shell-chrome";
import { dimChunk, roleChunk } from "./theme-text";

async function loadOpenTui(): Promise<{ core: typeof import("@opentui/core"); testing: typeof import("@opentui/core/testing") } | undefined> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
];

async function mount(otui: NonNullable<typeof OTUI>) {
  const setup = await otui.testing.createTestRenderer({ width: 90, height: 24 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · chrome",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
  });
  await setup.flush();
  return { ...setup, chrome };
}

function breadcrumb(otui: NonNullable<typeof OTUI>, setup: Awaited<ReturnType<typeof mount>>): void {
  setup.chrome.transcript.add(
    new otui.core.TextRenderable(setup.renderer, {
      id: "ask-q",
      content: otui.core.t`${roleChunk(otui.core, "attention", "? ")} ${dimChunk(otui.core, "Which way?")}`,
    }),
  );
}

otuiTest("AC2: the typed own answer shows in the transcript after the question breadcrumb", async () => {
  const otui = OTUI;
  if (otui === undefined) throw new Error("unreachable");
  const h = await mount(otui);
  breadcrumb(otui, h);
  const pending = showComposerChoiceDetailed(otui.core, h.renderer, h.chrome.dock, {
    title: "Which way?",
    cancelId: "__cancel__",
    options: OPTIONS,
    ownAnswer: {},
  });
  await h.flush();
  h.mockInput.pressArrow("down");
  h.mockInput.pressArrow("down");
  h.mockInput.pressEnter();
  await h.flush();
  await h.mockInput.typeText("split it in two");
  await h.flush();
  h.mockInput.pressEnter();
  const result = await pending;
  expect(result).toEqual({ kind: "own", text: "split it in two" });
  mountAskAnswerLine(otui.core, h.renderer, h.chrome.transcript, "ask-a", OPTIONS, result);
  await h.flush();
  const frame = h.captureCharFrame();
  const question = frame.indexOf("Which way?");
  const answer = frame.indexOf("→ ✍ split it in two");
  expect(question).toBeGreaterThanOrEqual(0);
  expect(answer).toBeGreaterThan(question);
  h.chrome.destroy();
  h.renderer.destroy();
});

otuiTest("a picked option with a reason, a plain pick and a cancel each get their own line", async () => {
  const otui = OTUI;
  if (otui === undefined) throw new Error("unreachable");
  const h = await mount(otui);
  mountAskAnswerLine(otui.core, h.renderer, h.chrome.transcript, "l1", OPTIONS, { kind: "reason", id: "b", reason: "deadline is Friday" });
  mountAskAnswerLine(otui.core, h.renderer, h.chrome.transcript, "l2", OPTIONS, { kind: "id", id: "a" });
  mountAskAnswerLine(otui.core, h.renderer, h.chrome.transcript, "l3", OPTIONS, { kind: "id", id: "__cancel__" });
  await h.flush();
  const frame = h.captureCharFrame();
  expect(frame).toContain("→ Option B — deadline is Friday");
  expect(frame).toContain("→ Option A");
  expect(frame).toContain("→ cancelled");
  h.chrome.destroy();
  h.renderer.destroy();
});
