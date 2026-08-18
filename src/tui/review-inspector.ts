// /review inspector: list tab + adjacent detail tab, for the SLATE-10
// catch-up report (proposals, blocked sessions, unbound candidates, unknown
// sessions). Mirrors flow-inspector.ts's list+detail interaction model
// (`[`/`]`/enter, ↑/↓ scroll the active tab).
//
// The Detail tab's [a]-then-[y] accept is the one mutating action this modal
// offers, and only for `type: "proposal"` items — everything else (resume a
// blocked session, bind an unbound candidate, investigate an unknown one) is
// a recommendation to run from a terminal, not a button here. Accept is
// two keys, not one, so a stray `a` from scrolling/navigating never fires it;
// pressing anything other than `y` while armed cancels back to idle.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import type { CatchUpItem, CatchUpProposalItem } from "../sac/catch-up";

export const REVIEW_COMMAND = "/review";

export const REVIEW_FOOTER = [
  { key: "[/]", label: "item" },
  { key: "a y", label: "accept" },
  { key: "↑/↓", label: "scroll" },
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

export function isReviewCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === REVIEW_COMMAND;
}

const TYPE_LABEL: Record<CatchUpItem["type"], string> = {
  proposal: "PROPOSAL",
  blocked: "BLOCKED",
  "unbound-candidate": "UNBOUND",
  unknown: "UNKNOWN",
};

function summarizeReviewItem(item: CatchUpItem): string {
  switch (item.type) {
    case "proposal":
      return `${item.proposalId} in ${item.workspaceId}${item.fresh ? "" : " (stale)"}`;
    case "blocked":
      return `${item.sessionId} — ${item.terminalState.reason}`;
    case "unbound-candidate":
      return `${item.sessionId} — ${item.summary}`;
    case "unknown":
      return `${item.sessionId} — last seen ${item.lastSeenAt}`;
  }
}

export function formatReviewListLines(items: readonly CatchUpItem[], selected: number): string[] {
  if (items.length === 0) {
    return ["Nothing needs review right now."];
  }
  return items.map((item, index) => {
    const mark = index === selected ? ">" : " ";
    return `${mark} ${TYPE_LABEL[item.type].padEnd(8)} ${summarizeReviewItem(item)}`;
  });
}

function describeReviewItem(item: CatchUpItem): string[] {
  switch (item.type) {
    case "proposal":
      return [
        `Proposal   ${item.proposalId}`,
        `Workspace  ${item.workspaceId}`,
        `Evidence   ${item.fresh ? "fresh" : "stale — evidence has drifted since this proposal was created; re-run wrap-up before deciding"}`,
        "",
        `Reject/dismiss from a terminal: keryx workspace review ${item.workspaceId} ${item.proposalId} --decision <rejected|dismissed>`,
      ];
    case "blocked":
      return [
        `Session    ${item.sessionId}${item.workspaceId !== undefined ? `  (workspace ${item.workspaceId})` : ""}`,
        `Stopped unattended: ${item.terminalState.reason}`,
        `Occurred   ${item.terminalState.occurredAt}`,
        "",
        `Resume: keryx shell -r ${item.sessionId}`,
      ];
    case "unbound-candidate":
      return [
        `Session    ${item.sessionId}`,
        `Untriaged seeds: ${item.summary}`,
        `Evidence   ${item.evidencePath}`,
        "",
        `Bind: keryx workspace propose <workspace-id> --kind <kind> --session ${item.sessionId}`,
      ];
    case "unknown":
      return [
        `Session    ${item.sessionId}${item.workspaceId !== undefined ? `  (workspace ${item.workspaceId})` : ""}`,
        `Last seen  ${item.lastSeenAt}`,
        "No proposal, terminal state, or unbound-candidate artifact recorded.",
        "",
        `Investigate: keryx sessions list / keryx shell -r ${item.sessionId}`,
      ];
  }
}

export type ReviewDetailStatus =
  | { kind: "idle" }
  | { kind: "armed" }
  | { kind: "running" }
  | { kind: "done"; outcome: { ok: true } | { ok: false; message: string } };

export function formatReviewDetailLines(item: CatchUpItem | undefined, status: ReviewDetailStatus): string[] {
  if (item === undefined) {
    return ["No item selected.", "", "Press Enter (or click a row) on the Review tab to view one."];
  }
  const lines = describeReviewItem(item);
  if (item.type !== "proposal") {
    return lines;
  }
  const withAction = [...lines, ""];
  if (status.kind === "armed") {
    withAction.push("Press [y] to CONFIRM accept, any other key cancels.");
  } else if (status.kind === "running") {
    withAction.push("Accepting… running `keryx workspace confirm-review` then `keryx workspace review`.");
  } else if (status.kind === "done" && status.outcome.ok) {
    withAction.push("✓ Accepted.");
  } else if (status.kind === "done" && !status.outcome.ok) {
    withAction.push(`✗ Accept failed: ${status.outcome.message}`);
  } else {
    withAction.push("[a] Accept this proposal");
  }
  return withAction;
}

export function clampScroll(offset: number, lineCount: number, height: number): number {
  const max = Math.max(0, lineCount - height);
  return Math.min(max, Math.max(0, offset));
}

export function windowLines(lines: readonly string[], offset: number, height: number): string[] {
  if (height < 1) {
    return [];
  }
  const start = clampScroll(offset, lines.length, height);
  return lines.slice(start, start + height);
}

export function scrollToReveal(index: number, offset: number, height: number): number {
  if (index < offset) {
    return index;
  }
  if (index >= offset + height) {
    return index - height + 1;
  }
  return offset;
}

function wrapLines(text: string, width: number | undefined): string {
  if (width === undefined || width < 8) {
    return text;
  }
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) {
        return [line];
      }
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += width) {
        chunks.push(line.slice(i, i + width));
      }
      return chunks;
    })
    .join("\n");
}

function paintLines(
  otui: unknown,
  renderer: unknown,
  body: unknown,
  lines: readonly string[],
  width?: number,
): { content: string } | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return undefined;
  }
  const parent = body as { add?: (child: unknown) => void };
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => { content: string } })
    .TextRenderable;
  if (parent.add === undefined || ctor === undefined) {
    return undefined;
  }
  const node = new ctor(renderer, { id: "review-body", content: wrapLines(lines.join("\n"), width) });
  parent.add(node);
  return node;
}

export type AcceptProposalOutcome = { ok: true } | { ok: false; message: string };
export type AcceptProposalFn = (item: CatchUpProposalItem) => Promise<AcceptProposalOutcome>;

export type PresentReviewOptions = {
  items: readonly CatchUpItem[];
  /** Omitted entirely (rather than a no-op) when the caller has no way to
   * run the accept commands — the Detail tab then never offers `[a]` at all. */
  acceptProposal?: AcceptProposalFn;
  /** Fires once, after a successful accept — the caller's cue to refresh the
   * sidebar badge count; this modal's own list is already updated locally. */
  onAccepted?: (item: CatchUpProposalItem) => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  onKeypress?: (handler: (key: { name: string; sequence: string }) => void) => () => void;
};

export function presentReview(
  openModal: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentReviewOptions,
): ModalHandle | undefined {
  const items = [...options.items];
  let selected = 0;
  let listScroll = 0;
  let detailScroll = 0;
  let status: ReviewDetailStatus = { kind: "idle" };
  let listNode: { content: string } | undefined;
  let detailNode: { content: string } | undefined;
  let unsubscribeKey: (() => void) | undefined;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const bodyRows =
    options.visibleRows ??
    (typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13);
  let tabWidth: number | undefined;

  const listLines = (): string[] => formatReviewListLines(items, selected);
  const detailLines = (): string[] =>
    wrapLines(formatReviewDetailLines(items[selected], status).join("\n"), tabWidth).split("\n");

  const paintSelection = (): void => {
    listScroll = scrollToReveal(selected, listScroll, bodyRows);
    listScroll = clampScroll(listScroll, items.length, bodyRows);
    detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
    if (listNode !== undefined) {
      listNode.content = windowLines(listLines(), listScroll, bodyRows).join("\n");
    }
    if (detailNode !== undefined) {
      detailNode.content = windowLines(detailLines(), detailScroll, bodyRows).join("\n");
    }
  };

  const moveSelection = (next: number): void => {
    if (items.length === 0) {
      return;
    }
    const clamped = Math.min(items.length - 1, Math.max(0, next));
    if (clamped === selected) {
      return;
    }
    selected = clamped;
    detailScroll = 0;
    status = { kind: "idle" };
    paintSelection();
  };

  const runAccept = (): void => {
    const item = items[selected];
    if (item === undefined || item.type !== "proposal" || options.acceptProposal === undefined) {
      return;
    }
    status = { kind: "running" };
    paintSelection();
    void options.acceptProposal(item).then((outcome) => {
      status = { kind: "done", outcome };
      // Deliberately NOT spliced out of `items` here: the Detail tab needs to
      // keep showing this item so the "✓ Accepted." confirmation is actually
      // visible. The real catch-up report will simply no longer include it
      // the next time `/review` opens (a fresh `buildCatchUp` call) — this
      // modal instance's own list is a point-in-time snapshot, not a live view.
      if (outcome.ok) {
        options.onAccepted?.(item);
      }
      paintSelection();
    });
  };

  const handle = openModal(otui, chrome, {
    title: REVIEW_COMMAND,
    tabs: [
      { id: "list", label: "Review" },
      { id: "detail", label: "Detail" },
    ],
    initialTab: "list",
    footer: REVIEW_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      tabWidth = ctx?.width;
      if (tabId === "list") {
        listScroll = scrollToReveal(selected, listScroll, bodyRows);
        listNode = paintLines(otui, renderer, body, windowLines(listLines(), listScroll, bodyRows));
        return;
      }
      detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
      detailNode = paintLines(otui, renderer, body, windowLines(detailLines(), detailScroll, bodyRows), tabWidth);
    },
    onClose: () => {
      unsubscribeKey?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  if (options.onKeypress !== undefined) {
    unsubscribeKey = options.onKeypress((key) => {
      const token = key.name || key.sequence;
      if (items.length === 0) {
        return;
      }
      const onDetail = handle.activeTab() === "detail";
      // Armed accept consumes the very next key unconditionally — only an
      // exact `y` confirms; everything else (including nav keys) cancels
      // back to idle rather than falling through to navigation.
      if (onDetail && status.kind === "armed") {
        if (token === "y") {
          runAccept();
        } else {
          status = { kind: "idle" };
          paintSelection();
        }
        return;
      }
      if (token === "[" || token === "p") {
        moveSelection(selected - 1);
        return;
      }
      if (token === "]" || token === "n") {
        moveSelection(selected + 1);
        return;
      }
      if (token === "return" || token === "enter") {
        handle.setTab("detail");
        return;
      }
      if (
        onDetail &&
        token === "a" &&
        items[selected]?.type === "proposal" &&
        options.acceptProposal !== undefined &&
        status.kind !== "running"
      ) {
        status = { kind: "armed" };
        paintSelection();
        return;
      }
      if (token === "up" || token === "k") {
        if (onDetail) {
          detailScroll = clampScroll(detailScroll - 1, detailLines().length, bodyRows);
          paintSelection();
        } else {
          moveSelection(selected - 1);
        }
        return;
      }
      if (token === "down" || token === "j") {
        if (onDetail) {
          detailScroll = clampScroll(detailScroll + 1, detailLines().length, bodyRows);
          paintSelection();
        } else {
          moveSelection(selected + 1);
        }
        return;
      }
      if (onDetail && (token === "pageup" || token === "pagedown")) {
        const step = token === "pageup" ? -bodyRows : bodyRows;
        detailScroll = clampScroll(detailScroll + step, detailLines().length, bodyRows);
        paintSelection();
      }
    });
  }
  return handle;
}

export function openReview(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentReviewOptions,
): ModalHandle | undefined {
  return presentReview(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}
