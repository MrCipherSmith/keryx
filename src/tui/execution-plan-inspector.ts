// Execution-plan inspector (sidebar `Plan` → modal, flow-283 follow-up).
//
// Presentation only: the plan is owned by `src/session/execution-plan.ts`, and
// this module never mutates it. Structural mirror of
// `background-job-inspector.ts` — the same shared modal host (`openModal`, no
// private overlay), the same "sidebar row opens the inspector" split, and the
// same live-subscription rule: the sidebar panel and this modal subscribe to
// the SAME plan store, so a `plan_set`/`plan_update` from the agent repaints
// both without either knowing about the other.
//
// Why a modal at all: the sidebar's seven centered rows are a STATUS GLANCE —
// they exist to answer "is it moving?" mid-turn, and they deliberately drop
// everything that does not fit 26 columns. "What exactly is left, and what is
// it called?" needs the full list, the spelled-out status of each row, and the
// revision — none of which the sidebar has room for.

import { openModal } from "./modal-host";
import { boldChunk, dimChunk, roleChunk } from "./theme-text";
import {
  subscribeExecutionPlans,
  type ExecutionPlan,
  type ExecutionPlanItem,
  type ExecutionPlanStatus,
} from "../session/execution-plan";

export const PLAN_INSPECTOR_FOOTER = [
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

/** The same five glyphs the sidebar panel uses — one vocabulary, two sizes. */
export const PLAN_STATUS_GLYPH: Readonly<Record<ExecutionPlanStatus, string>> = {
  proposed: "◇",
  completed: "✓",
  in_progress: "▶",
  pending: "○",
  blocked: "!",
  skipped: "−",
};

/** Spelled out here because the modal has the width the sidebar never had. */
export const PLAN_STATUS_LABEL: Readonly<Record<ExecutionPlanStatus, string>> = {
  proposed: "awaiting approval",
  completed: "completed",
  in_progress: "in progress",
  pending: "pending",
  blocked: "blocked",
  skipped: "skipped",
};

const PLAN_STATUS_ORDER: readonly ExecutionPlanStatus[] = [
  "proposed",
  "in_progress",
  "pending",
  "blocked",
  "completed",
  "skipped",
];

export const PLAN_EMPTY_TEXT =
  "No execution plan in this session. The agent publishes one with `plan_set` before multi-step work.";

/** Count per status, every status present (never a partial record). */
export function planCounts(plan: ExecutionPlan): Record<ExecutionPlanStatus, number> {
  const counts: Record<ExecutionPlanStatus, number> = {
    proposed: 0,
    completed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const item of plan.items) {
    counts[item.status] += 1;
  }
  return counts;
}

/** `▰▰▰▱▱▱` — completed / total, the one number a glance should carry. */
export function planProgressBar(plan: ExecutionPlan, width = 12): string {
  const total = plan.items.length;
  const done = plan.items.filter((item) => item.status === "completed").length;
  if (total === 0) {
    return "▱".repeat(width);
  }
  const filled = Math.min(width, Math.max(0, Math.round((done / total) * width)));
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
}

/** `Plan · revision 3 · 4/7 done · 1 in progress · 1 blocked` — zero counts are omitted, not printed as noise. */
export function formatPlanSummary(plan: ExecutionPlan | undefined): string {
  if (plan === undefined) {
    return "Plan · nothing published yet";
  }
  const counts = planCounts(plan);
  const parts = [
    `revision ${plan.revision}`,
    `${counts.completed}/${plan.items.length} done`,
    ...(counts.proposed > 0 ? [`${counts.proposed} awaiting approval`] : []),
    ...(counts.in_progress > 0 ? [`${counts.in_progress} in progress`] : []),
    ...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
    ...(counts.pending > 0 ? [`${counts.pending} pending`] : []),
    ...(counts.skipped > 0 ? [`${counts.skipped} skipped`] : []),
  ];
  return `Plan · ${parts.join(" · ")}`;
}

/**
 * The status column is as wide as the LONGEST label, so a mixed plan reads as
 * one aligned table instead of a ragged one — "awaiting approval" (17) is what
 * sets the width, and a row whose status needs no padding simply runs on.
 */
const PLAN_LABEL_WIDTH = Math.max(...Object.values(PLAN_STATUS_LABEL).map((label) => label.length));

/** One row: glyph + the status in words + the title the agent gave it. */
export function formatPlanRow(item: ExecutionPlanItem): string {
  return `${PLAN_STATUS_GLYPH[item.status]} ${PLAN_STATUS_LABEL[item.status].padEnd(PLAN_LABEL_WIDTH)} ${item.title}`;
}

/** The glyph→word key, so a reader never has to guess what `!` meant. */
export function formatPlanLegend(): string {
  return PLAN_STATUS_ORDER.map(
    (status) => `${PLAN_STATUS_GLYPH[status]} ${PLAN_STATUS_LABEL[status]}`,
  ).join("   ");
}

/** The Meta tab: what the numbers are, where the plan lives, and which item is active. */
export function formatPlanMeta(plan: ExecutionPlan | undefined, dir: string | undefined): string {
  if (plan === undefined) {
    return [
      "Nothing published.",
      "",
      "Storage   <session>/plan.json (beside slate.json)",
      ...(dir === undefined ? [] : [`Session   ${dir}`]),
    ].join("\n");
  }
  const counts = planCounts(plan);
  const active = plan.items.find((item) => item.status === "in_progress");
  const blocked = plan.items.filter((item) => item.status === "blocked").map((item) => item.id);
  return [
    `Revision  ${plan.revision}`,
    `Items     ${plan.items.length} — ${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.blocked} blocked, ${counts.skipped} skipped, ${counts.proposed} awaiting approval`,
    `Active    ${active === undefined ? "(none — no item is in_progress)" : `${active.id} — ${active.title}`}`,
    ...(blocked.length > 0 ? [`Blocked   ${blocked.join(", ")}`] : []),
    ...(counts.proposed > 0
      ? [`Approval  ${counts.proposed} item(s) published for your approval — nothing is running; they start once you approve`]
      : []),
    "",
    "Storage   <session>/plan.json — a sibling of slate.json, so a completed",
    "          Flow closing its slate can no longer take the plan with it.",
    "",
    "Note      This is the agent's own plan for this session. The `/plan on|off`",
    "          COMMAND is a different thing — the session's read-only mode, which",
    "          this view neither shows nor changes.",
    ...(dir === undefined ? [] : [`Session   ${dir}`]),
  ].join("\n");
}

export type PlanModalTab = { id: string; label: string };

export type PlanModalInput = {
  title: string;
  tabs: readonly PlanModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown) => void | (() => void);
  onClose?: () => void;
};

export type PlanModalHandle = { close(): void; setTab(id: string): void; activeTab(): string };

export type PlanOpenModalFn = (
  otui: unknown,
  chrome: unknown,
  input: PlanModalInput,
) => PlanModalHandle | undefined;

export type PresentExecutionPlanInspectorOptions = {
  /** Resolved per read, like the sidebar panel's own getter — a session switch must not show the old session's plan. */
  getSessionDir: () => string | undefined;
  /** The plan read before opening; `undefined` renders the empty state. */
  initial: ExecutionPlan | undefined;
  renderer?: unknown;
};

type PlanTextNode = { content: unknown };
type PlanTextCtor = new (
  renderer: unknown,
  opts: { id: string; content: unknown; marginTop?: number; onMouseDown?: () => void },
) => PlanTextNode;
type PlanBody = {
  add?: (child: unknown) => void;
  getChildren?: () => unknown[];
  remove?: (child: unknown) => void;
};

type StyleHelpers = {
  t?: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  fg?: (color: string) => (text: string) => unknown;
  bold?: (text: string) => unknown;
  dim?: (text: string) => unknown;
};

/**
 * The role a plan row is painted in. A role resolves through `theme.ts` to the
 * ACTIVE palette's colour; the names replaced here were OpenTUI's own helpers,
 * whose fixed hexes vanish on the light palettes (see `theme-text.ts`).
 */
type Tone = "strong" | "muted" | "accent" | "attention" | "error" | "plain";

function toneFor(status: ExecutionPlanStatus): Tone {
  switch (status) {
    case "proposed":
      // Attention, not error: nothing failed — a human is being asked.
      return "attention";
    case "in_progress":
      return "accent";
    case "blocked":
      return "error";
    case "completed":
    case "skipped":
      return "muted";
    case "pending":
      return "plain";
  }
}

/**
 * Styled when the host actually has the style helpers (a real OpenTUI), plain
 * text otherwise — a headless test hands us a `TextRenderable` and nothing
 * else, and a row it cannot read is worse than a row it cannot colour.
 */
export function stylePlanText(otui: unknown, text: string, tone: Tone): unknown {
  const helpers = (otui ?? {}) as StyleHelpers;
  const tag = helpers.t;
  if (typeof tag !== "function" || typeof helpers.fg !== "function" || tone === "plain") {
    return text;
  }
  // Every arm resolves through the ACTIVE theme's palette, never through
  // `otui.dim`/`otui.bold`'s own uncoloured (terminal-default) rendering.
  const core = otui as Parameters<typeof roleChunk>[0];
  switch (tone) {
    case "strong":
      return tag`${boldChunk(core, text)}`;
    case "muted":
      return tag`${dimChunk(core, text)}`;
    default:
      return tag`${roleChunk(core, tone, text)}`;
  }
}

export function presentExecutionPlanInspector(
  openModalFn: PlanOpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentExecutionPlanInspectorOptions,
): PlanModalHandle | undefined {
  let plan = options.initial;
  const dir = options.getSessionDir();
  let body: PlanBody | undefined;
  let tab = "plan";
  const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;

  const paint = (): void => {
    if (body === undefined || body.add === undefined) {
      return;
    }
    const Ctor = (otui as { TextRenderable?: PlanTextCtor }).TextRenderable;
    if (Ctor === undefined) {
      return;
    }
    if (body.getChildren !== undefined && body.remove !== undefined) {
      for (const child of [...body.getChildren()]) {
        body.remove(child);
      }
    }
    const add = (id: string, content: unknown, marginTop?: number): void => {
      body?.add?.(new Ctor(renderer, { id, content, ...(marginTop === undefined ? {} : { marginTop }) }));
    };
    if (tab === "meta") {
      add("plan-meta", formatPlanMeta(plan, dir));
      return;
    }
    add("plan-summary", stylePlanText(otui, formatPlanSummary(plan), "strong"));
    if (plan === undefined || plan.items.length === 0) {
      add("plan-empty", stylePlanText(otui, PLAN_EMPTY_TEXT, "muted"), 1);
      return;
    }
    add(
      "plan-bar",
      stylePlanText(otui, `${planProgressBar(plan)}  ${planCounts(plan).completed}/${plan.items.length}`, "accent"),
      1,
    );
    add("plan-legend", stylePlanText(otui, formatPlanLegend(), "muted"), 1);
    plan.items.forEach((item, index) => {
      add(
        `plan-item-${item.id}`,
        stylePlanText(otui, formatPlanRow(item), toneFor(item.status)),
        index === 0 ? 1 : undefined,
      );
    });
  };

  // Declared BEFORE the modal opens: `onClose` can fire synchronously inside
  // `openModalFn` (a host that refuses to mount calls it), and a `const`
  // assigned afterwards would hit the TDZ exactly there.
  // eslint-disable-next-line prefer-const -- see above.
  let unsubscribe: (() => void) | undefined;
  const handle = openModalFn(otui, chrome, {
    // NOT "/plan": that name belongs to the operator's read-only mode command
    // (`/plan on|off`, `docs/docs/guides/permission-modes.md`), whose meaning
    // predates this panel. Two different things under one name is how an
    // operator concludes the plan view toggles their permissions.
    title: "Session plan",
    tabs: [
      { id: "plan", label: "Plan" },
      { id: "meta", label: "Meta" },
    ],
    initialTab: "plan",
    footer: PLAN_INSPECTOR_FOOTER,
    renderTab: (tabId, nextBody) => {
      tab = tabId;
      body = nextBody as PlanBody;
      paint();
    },
    onClose: () => {
      unsubscribe?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  // Live: the agent's next `plan_set`/`plan_update` repaints this modal in
  // place, exactly as it repaints the sidebar. A repaint is skipped when the
  // revision is unchanged (a `notify` for the same state is not news), and an
  // event for a DIFFERENT session dir is ignored rather than adopted.
  unsubscribe = subscribeExecutionPlans((eventDir, next) => {
    if (eventDir !== dir) {
      return;
    }
    if (next.revision === plan?.revision) {
      return;
    }
    plan = next;
    paint();
  });
  return handle;
}

/** Read the plan, then open the inspector. Returns `undefined` when the host declined to mount a modal. */
export async function openExecutionPlanInspector(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: {
    getSessionDir: () => string | undefined;
    readPlan: (dir: string) => Promise<ExecutionPlan | undefined>;
    renderer?: unknown;
  },
): Promise<PlanModalHandle | undefined> {
  const dir = options.getSessionDir();
  const initial = dir === undefined ? undefined : await options.readPlan(dir).catch(() => undefined);
  return presentExecutionPlanInspector(
    (hostOtui, hostChrome, input) =>
      openModal(
        hostOtui as Parameters<typeof openModal>[0],
        hostChrome as Parameters<typeof openModal>[1],
        input,
      ),
    otui,
    chrome,
    { getSessionDir: options.getSessionDir, initial, ...(options.renderer === undefined ? {} : { renderer: options.renderer }) },
  );
}
