// `/setup` modal — one tab per preparation scenario, ←/→ switches tabs,
// ↑/↓ scrolls, Esc closes. Same headless OpenTUI harness `help-modal.test.ts`
// uses.
//
// Flow 468 phase B (T9) adds: the detected default tab (AC6), the generated agent
// prompt with Copy / Optional (AC8), the readable scrolling body (AC9) and Run
// through injected seams (AC10). The modal is driven the way an operator drives
// it — real keypresses and mouse clicks on a headless renderer — and read back
// from the rendered frame and its styled spans, never from private state.
//
// Seams this file assumes (named once here; the modal's options are all injected,
// so nothing below touches the clipboard, the job registry or the transcript):
//   projectRoot     string                  project the plan is for (also where the run starts)
//   copyText        (text) => void          clipboard write (the shell wires OSC 52)
//   showToast       (message) => void       "Copied to clipboard" goes here
//   confirm         (card: string[]) => Promise<boolean>   the operator confirm card, as lines
//   startRun        (request) => Promise    keryx runs the confirmed steps itself (setup-run.ts)
//   isRunning       () => boolean           a run from an earlier modal is still going

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as guide from "../commands/setup-guide";
import { SETUP_SCENARIOS } from "../commands/setup-guide";
import {
  findById,
  keypressSource,
  loadOpenTui,
  mountChrome,
  settle,
  textOf,
  type MountedChrome,
} from "./ops-sidebar.test-helpers";
import { openSetupModal, type SetupModalOptions } from "./setup-modal";
import { ownKeryxPrefix, runSetupSteps, selectSetupSteps, stepCommand, type SetupRunRequest } from "./setup-run";
import { roleColor } from "./theme";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): NonNullable<typeof OTUI> {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

const ESC_PARSER_TIMEOUT_MS = 20;
const ROOT = "/work/demo";

/** `openSetupModal` with the test's options spread over the keypress source (no excess-property check on a not-yet-typed seam). */
function openWith(h: MountedChrome, extra: Record<string, unknown> = {}) {
  return openSetupModal(requireOtui().core, h.chrome, {
    onKeypress: keypressSource(h.renderer),
    ...extra,
  } as unknown as SetupModalOptions);
}

type PromptFn = (
  scenario: unknown,
  options: { projectRoot: string; includeOptional: boolean },
) => string;

function expectedPrompt(id: "init" | "refresh" | "repair", includeOptional: boolean): string {
  const build = (guide as unknown as Record<string, unknown>).buildSetupAgentPrompt;
  expect(`buildSetupAgentPrompt: ${typeof build}`).toBe("buildSetupAgentPrompt: function");
  return (build as PromptFn)(guide.setupScenario(id), { projectRoot: ROOT, includeOptional });
}

interface StepView {
  readonly cli: string;
  readonly required: boolean;
}

function planClis(id: "init" | "refresh" | "repair", includeOptional: boolean): string[] {
  return (guide.setupScenario(id)!.steps as unknown as readonly StepView[])
    .filter((step) => step.required === true || includeOptional)
    .map((step) => step.cli);
}

async function waitFor(check: () => boolean, ms = 1500): Promise<void> {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function press(h: MountedChrome, key: string): Promise<void> {
  await h.mockInput.pressKey(key);
  await settle(h);
}

/** A real mouse click on the first on-screen occurrence of `label`. */
async function clickLabel(h: MountedChrome, label: string): Promise<void> {
  await settle(h);
  const lines = h.captureCharFrame().split("\n");
  for (let y = 0; y < lines.length; y += 1) {
    const x = lines[y]!.indexOf(label);
    if (x >= 0) {
      await h.mockMouse.click(x + 1, y);
      await settle(h);
      return;
    }
  }
  throw new Error(`no "${label}" on screen`);
}

async function withProject(files: readonly string[], run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-setup-modal-"));
  try {
    for (const rel of files) {
      const full = path.join(root, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, rel.endsWith(".json") ? "{}\n" : "# fixture\n", "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const COMPLETE = [
  ".metaproject/index.md",
  ".metaproject/metaproject.json",
  ".metaproject/modules/gdctx.md",
] as const;
const PARTIAL = [".metaproject/index.md"] as const;

otuiTest("opens on the first scenario and ←/→ walks init, refresh, repair", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openWith(h);
  await h.flush();

  expect(handle?.activeTab()).toBe("init");
  const first = h.captureCharFrame();
  expect(first).toContain("From scratch");

  await h.mockInput.pressArrow("right");
  await h.flush();
  expect(handle?.activeTab()).toBe("refresh");
  expect(h.captureCharFrame()).toContain("After a pull");

  await h.mockInput.pressArrow("right");
  await h.flush();
  expect(handle?.activeTab()).toBe("repair");
  expect(h.captureCharFrame()).toContain("Partial or stale");

  h.destroy();
});

otuiTest("initialScenario opens that tab", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  const handle = openWith(h, { initialScenario: "repair" });
  await h.flush();
  expect(handle?.activeTab()).toBe("repair");
  h.destroy();
});

otuiTest("flow 468 AC9: ↓ scrolls the body to its last line at a small terminal height; ↑ comes back to the top", async () => {
  const otui = requireOtui();
  // 16 rows: the plan and the prompt cannot both fit, so the last line must be reached by scrolling.
  const h = await mountChrome(otui, { width: 200, height: 16 });
  openWith(h, { projectRoot: ROOT });
  await settle(h);
  const lastLine = expectedPrompt("init", false)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)!;
  const top = h.captureCharFrame();
  expect(top).toContain("From scratch");
  expect(top).not.toContain(lastLine);

  for (let i = 0; i < 300; i += 1) {
    await h.mockInput.pressArrow("down");
  }
  await settle(h);
  const bottom = h.captureCharFrame();
  expect(bottom).toContain(lastLine);
  expect(bottom).not.toContain("From scratch");

  for (let i = 0; i < 300; i += 1) {
    await h.mockInput.pressArrow("up");
  }
  await settle(h);
  expect(h.captureCharFrame()).toBe(top);

  h.destroy();
});

otuiTest("Esc closes the modal and gives focus back to the composer", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  openWith(h);
  await h.flush();
  expect(h.chrome.overlayActive()).toBe(true);

  h.mockInput.pressEscape();
  await new Promise((resolve) => setTimeout(resolve, ESC_PARSER_TIMEOUT_MS * 3));
  await h.flush();
  expect(h.chrome.overlayActive()).toBe(false);
  expect(h.chrome.textarea.focused).toBe(true);

  h.destroy();
});

test("the modal has one tab per scenario", () => {
  expect(SETUP_SCENARIOS.map((scenario) => scenario.tab)).toEqual(["Init", "Refresh", "Repair"]);
});

// ---------------------------------------------------------------------------
// AC6 — the tab that fits the project
// ---------------------------------------------------------------------------

otuiTest("flow 468 AC6: with no argument the modal opens on Init when there is no .metaproject/index.md", async () => {
  const otui = requireOtui();
  await withProject([], async (root) => {
    const h = await mountChrome(otui, { width: 100, height: 30 });
    const handle = openWith(h, { projectRoot: root });
    await settle(h);
    expect(handle?.activeTab()).toBe("init");
    h.destroy();
  });
});

otuiTest("flow 468 AC6: with no argument a complete workspace opens on Refresh", async () => {
  const otui = requireOtui();
  await withProject(COMPLETE, async (root) => {
    const h = await mountChrome(otui, { width: 100, height: 30 });
    const handle = openWith(h, { projectRoot: root });
    await settle(h);
    expect(handle?.activeTab()).toBe("refresh");
    expect(h.captureCharFrame()).toContain("After a pull");
    h.destroy();
  });
});

otuiTest("flow 468 AC6: with no argument a partial workspace opens on Repair", async () => {
  const otui = requireOtui();
  await withProject(PARTIAL, async (root) => {
    const h = await mountChrome(otui, { width: 100, height: 30 });
    const handle = openWith(h, { projectRoot: root });
    await settle(h);
    expect(handle?.activeTab()).toBe("repair");
    expect(h.captureCharFrame()).toContain("Partial or stale");
    h.destroy();
  });
});

otuiTest("flow 468 AC6: an explicit scenario still wins over the detected one", async () => {
  const otui = requireOtui();
  await withProject(COMPLETE, async (root) => {
    const h = await mountChrome(otui, { width: 100, height: 30 });
    const handle = openWith(h, { projectRoot: root, initialScenario: "init" });
    await settle(h);
    expect(handle?.activeTab()).toBe("init");
    h.destroy();
  });
  await withProject([], async (root) => {
    const h = await mountChrome(otui, { width: 100, height: 30 });
    const handle = openWith(h, { projectRoot: root, initialScenario: "repair" });
    await settle(h);
    expect(handle?.activeTab()).toBe("repair");
    h.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC8 — the agent prompt under the plan, Copy, Optional
// ---------------------------------------------------------------------------

otuiTest("flow 468 AC8: the generated prompt is shown under the plan", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  openWith(h, { projectRoot: ROOT, initialScenario: "init" });
  await settle(h);
  const frame = h.captureCharFrame();
  const flat = frame.replace(/\s+/g, " ");
  expect(flat).toContain(ROOT);
  expect(flat.toLowerCase()).toContain("read .metaproject/index.md first");
  expect(frame).toContain("REQUIRED");
  // Under the plan: the prompt's REQUIRED list starts below the plan's last required command.
  const lastPlanCommand = frame.indexOf("keryx security policy validate");
  expect(lastPlanCommand).toBeGreaterThan(-1);
  expect(frame.indexOf("REQUIRED")).toBeGreaterThan(lastPlanCommand);
  h.destroy();
});

otuiTest("flow 468 AC8: c copies the prompt and shows Copied to clipboard", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const copied: string[] = [];
  const toasts: string[] = [];
  openWith(h, {
    projectRoot: ROOT,
    initialScenario: "refresh",
    copyText: (text: string) => copied.push(text),
    showToast: (message: string) => toasts.push(message),
  });
  await settle(h);
  await press(h, "c");
  expect(copied).toHaveLength(1);
  expect(copied[0]).toBe(expectedPrompt("refresh", false));
  expect(toasts).toContain("Copied to clipboard");
  h.destroy();
});

otuiTest("flow 468 AC8: the Copy button copies the same prompt", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const copied: string[] = [];
  const toasts: string[] = [];
  openWith(h, {
    projectRoot: ROOT,
    initialScenario: "repair",
    copyText: (text: string) => copied.push(text),
    showToast: (message: string) => toasts.push(message),
  });
  await settle(h);
  expect(h.captureCharFrame()).toContain("[Copy prompt]");
  await clickLabel(h, "[Copy prompt]");
  expect(copied).toHaveLength(1);
  expect(copied[0]).toBe(expectedPrompt("repair", false));
  expect(toasts).toContain("Copied to clipboard");
  h.destroy();
});

otuiTest("flow 468 AC8: o toggles the optional steps in both the list and the prompt", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const copied: string[] = [];
  openWith(h, {
    projectRoot: ROOT,
    initialScenario: "refresh",
    copyText: (text: string) => copied.push(text),
    showToast: () => {},
  });
  await settle(h);

  // Off: only the required steps are listed, the button says so.
  let frame = h.captureCharFrame();
  expect(frame).toMatch(/Optional: off/);
  expect(frame).toContain("keryx update --skip-runtime --yes");
  expect(frame).not.toContain("keryx update --preview");
  await press(h, "c");
  expect(copied).toHaveLength(1);
  expect(copied.at(-1)).toBe(expectedPrompt("refresh", false));
  expect(copied.at(-1)).not.toContain("OPTIONAL");

  // On: the optional steps join the list and the prompt.
  await press(h, "o");
  frame = h.captureCharFrame();
  expect(frame).toMatch(/Optional: on/);
  expect(frame).toContain("keryx update --preview");
  expect(frame).toContain("[optional]");
  await press(h, "c");
  expect(copied).toHaveLength(2);
  expect(copied.at(-1)).toBe(expectedPrompt("refresh", true));
  expect(copied.at(-1)).toContain("OPTIONAL");

  // And off again.
  await press(h, "o");
  frame = h.captureCharFrame();
  expect(frame).toMatch(/Optional: off/);
  expect(frame).not.toContain("keryx update --preview");
  h.destroy();
});

otuiTest("flow 468 AC8: the Optional button toggles like o", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  openWith(h, { projectRoot: ROOT, initialScenario: "refresh", copyText: () => {}, showToast: () => {} });
  await settle(h);
  expect(h.captureCharFrame()).not.toContain("keryx update --preview");
  await clickLabel(h, "[Optional: off]");
  const frame = h.captureCharFrame();
  expect(frame).toMatch(/Optional: on/);
  expect(frame).toContain("keryx update --preview");
  h.destroy();
});

// ---------------------------------------------------------------------------
// AC9 — readable and complete
// ---------------------------------------------------------------------------

type Span = { text: string; fg?: unknown; attributes: number };

/** `#rrggbb` of a captured span colour (a `{ buffer }` of 0-255 channels) or of a theme hex. */
function hexOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.toLowerCase();
  const buffer = (value as { buffer?: Record<string, number> } | undefined)?.buffer;
  if (buffer === undefined) return undefined;
  const channel = (i: number): string => Math.round(buffer[String(i)] ?? 0).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function spanContaining(h: MountedChrome, needle: string): Span | undefined {
  for (const line of h.captureSpans().lines) {
    const hit = (line.spans as Span[]).find((span) => span.text.includes(needle));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

otuiTest("flow 468 AC9: titles are bold, commands use the accent colour and are not dimmed", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  openWith(h, { projectRoot: ROOT, initialScenario: "init" });
  await settle(h);
  const { BOLD, DIM } = otui.core.TextAttributes;

  const title = spanContaining(h, "From scratch");
  expect(title).toBeDefined();
  expect((title?.attributes ?? 0) & BOLD).toBe(BOLD);

  const command = spanContaining(h, "keryx gdgraph build");
  expect(command).toBeDefined();
  expect(hexOf(command?.fg)).toBe(hexOf(roleColor("accent")));
  expect((command?.attributes ?? 0) & DIM).toBe(0);

  // Nothing wraps the whole body in one dimmed run: no dim span holds a command.
  for (const line of h.captureSpans().lines) {
    for (const span of line.spans as Span[]) {
      if ((span.attributes & DIM) === DIM) expect(span.text).not.toContain("keryx init --yes");
    }
  }
  h.destroy();
});

otuiTest("flow 468 AC9: [required] and [optional] are visibly distinct", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  openWith(h, { projectRoot: ROOT, initialScenario: "refresh" });
  await settle(h);
  await press(h, "o");

  const required = spanContaining(h, "[required]");
  const optional = spanContaining(h, "[optional]");
  expect(required).toBeDefined();
  expect(optional).toBeDefined();
  const requiredColour = hexOf(required?.fg);
  const optionalColour = hexOf(optional?.fg);
  expect(requiredColour).not.toBe(optionalColour);
  expect(requiredColour).toBe(hexOf(roleColor("ok")));
  expect(optionalColour).toBe(hexOf(roleColor("muted")));
  h.destroy();
});

otuiTest("flow 468 AC9: a tall terminal shows the plan and the whole prompt without a 24-row window", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  openWith(h, { projectRoot: ROOT, initialScenario: "init" });
  await settle(h);
  const frame = h.captureCharFrame();
  const lastLine = expectedPrompt("init", false)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)!;
  expect(frame).toContain("From scratch");
  expect(frame).toContain(lastLine);
  // The old window stopped at 24 body rows; the content here is taller than that.
  const bodyRows = frame.split("\n").filter((row) => row.trim().length > 0).length;
  expect(bodyRows).toBeGreaterThan(24);
  h.destroy();
});

otuiTest("flow 468 AC9: the keys hint appears once", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  openWith(h, { projectRoot: ROOT, initialScenario: "init" });
  await settle(h);
  const frame = h.captureCharFrame();
  expect(frame.split("←/→ tabs").length - 1).toBe(1);
  expect(frame).toContain("esc close");
  h.destroy();
});

/** Every line of text in `node`'s subtree, with the width of the box it was laid out in. */
function textLines(root: unknown): Array<{ line: string; width: number }> {
  const out: Array<{ line: string; width: number }> = [];
  const walk = (node: { getChildren(): unknown[]; width?: number; content?: unknown }): void => {
    if (node.content !== undefined) {
      for (const line of textOf(node as never).split("\n")) out.push({ line, width: node.width ?? 0 });
    }
    for (const child of node.getChildren()) walk(child as never);
  };
  walk(root as never);
  return out;
}

otuiTest("flow 468 AC9: the body is wrapped to the modal's own width, at a medium and a wide terminal", async () => {
  const otui = requireOtui();
  for (const width of [120, 200]) {
    const h = await mountChrome(otui, { width, height: 60 });
    openWith(h, { projectRoot: ROOT, initialScenario: "init" });
    await settle(h);
    const body = findById(h.renderer.root, "modal-body-scroll");
    expect(body).toBeDefined();
    const lines = textLines(body);
    expect(lines.length).toBeGreaterThan(10);
    // No pre-wrapped line is wider than the box it was laid out in (that is what the old
    // `renderer.width - 8` budget did at both of these widths).
    const tooWide = lines.filter((entry) => entry.width > 0 && entry.line.length > entry.width);
    expect(`${width} cols: ${tooWide.map((entry) => `${entry.line.length}>${entry.width}`).join(", ")}`).toBe(`${width} cols: `);
    h.destroy();
  }
});

// ---------------------------------------------------------------------------
// AC10 — Run: keryx runs the confirmed steps itself as background jobs (no model)
// ---------------------------------------------------------------------------

interface RunHarness {
  readonly confirms: string[][];
  readonly runs: SetupRunRequest[];
  readonly toasts: string[];
  readonly options: Record<string, unknown>;
}

function runHarness(answer: boolean, extra: Record<string, unknown> = {}): RunHarness {
  const confirms: string[][] = [];
  const runs: SetupRunRequest[] = [];
  const toasts: string[] = [];
  return {
    confirms,
    runs,
    toasts,
    options: {
      projectRoot: ROOT,
      initialScenario: "refresh",
      copyText: () => {},
      showToast: (message: string) => toasts.push(message),
      confirm: async (card: readonly string[]) => {
        confirms.push([...card]);
        return answer;
      },
      // A real run lasts: it never settles inside the test, the modal must not wait for it.
      startRun: (request: SetupRunRequest) => {
        runs.push(request);
        return new Promise<unknown>(() => {});
      },
      ...extra,
    },
  };
}

otuiTest("flow 468 AC10: r asks to confirm with the scenario and the exact commands that will run", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(true);
  openWith(h, run.options);
  await settle(h);
  await press(h, "r");
  await waitFor(() => run.confirms.length > 0);

  expect(run.confirms).toHaveLength(1);
  const card = run.confirms[0]!.join("\n");
  expect(card).toContain("Refresh");
  for (const cli of planClis("refresh", false)) expect(card).toContain(cli);
  expect(card).toMatch(/no model/i);
  // Optional steps are not run unless the operator turned them on.
  expect(card).not.toContain("keryx update --preview");
  h.destroy();
});

otuiTest("flow 468 AC10: yes starts the run with the required steps in order, in the project root, and the modal stays usable", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(true);
  openWith(h, run.options);
  await settle(h);
  await press(h, "r");
  await waitFor(() => run.runs.length > 0);

  expect(run.runs).toHaveLength(1);
  expect(run.runs[0]!.steps.map((step) => step.cli)).toEqual(planClis("refresh", false));
  expect(run.runs[0]!.projectRoot).toBe(ROOT);
  expect(run.runs[0]!.skipped).toEqual([]);

  // The run never settles; the modal still answers keys.
  await press(h, "o");
  expect(h.captureCharFrame()).toMatch(/Optional: on/);
  h.destroy();
});

otuiTest("flow 468 AC10: the Run button works like r", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(true);
  openWith(h, run.options);
  await settle(h);
  expect(h.captureCharFrame()).toContain("[Run]");
  await clickLabel(h, "[Run]");
  await waitFor(() => run.runs.length > 0);
  expect(run.confirms).toHaveLength(1);
  expect(run.runs[0]!.projectRoot).toBe(ROOT);
  h.destroy();
});

otuiTest("flow 468 AC10: with Optional on the optional steps run too, and a step that needs a value is listed as skipped and never run", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(true, { initialScenario: "init" });
  openWith(h, run.options);
  await settle(h);
  await press(h, "o");
  await press(h, "r");
  await waitFor(() => run.runs.length > 0);

  const runnable = planClis("init", true).filter((cli) => !/<[^<>\s]+>/.test(cli));
  expect(run.runs[0]!.steps.map((step) => step.cli)).toEqual(runnable);
  expect(run.runs[0]!.skipped.map((step) => step.cli)).toEqual(["keryx integrate <editor>"]);
  const card = run.confirms[0]!.join("\n");
  for (const cli of runnable) expect(card).toContain(cli);
  const skippedAt = card.indexOf("Skipped");
  expect(skippedAt).toBeGreaterThan(-1);
  expect(card.indexOf("keryx integrate <editor>")).toBeGreaterThan(skippedAt);
  h.destroy();
});

otuiTest("flow 468 AC10: no starts nothing", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(false);
  openWith(h, run.options);
  await settle(h);
  await press(h, "r");
  await waitFor(() => run.confirms.length > 0);
  await settle(h);

  expect(run.confirms).toHaveLength(1);
  expect(run.runs).toEqual([]);
  h.destroy();
});

otuiTest("flow 468 AC10: a second Run while one is active is refused with a toast", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(true);
  openWith(h, run.options);
  await settle(h);
  await press(h, "r");
  await waitFor(() => run.runs.length > 0);
  await press(h, "r");

  expect(run.confirms).toHaveLength(1);
  expect(run.runs).toHaveLength(1);
  expect(run.toasts).toContain("A setup run is already in progress");
  h.destroy();
});

otuiTest("flow 468 AC10: a run started by an earlier modal also blocks Run", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 200, height: 70 });
  const run = runHarness(true, { isRunning: () => true });
  openWith(h, run.options);
  await settle(h);
  await press(h, "r");

  expect(run.confirms).toEqual([]);
  expect(run.runs).toEqual([]);
  expect(run.toasts).toContain("A setup run is already in progress");
  h.destroy();
});

// --- the step runner: order, stop rules, divergence, cancel -------------------------------

interface Scripted {
  readonly status: "completed" | "failed" | "killed";
  readonly exitCode?: number;
  readonly output?: string;
}

/** A job registry double: each command is looked up in `script`, default is a clean exit. */
function fakeJobs(script: Record<string, Scripted> = {}) {
  const started: Array<{ command: string; description: string | undefined }> = [];
  const observed: string[] = [];
  const results = new Map<string, Scripted>();
  const jobs = {
    started,
    observed,
    start: async (command: string, opts?: { description?: string }) => {
      const id = `task-${started.length + 1}`;
      started.push({ command, description: opts?.description });
      results.set(id, script[command.replace(/^KERYX/, "keryx")] ?? { status: "completed", exitCode: 0 });
      return { ok: true as const, jobId: id, pid: 1, output: "" };
    },
    waitForExit: async () => "exited" as const,
    get: (id: string) => {
      const result = results.get(id);
      return result === undefined ? undefined : ({ status: result.status, exitCode: result.exitCode } as never);
    },
    readOutput: (id: string) => ({ ok: true as const, output: results.get(id)?.output ?? "" }),
    markObserved: (id: string) => {
      observed.push(id);
    },
  };
  return jobs;
}

function planRequest(id: "init" | "refresh" | "repair", includeOptional: boolean): SetupRunRequest {
  const scenario = guide.setupScenario(id)!;
  const { run, skipped } = selectSetupSteps(scenario.steps, includeOptional);
  return { scenarioTab: scenario.tab, scenarioTitle: scenario.title, projectRoot: ROOT, steps: run, skipped };
}

async function runWith(request: SetupRunRequest, jobs: ReturnType<typeof fakeJobs>) {
  const lines: string[] = [];
  const outcome = await runSetupSteps(request, jobs as never, { prefix: "KERYX", say: (line) => lines.push(line) });
  return { outcome, lines };
}

test("flow 468 AC10: the runner starts one job per step, in order, with the running keryx and a description", async () => {
  const jobs = fakeJobs();
  const request = planRequest("refresh", false);
  const { outcome, lines } = await runWith(request, jobs);

  expect(outcome.status).toBe("done");
  expect(jobs.started.map((job) => job.command)).toEqual(
    request.steps.map((step) => step.cli.replace(/^keryx/, "KERYX")),
  );
  expect(jobs.started[0]!.description).toBe(`setup 1/${request.steps.length}: ${request.steps[0]!.cli}`);
  expect(lines[0]).toContain("running");
  for (const step of request.steps) expect(lines).toContain(`✓ ${step.cli}`);
  expect(lines.at(-1)).toContain("finished");
  // The main agent is not also told about each job.
  expect(jobs.observed.length).toBeGreaterThanOrEqual(request.steps.length);
});

test("flow 468 AC10: a failed required step stops the run and the summary names it", async () => {
  const request = planRequest("refresh", false);
  const failing = request.steps[1]!.cli; // keryx sync --apply
  const jobs = fakeJobs({ [failing]: { status: "failed", exitCode: 2, output: "boom\n" } });
  const { outcome, lines } = await runWith(request, jobs);

  expect(outcome.status).toBe("stopped");
  expect(jobs.started).toHaveLength(2);
  expect(lines).toContain(`✓ ${request.steps[0]!.cli}`);
  expect(lines.some((line) => line.startsWith(`✗ ${failing}`) && line.includes("exit 2") && line.includes("boom"))).toBe(true);
  expect(lines.at(-1)).toContain(`stopped at required step ${failing}`);
});

test("flow 468 AC10: a failed optional step is reported and the run continues", async () => {
  const request = planRequest("refresh", true);
  const optional = request.steps.find((step) => !step.required)!;
  const jobs = fakeJobs({ [optional.cli]: { status: "failed", exitCode: 1, output: "nope" } });
  const { outcome, lines } = await runWith(request, jobs);

  expect(outcome.status).toBe("done");
  expect(jobs.started).toHaveLength(request.steps.length);
  expect(lines.some((line) => line.startsWith(`✗ ${optional.cli}`))).toBe(true);
  expect(lines.at(-1)).toContain(`optional steps that failed: ${optional.cli}`);
});

test("flow 468 AC10: a keryx update version divergence stops the run and names both flags without picking one", async () => {
  const request = planRequest("refresh", false);
  const update = request.steps.find((step) => step.cli.startsWith("keryx update"))!;
  const output = [
    "keryx update published nothing: 1 lifecycle target(s) diverged from what this writer recorded.",
    "  --accept-version   publish this version's content over the divergent bytes (not undoable)",
    "  --keep-existing    leave the divergent bytes in place and record that this run did not publish them",
  ].join("\n");
  const jobs = fakeJobs({ [update.cli]: { status: "failed", exitCode: 1, output } });
  const { outcome, lines } = await runWith(request, jobs);

  expect(outcome.status).toBe("stopped");
  expect(jobs.started).toHaveLength(1);
  const last = lines.at(-1)!;
  expect(last).toContain("--accept-version");
  expect(last).toContain("--keep-existing");
  for (const job of jobs.started) {
    expect(job.command).not.toContain("--accept-version");
    expect(job.command).not.toContain("--keep-existing");
  }
});

test("flow 468 AC10: a step whose command holds a placeholder is skipped, and Optional off leaves optional steps out", () => {
  const withOptional = selectSetupSteps(guide.setupScenario("init")!.steps, true);
  expect(withOptional.skipped.map((step) => step.cli)).toEqual(["keryx integrate <editor>"]);
  expect(withOptional.run.some((step) => step.cli.includes("<"))).toBe(false);
  const repairOptional = selectSetupSteps(guide.setupScenario("repair")!.steps, true);
  expect(repairOptional.skipped.map((step) => step.cli)).toEqual(["keryx modules enable <name>"]);

  const without = selectSetupSteps(guide.setupScenario("init")!.steps, false);
  expect(without.skipped).toEqual([]);
  expect(without.run.every((step) => step.required)).toBe(true);
  expect(without.run.map((step) => step.cli)).toEqual(planClis("init", false));
});

test("flow 468 AC10: killing a step's job stops the run and says so", async () => {
  const request = planRequest("refresh", false);
  const killed = request.steps[0]!.cli;
  const jobs = fakeJobs({ [killed]: { status: "killed" } });
  const { outcome, lines } = await runWith(request, jobs);

  expect(outcome.status).toBe("cancelled");
  expect(jobs.started).toHaveLength(1);
  expect(lines.some((line) => line.includes("cancelled") && line.includes(killed))).toBe(true);
});

test("flow 468 AC10: the prefix is the keryx this process runs on, quoted, never keryx on PATH", () => {
  const prefix = ownKeryxPrefix();
  expect(prefix).toContain(process.execPath.includes(" ") ? `'${process.execPath}'` : process.execPath);
  expect(prefix.startsWith("keryx")).toBe(false);
  expect(stepCommand("keryx update --skip-runtime --yes", "P")).toBe("P update --skip-runtime --yes");
});
