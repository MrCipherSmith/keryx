// `/setup` modal. One tab per Metaproject preparation scenario; it opens on the
// tab that fits the project (`detectSetupScenario`). A tab shows the plan (each
// step marked required or optional, with its reason) and, under it, the prompt
// that asks a coding agent to run that plan. Buttons on the right copy the
// prompt, toggle the optional steps and run the prompt.
//
// The modal runs nothing itself. `Run` asks `confirm` first, then hands the confirmed steps to
// `startRun`; keryx runs them itself (see `setup-run.ts`), no model involved. Every effect is an
// injected seam, so the modal is exercised headless.

import {
  buildSetupAgentPrompt,
  detectSetupScenario,
  SETUP_SCENARIOS,
  setupStepMark,
  wrapSetupText,
  type SetupScenario,
  type SetupScenarioId,
  type SetupStep,
} from "../commands/setup-guide";
import { smallActionButton } from "./action-button";
import { openModal, type ModalHandle } from "./modal-host";
import { selectSetupSteps, type SetupRunRequest } from "./setup-run";
import { roleColor } from "./theme";
import { boldChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Chunk = ReturnType<OpenTui["bold"]>;
type Line = readonly Chunk[];
type TextNode = { content: unknown };

export const SETUP_MODAL_TITLE = "/setup";

/** Columns the button column takes: the widest label `[Optional: off]` (15), its padding (2) and margin (1), and one spare. */
const ACTION_COLUMN_COLS = 19;
/** Below this body width the button column stacks above the text. */
const STACK_BELOW_COLS = 64;
const COPIED_TOAST = "Copied to clipboard";

export interface SetupModalOptions {
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  inputBlocked?: () => boolean;
  /** An explicit tab wins over the one detected from `projectRoot`. */
  initialScenario?: SetupScenarioId;
  /** The project the plan is for: tab detection, the prompt, and the run's working directory. Default: the current directory. */
  projectRoot?: string;
  /** Write text to the clipboard. */
  copyText?: (text: string) => void;
  showToast?: (message: string) => void;
  /** The operator confirm card, one string per line. Resolves true on yes. */
  confirm?: (card: readonly string[]) => Promise<boolean>;
  /** Run the confirmed steps. The modal does not wait on its keys; a settled promise ends the run. */
  startRun?: (request: SetupRunRequest) => Promise<unknown> | void;
  /** True while a run started elsewhere (an earlier modal) is still going. */
  isRunning?: () => boolean;
}

export type SetupModalHandle = ModalHandle;

type ScrollView = {
  scrollTop: number;
  scrollHeight: number;
  viewport: { height: number };
};

function findBodyScroll(body: unknown): ScrollView | undefined {
  let node = (body as { parent?: unknown } | undefined)?.parent as { id?: string; parent?: unknown } | undefined;
  while (node !== undefined && node !== null) {
    if (node.id === "modal-body-scroll") return node as unknown as ScrollView;
    node = node.parent as typeof node;
  }
  return undefined;
}

function visibleSteps(scenario: SetupScenario, includeOptional: boolean): readonly SetupStep[] {
  return scenario.steps.filter((step) => step.required || includeOptional);
}

export function openSetupModal(
  otui: unknown,
  chrome: unknown,
  options: SetupModalOptions,
): SetupModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const projectRoot = options.projectRoot ?? process.cwd();
  const detected = options.projectRoot !== undefined ? detectSetupScenario(options.projectRoot) : undefined;
  const initialTab = options.initialScenario ?? detected;
  const tabs = SETUP_SCENARIOS.map((scenario) => ({ id: scenario.id, label: scenario.tab }));
  let closed = false;
  let includeOptional = false;
  let confirming = false;
  let running = false;
  let current: { tabId: string; plan: TextNode; prompt: TextNode; optional: TextNode; width: number } | undefined;
  let scrollView: ScrollView | undefined;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const scenarioOf = (id: string): SetupScenario => SETUP_SCENARIOS.find((item) => item.id === id) ?? SETUP_SCENARIOS[0]!;
  const activeId = (): string => host.handle?.activeTab() ?? tabs[0]!.id;
  const promptOf = (scenario: SetupScenario): string =>
    buildSetupAgentPrompt(scenario, { projectRoot, includeOptional });

  const text = (value: string): Chunk => roleChunk(core, "text", value);
  const joinLines = (lines: readonly Line[]): Chunk[] => {
    const out: Chunk[] = [];
    lines.forEach((line, index) => {
      if (index > 0) out.push(text("\n"));
      out.push(...line);
    });
    return out;
  };

  const planLines = (scenario: SetupScenario, width: number): Line[] => {
    const lines: Line[] = [[boldChunk(core, scenario.title)]];
    for (const row of wrapSetupText(scenario.when, width)) lines.push([text(row)]);
    lines.push([text("")]);
    let previousNote = "";
    visibleSteps(scenario, includeOptional).forEach((step, index) => {
      // The mark leads, so a long title wraps under itself and never strands half a mark.
      const lead = `${index + 1}. `;
      const mark = setupStepMark(step);
      const titleRows = wrapSetupText(step.title, width - lead.length - mark.length - 1);
      titleRows.forEach((row, rowIndex) => {
        lines.push(
          rowIndex === 0
            ? [text(lead), roleChunk(core, step.required ? "ok" : "muted", mark), text(" "), boldChunk(core, row)]
            : [text(" ".repeat(lead.length + mark.length + 1)), boldChunk(core, row)],
        );
      });
      lines.push([roleChunk(core, "accent", `   $ ${step.cli}`)]);
      for (const row of wrapSetupText(step.why, width - 5)) lines.push([text(`     ${row}`)]);
      if (step.note !== previousNote) {
        for (const row of wrapSetupText(step.note, width - 5)) lines.push([text(`     ${row}`)]);
        previousNote = step.note;
      }
      lines.push([text("")]);
    });
    return lines;
  };

  const promptLines = (scenario: SetupScenario, width: number): Line[] => {
    const lines: Line[] = [[boldChunk(core, "Prompt for the agent")], [text("")]];
    for (const promptLine of promptOf(scenario).split("\n")) {
      const heading = /^(REQUIRED|OPTIONAL|Rules:)/.test(promptLine);
      for (const row of wrapSetupText(promptLine, width - 2)) {
        lines.push(row.length === 0 ? [text("")] : [heading ? boldChunk(core, `  ${row}`) : text(`  ${row}`)]);
      }
    }
    return lines;
  };

  const optionalLabel = (): string => `[Optional: ${includeOptional ? "on" : "off"}]`;

  /** Rewrite the plan, the prompt and the Optional button in place; no node is replaced. */
  const paintBody = (): void => {
    if (closed || current === undefined) return;
    const scenario = scenarioOf(current.tabId);
    current.plan.content = new core.StyledText(joinLines(planLines(scenario, current.width)));
    current.prompt.content = new core.StyledText(joinLines(promptLines(scenario, current.width)));
    current.optional.content = optionalLabel();
  };

  const toast = (message: string): void => {
    options.showToast?.(message);
  };

  const copy = (): void => {
    if (options.copyText === undefined) {
      toast("Copy is not available here");
      return;
    }
    options.copyText(promptOf(scenarioOf(activeId())));
    toast(COPIED_TOAST);
  };

  const toggleOptional = (): void => {
    includeOptional = !includeOptional;
    paintBody();
  };

  const runCard = (scenario: SetupScenario, run: readonly SetupStep[], skipped: readonly SetupStep[]): string[] => [
    `Run keryx setup: ${scenario.tab} (${scenario.title})`,
    `Project: ${projectRoot}`,
    `Steps (${includeOptional ? "required and optional" : "required only"}), in order:`,
    ...run.map((step, index) => `  ${index + 1}. ${step.cli}`),
    ...(skipped.length > 0
      ? ["Skipped, each needs a value from you and never runs unattended:", ...skipped.map((step) => `  - ${step.cli}`)]
      : []),
    "Keryx runs these steps itself as background jobs; no model is involved.",
  ];

  const run = async (): Promise<void> => {
    if (closed || confirming) return;
    if (running || options.isRunning?.() === true) {
      toast("A setup run is already in progress");
      return;
    }
    const confirm = options.confirm;
    const startRun = options.startRun;
    if (confirm === undefined || startRun === undefined) {
      toast("Run is not available here");
      return;
    }
    const scenario = scenarioOf(activeId());
    const { run: steps, skipped } = selectSetupSteps(scenario.steps, includeOptional);
    confirming = true;
    try {
      if (!(await confirm(runCard(scenario, steps, skipped)))) return;
    } finally {
      confirming = false;
    }
    running = true;
    // The modal never waits for the run: it is a set of background jobs, and this stays usable.
    void Promise.resolve(startRun({ scenarioTab: scenario.tab, scenarioTitle: scenario.title, projectRoot, steps, skipped }))
      .catch((error: unknown) => {
        toast(`Setup run failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };

  const handle = openModal(core, chrome as never, {
    title: SETUP_MODAL_TITLE,
    tabs,
    ...(initialTab !== undefined ? { initialTab } : {}),
    footer: [
      { key: "↑/↓", label: "scroll" },
      { key: "←/→", label: "tabs" },
      { key: "c", label: "copy" },
      { key: "r", label: "run" },
      { key: "o", label: "optional" },
      { key: "esc", label: "close" },
    ],
    renderTab: (tabId, body, ctx) => {
      const mount = body as { add(child: unknown): void };
      scrollView = findBodyScroll(body);
      // A narrow body (80-column terminal with the sidebar) cannot spare the button column:
      // the buttons stack above the text instead of squeezing it to a third of the width.
      const stacked = ctx.width < STACK_BELOW_COLS;
      const textWidth = Math.max(16, stacked ? ctx.width : ctx.width - ACTION_COLUMN_COLS);
      const row = new core.BoxRenderable(r as never, {
        id: "setup-row",
        flexDirection: stacked ? "column" : "row",
        width: "100%",
        flexShrink: 0,
      });
      const left = new core.BoxRenderable(r as never, {
        id: "setup-left",
        flexDirection: "column",
        width: textWidth,
        flexShrink: 0,
      });
      const plan = new core.TextRenderable(r as never, { id: "setup-plan", content: "" });
      const prompt = new core.TextRenderable(r as never, { id: "setup-prompt", content: "" });
      left.add(plan);
      left.add(prompt);
      const actions = new core.BoxRenderable(r as never, {
        id: "setup-actions",
        flexDirection: "column",
        width: ACTION_COLUMN_COLS,
        flexShrink: 0,
      });
      const accent = roleColor("accent");
      const runButton = smallActionButton(core, r as never, "Run", "setup-run", roleColor("ok"), () => void run());
      const copyButton = smallActionButton(core, r as never, "Copy prompt", "setup-copy", accent, copy);
      const optionalButton = smallActionButton(core, r as never, "Optional: off", "setup-optional", accent, toggleOptional);
      actions.add(runButton.box);
      actions.add(copyButton.box);
      actions.add(optionalButton.box);
      if (stacked) {
        row.add(actions);
        row.add(left);
      } else {
        row.add(left);
        row.add(actions);
      }
      mount.add(row);
      current = {
        tabId,
        plan: plan as unknown as TextNode,
        prompt: prompt as unknown as TextNode,
        optional: (optionalButton.box.getChildren()[0] ?? {}) as TextNode,
        width: textWidth,
      };
      paintBody();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
    },
  });
  if (handle === undefined) return undefined;
  host.handle = handle;

  const scrollBy = (delta: number): void => {
    if (scrollView === undefined) return;
    const max = Math.max(0, scrollView.scrollHeight - scrollView.viewport.height);
    scrollView.scrollTop = Math.min(max, Math.max(0, scrollView.scrollTop + delta));
  };

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (token === "up" || token === "k") scrollBy(-1);
    else if (token === "down" || token === "j") scrollBy(1);
    else if (token === "c") copy();
    else if (token === "o") toggleOptional();
    else if (token === "r") void run();
  });

  return handle;
}
