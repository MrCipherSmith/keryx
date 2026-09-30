// Flow 369 (R4d): the `/approvals` modal — the calls a remote `keryx serve` turn
// is waiting on, plus the ones answered or expired recently. Each entry shows its
// summary, scope, consequence, expiry and state. `a` / `d` arm an allow / deny for
// the selected pending entry and `y` confirms it: an answer is one call, once, and
// never a session trust, so it takes a second key. The store is the only source of
// truth; nothing here keeps a copy of a decision.

import { answerApprovalText, type AnswerResult } from "../commands/approvals";
import { approvalLines, splitApprovals } from "../lib/serve-approvals-format";
import { listApprovals, type ApprovalView } from "../lib/serve-approvals-store";
import { clampScroll, scrollToReveal, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const APPROVALS_COMMAND = "/approvals";

export function isApprovalsCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === APPROVALS_COMMAND;
}

export const APPROVALS_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "a", label: "allow" },
  { key: "d", label: "deny" },
  { key: "y", label: "confirm" },
  { key: "esc", label: "close" },
] as const;

export interface ApprovalsModalView {
  /** Selectable entries: pending first (oldest first), then the recently resolved. */
  items: ApprovalView[];
  lines: string[];
  /** The line each item starts on, for scrolling it into view. */
  itemStart: number[];
}

export function formatApprovalsModal(views: readonly ApprovalView[], selected: number, now: Date, notice?: string): ApprovalsModalView {
  const { pending, resolved } = splitApprovals(views, now);
  const items = [...pending, ...resolved];
  const lines: string[] = [];
  const itemStart: number[] = [];
  const push = (view: ApprovalView): void => {
    itemStart.push(lines.length);
    const mark = items[selected] === view ? ">" : " ";
    approvalLines(view, now).forEach((line, index) => lines.push(index === 0 ? `${mark} ${line}` : `  ${line}`));
    lines.push("");
  };
  lines.push(pending.length === 0 ? "No pending approvals." : `Pending approvals (${pending.length}) - a allow, d deny, once, that call only`);
  if (notice !== undefined && notice.length > 0) {
    lines.push(notice);
  }
  lines.push("");
  pending.forEach(push);
  if (resolved.length > 0) {
    lines.push(`Recently resolved (${resolved.length}):`, "");
    resolved.forEach(push);
  }
  return { items, lines, itemStart };
}

export interface ApprovalsModalOptions {
  /** Every approval on record; read fresh on each paint and reload. */
  load?: () => readonly ApprovalView[];
  answer?: (id: string, decision: "allow" | "deny") => AnswerResult;
  now?: () => Date;
  /** Runs after an answer was applied or refused, so the sidebar count follows. */
  onAnswered?: () => void;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
}

export interface ApprovalsModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
  selected(): ApprovalView | undefined;
  /** Re-reads the store and repaints; the poll calls this while the modal is open. */
  reload(): void;
}

export function openApprovals(otui: unknown, chrome: unknown, options: ApprovalsModalOptions): ApprovalsModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);
  const load = options.load ?? ((): readonly ApprovalView[] => listApprovals(undefined, { now: now() }));
  const answer = options.answer ?? ((id: string, decision: "allow" | "deny"): AnswerResult => answerApprovalText(decision, id));

  let selected = 0;
  let scroll = 0;
  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  let notice: string | undefined;
  let armed: { id: string; decision: "allow" | "deny" } | undefined;
  const keys: { off?: () => void } = {};

  function now(): Date {
    return options.now?.() ?? new Date();
  }
  const model = (): ApprovalsModalView => formatApprovalsModal(load(), selected, now(), armed !== undefined ? armedPrompt() : notice);
  function armedPrompt(): string {
    const view = load().find((item) => item.approvalId === armed?.id);
    const what = view?.summary ?? armed?.id ?? "this call";
    return `${armed?.decision === "allow" ? "Allow" : "Deny"} ${what}, once? press y to confirm, any other key cancels`;
  }
  const clampSelected = (items: number): void => {
    selected = Math.min(Math.max(0, items - 1), Math.max(0, selected));
  };
  const visible = (): string[] => {
    const view = model();
    clampSelected(view.items.length);
    return windowLines(wrapLines(view.lines.join("\n"), width).split("\n"), scroll, bodyRows);
  };
  const paint = (): void => {
    if (closed) return;
    const view = model();
    clampSelected(view.items.length);
    const wrapped = wrapLines(view.lines.join("\n"), width).split("\n");
    const start = view.itemStart[selected] ?? 0;
    scroll = clampScroll(scrollToReveal(start, scroll, bodyRows), wrapped.length, bodyRows);
    if (bodyNode !== undefined) bodyNode.content = core.t`${dimChunk(core, windowLines(wrapped, scroll, bodyRows).join("\n"))}`;
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: APPROVALS_COMMAND,
    tabs: [{ id: "list", label: "Approvals" }],
    footer: APPROVALS_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "approvals-body", content: "" }) as never;
      parent.add(bodyNode);
      paint();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  const modal = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "approvals-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  const selectedView = (): ApprovalView | undefined => model().items[selected];
  const isAnswerable = (view: ApprovalView | undefined): view is ApprovalView =>
    view !== undefined && view.state === "pending" && Date.parse(view.expiresAt) > now().getTime();

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    const token = key.name || key.sequence;
    if (armed !== undefined) {
      const pending: { id: string; decision: "allow" | "deny" } = armed;
      armed = undefined;
      if (token === "y") {
        const result = answer(pending.id, pending.decision);
        notice = result.text;
        options.onAnswered?.();
      }
      paint();
      return;
    }
    if (token === "up" || token === "k") {
      selected = Math.max(0, selected - 1);
      notice = undefined;
    } else if (token === "down" || token === "j") {
      selected += 1;
      notice = undefined;
    } else if (token === "a" || token === "d") {
      const view = selectedView();
      if (isAnswerable(view)) {
        armed = { id: view.approvalId, decision: token === "a" ? ("allow" as const) : ("deny" as const) };
      } else {
        notice = view === undefined ? "Nothing to answer." : "That approval is no longer pending.";
      }
    } else {
      return;
    }
    paint();
  });

  return {
    ...modal,
    visibleLines: visible,
    selected: selectedView,
    reload: () => {
      const view = model();
      if (armed !== undefined && !view.items.some((item) => item.approvalId === armed?.id && isAnswerable(item))) {
        armed = undefined;
      }
      paint();
    },
  };
}
