import {
  getExecutionPlan,
  subscribeExecutionPlans,
  type ExecutionPlan,
  type ExecutionPlanStatus,
} from "../session/execution-plan";

const GLYPHS: Readonly<Record<ExecutionPlanStatus, string>> = {
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
  if (text.length <= width) return text;
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

export function projectExecutionPlanPanel(
  plan: ExecutionPlan | undefined,
  options: { width: number; maxRows?: number },
): ExecutionPlanPanelProjection {
  if (plan === undefined || plan.items.length === 0) {
    return { visible: false, rows: [], revision: undefined };
  }
  const size = Math.max(1, Math.min(options.maxRows ?? 7, 7, plan.items.length));
  const active = Math.max(0, plan.items.findIndex((item) => item.status === "in_progress"));
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), plan.items.length - size));
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

type TextCtor = new (renderer: unknown, options: { id: string; content: string; marginTop?: number }) => unknown;

export function mountExecutionPlanPanel(
  otui: unknown,
  renderer: unknown,
  parent: unknown,
  options: { getSessionDir: () => string | undefined; width: number; maxRows?: number },
): { refresh: () => Promise<void>; dispose: () => void } {
  const box = parent as PanelParent;
  let paintedDir: string | undefined;
  let paintedRevision: number | undefined;
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
    box.add(new Ctor(renderer, { id: "sb-plan-h", content: "Plan", marginTop: 1 }));
    for (const row of projected.rows) box.add(new Ctor(renderer, { id: `sb-plan-${row.id}`, content: row.text }));
  };
  const refresh = async (): Promise<void> => {
    const dir = options.getSessionDir();
    paint(dir === undefined ? undefined : await getExecutionPlan(dir).catch(() => undefined), dir);
  };
  const unsubscribe = subscribeExecutionPlans((dir, plan) => {
    if (dir === options.getSessionDir()) paint(plan, dir);
  });
  void refresh();
  return { refresh, dispose: unsubscribe };
}
