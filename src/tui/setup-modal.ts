// `/setup` modal. One tab per Metaproject preparation scenario. The body is
// the same text `keryx setup <id>` prints (`renderSetupScenario`), so the
// shell and the CLI cannot drift. Read-only: nothing here runs a command.

import { renderSetupScenario, SETUP_SCENARIOS, type SetupScenarioId } from "../commands/setup-guide";
import { clampScroll, windowLines } from "./flow-inspector";
import { openModal, type ModalHandle } from "./modal-host";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const SETUP_MODAL_TITLE = "/setup";
export const SETUP_MODAL_KEYS = "keys: ↑/↓ scroll · ←/→ tabs · esc close";

export interface SetupModalOptions {
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  inputBlocked?: () => boolean;
  initialScenario?: SetupScenarioId;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
}

export interface SetupModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
}

export function openSetupModal(
  otui: unknown,
  chrome: unknown,
  options: SetupModalOptions,
): SetupModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const hint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows = Math.max(6, options.visibleRows ?? (typeof hint?.height === "number" ? Math.min(24, hint.height - 8) : 16));
  const width = typeof hint?.width === "number" ? Math.max(40, hint.width - 8) : 72;
  const tabs = SETUP_SCENARIOS.map((scenario) => ({ id: scenario.id, label: scenario.tab }));
  const scroll = new Map<string, number>(tabs.map((tab) => [tab.id, 0]));
  let closed = false;
  let bodyNode: { content: unknown } | undefined;
  const keys: { off?: () => void } = {};
  const host: { handle?: ModalHandle } = {};

  const linesFor = (id: string): string[] => {
    const scenario = SETUP_SCENARIOS.find((item) => item.id === id) ?? SETUP_SCENARIOS[0]!;
    return [SETUP_MODAL_KEYS, "", ...renderSetupScenario(scenario, width).split("\n")];
  };

  const paint = (): void => {
    if (closed || bodyNode === undefined) return;
    const id = host.handle?.activeTab() ?? tabs[0]!.id;
    const lines = linesFor(id);
    const top = clampScroll(scroll.get(id) ?? 0, lines.length, bodyRows);
    scroll.set(id, top);
    bodyNode.content = core.t`${dimChunk(core, windowLines(lines, top, bodyRows).join("\n"))}`;
  };

  const handle = openModal(core, chrome as never, {
    title: SETUP_MODAL_TITLE,
    tabs,
    ...(options.initialScenario !== undefined ? { initialTab: options.initialScenario } : {}),
    footer: [
      { key: "↑/↓", label: "scroll" },
      { key: "←/→", label: "tabs" },
      { key: "esc", label: "close" },
    ],
    renderTab: (_tabId, body) => {
      const mount = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "setup-body", content: "" }) as never;
      mount.add(bodyNode as never);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
    },
  });
  if (handle === undefined) return undefined;
  host.handle = handle;

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    const id = host.handle?.activeTab() ?? tabs[0]!.id;
    const lines = linesFor(id);
    if (token === "up" || token === "k") {
      scroll.set(id, clampScroll((scroll.get(id) ?? 0) - 1, lines.length, bodyRows));
      paint();
    } else if (token === "down" || token === "j") {
      scroll.set(id, clampScroll((scroll.get(id) ?? 0) + 1, lines.length, bodyRows));
      paint();
    }
  });

  return {
    ...handle,
    visibleLines: () => {
      const id = host.handle?.activeTab() ?? tabs[0]!.id;
      return windowLines(linesFor(id), scroll.get(id) ?? 0, bodyRows);
    },
  };
}
