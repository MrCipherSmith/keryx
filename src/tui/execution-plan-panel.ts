import {
  getExecutionPlan,
  subscribeExecutionPlans,
  type ExecutionPlan,
  type ExecutionPlanStatus,
} from "../session/execution-plan";
import { displayWidth } from "../lib/live-render";

const GLYPHS: Readonly<Record<ExecutionPlanStatus, string>> = {
  proposed: "◇",
  completed: "✓",
  in_progress: "▶",
  pending: "○",
  blocked: "!",
  skipped: "−",
};

export type ExecutionPlanPanelRow = {
  id: string;
  status: ExecutionPlanStatus;
  glyph: string;
  text: string;
};

export type ExecutionPlanPanelProjection = {
  visible: boolean;
  rows: ExecutionPlanPanelRow[];
  revision: number | undefined;
};

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  let prefix = "";
  for (const character of text) {
    if (displayWidth(prefix + character) > width - 1) break;
    prefix += character;
  }
  return `${prefix}…`;
}

export function projectExecutionPlanPanel(
  plan: ExecutionPlan | undefined,
  options: { width: number; maxRows?: number },
): ExecutionPlanPanelProjection {
  if (plan === undefined || plan.items.length === 0) {
    return { visible: false, rows: [], revision: undefined };
  }
  const size = Math.max(1, Math.min(options.maxRows ?? 7, 7, plan.items.length));
  // The window follows the work: the running item first, else the first thing
  // still to do, else the first item awaiting approval. Anchoring on the TOP of
  // the list whenever nothing was `in_progress` was how a long plan showed
  // "item 1..7" while everything actually moved at the far end — the same
  // complaint as "the sidebar was frozen", one cause further down.
  const firstOf = (status: ExecutionPlanStatus): number => plan.items.findIndex((i) => i.status === status);
  const anchorIndex = firstOf("in_progress");
  const pendingIndex = firstOf("pending");
  const proposedIndex = firstOf("proposed");
  const anchor = anchorIndex >= 0 ? anchorIndex : pendingIndex >= 0 ? pendingIndex : Math.max(0, proposedIndex);
  const start = Math.max(0, Math.min(anchor - Math.floor(size / 2), plan.items.length - size));
  const rows = plan.items.slice(start, start + size).map((item) => {
    const glyph = GLYPHS[item.status];
    return { id: item.id, status: item.status, glyph, text: truncate(`${glyph} ${item.title}`, options.width) };
  });
  return { visible: true, rows, revision: plan.revision };
}

type PanelParent = {
  add?: (child: unknown) => void;
  getChildren?: () => unknown[];
  remove?: (child: unknown) => void;
};

type TextCtor = new (
  renderer: unknown,
  options: { id: string; content: string; marginTop?: number; onMouseDown?: () => void },
) => unknown;

export function mountExecutionPlanPanel(
  otui: unknown,
  renderer: unknown,
  parent: unknown,
  options: {
    getSessionDir: () => string | undefined;
    width: number;
    maxRows?: number;
    /**
     * Opens the full-plan inspector. Attached to the header AND to every row,
     * so the whole section is a target — the sidebar has rows, not buttons, and
     * a click on any of them means the same thing: show me the plan.
     */
    onOpen?: () => void;
  },
): { refresh: () => Promise<void>; dispose: () => void } {
  const box = parent as PanelParent;
  let paintedDir: string | undefined;
  let paintedRevision: number | undefined;
  let refreshGeneration = 0;
  let disposed = false;
  const paint = (plan: ExecutionPlan | undefined, dir: string | undefined): void => {
    const projected = projectExecutionPlanPanel(plan, {
      width: options.width,
      ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    });
    if (paintedDir === dir && paintedRevision === projected.revision) return;
    paintedDir = dir;
    paintedRevision = projected.revision;
    if (box.getChildren !== undefined && box.remove !== undefined) {
      for (const child of [...box.getChildren()]) box.remove(child);
    }
    const Ctor = (otui as { TextRenderable?: TextCtor }).TextRenderable;
    if (!projected.visible || box.add === undefined || Ctor === undefined) return;
    const open = options.onOpen;
    const clickable = open === undefined ? {} : { onMouseDown: open };
    // The header carries the revision: the modal is where the detail lives, but
    // the section should still say WHICH revision it is showing.
    const header = projected.revision === undefined ? "Plan" : `Plan · rev ${projected.revision}`;
    box.add(new Ctor(renderer, { id: "sb-plan-h", content: header, marginTop: 1, ...clickable }));
    for (const row of projected.rows) {
      box.add(new Ctor(renderer, { id: `sb-plan-${row.id}`, content: row.text, ...clickable }));
    }
  };
  const refresh = async (): Promise<void> => {
    const dir = options.getSessionDir();
    const generation = ++refreshGeneration;
    const plan = dir === undefined ? undefined : await getExecutionPlan(dir).catch(() => undefined);
    if (disposed || generation !== refreshGeneration || dir !== options.getSessionDir()) return;
    paint(plan, dir);
  };
  const unsubscribe = subscribeExecutionPlans((dir, plan) => {
    if (dir === options.getSessionDir()) {
      refreshGeneration += 1;
      paint(plan, dir);
    }
  });
  void refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      refreshGeneration += 1;
      unsubscribe();
    },
  };
}
