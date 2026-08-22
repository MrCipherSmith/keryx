// /review inspector: list tab + adjacent detail tab, for the SLATE-10
// catch-up report (proposals, blocked sessions, unbound candidates, unknown
// sessions). Mirrors flow-inspector.ts's list+detail interaction model
// (`[`/`]`/enter, ↑/↓ scroll the active tab).
//
// The Detail tab's [a]-then-[y] accept and [d]-then-[y] decline are the only
// mutating actions this modal offers, and only for `type: "proposal"` items —
// everything else (resume a blocked session, bind an unbound candidate,
// investigate an unknown one) is a recommendation to run from a terminal, not
// a button here. Both are two keys, not one, so a stray `a`/`d` from
// scrolling/navigating never fires them; pressing anything other than `y`
// while armed cancels back to idle. Pressing `a`/`d` on a non-proposal item
// (or with no handler wired) sets `status: "unavailable"` rather than doing
// nothing silently — the footer's hint is the same regardless of which item
// is selected (it's a static per-modal legend, not per-item), so a user who
// presses it on, say, a blocked session needs to be told why nothing
// happened instead of concluding the feature is broken.

import { modalBodyRows, openModal, resolveModalPanelSize } from "./modal-host";
import type { CatchUpItem, CatchUpProposalItem } from "../sac/catch-up";
import type { WrapUpGroupOutcome } from "../sac/machine-wrap-up";
import { getTheme } from "./theme";

export const REVIEW_COMMAND = "/review";

export const REVIEW_FOOTER = [
  { key: "[/]", label: "item" },
  { key: "←/→ a d", label: "accept/decline" },
  { key: "enter y", label: "arm → confirm" },
  { key: "↑/↓", label: "scroll" },
  { key: "esc", label: "close" },
] as const;

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  /** Claim `←`/`→` before modal-host's tab switch (review buttons). */
  onArrowKeys?: (key: { name: string; sequence: string }, direction: "left" | "right") => boolean | undefined;
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
      return `${item.kind} ${item.proposalId} in ${item.workspaceId}${item.fresh ? "" : " (stale)"}`;
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
        `Kind       ${item.kind}`,
        `Author     ${item.author}`,
        `Created    ${item.createdAt}`,
        `Evidence   ${item.fresh ? "fresh" : "stale — evidence has drifted since this proposal was created; re-run wrap-up before deciding"}`,
        ...(item.note !== undefined ? ["", `Note       ${item.note}`] : []),
        "",
        `Dismiss (archive with no decision) from a terminal: keryx workspace review ${item.workspaceId} ${item.proposalId} --decision dismissed`,
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
      return item.wrapUpOutcome !== undefined
        ? [
            `Session    ${item.sessionId}${item.workspaceId !== undefined ? `  (workspace ${item.workspaceId})` : ""}`,
            `Last seen  ${item.lastSeenAt}`,
            `Wrap-up dispatch (${item.wrapUpOutcome.trigger}, ${item.wrapUpOutcome.generatedAt}) did not produce a proposal or unbound-candidate:`,
            ...item.wrapUpOutcome.groups.map((g) => `  ${g.kind}: ${describeGroupOutcome(g)}`),
            "",
            `Investigate: keryx sessions list / keryx shell -r ${item.sessionId}`,
          ]
        : [
            `Session    ${item.sessionId}${item.workspaceId !== undefined ? `  (workspace ${item.workspaceId})` : ""}`,
            `Last seen  ${item.lastSeenAt}`,
            "No proposal, terminal state, or unbound-candidate artifact recorded.",
            "",
            `Investigate: keryx sessions list / keryx shell -r ${item.sessionId}`,
          ];
  }
}

/** Renders one `WrapUpGroupOutcome` as a human-readable failure reason for
 * the `"unknown"` detail view above. `"proposed"`/`"unbound-candidate"` never
 * reach here in practice (`classifySession`'s `isFailureOutcome` filter
 * upstream only attaches `wrapUpOutcome` when EVERY group is a failure
 * outcome), but are handled defensively with a fallback string so this
 * function stays total over the union — TypeScript's exhaustiveness checking
 * (the `default` branch below) catches a future new outcome variant. */
function describeGroupOutcome(g: WrapUpGroupOutcome): string {
  switch (g.outcome) {
    case "error":
      return g.message;
    case "no_credential":
      return "no model credential available";
    case "conflict":
      return "a concurrent proposal already claimed this slot";
    case "proposed":
      return `proposed (${g.proposalId})`;
    case "unbound-candidate":
      return "unbound candidate";
    default: {
      const exhaustive: never = g;
      return `unrecognized outcome: ${JSON.stringify(exhaustive)}`;
    }
  }
}

/** The two mutating actions this modal offers — `accept` or `decline` (a
 * `--decision rejected`; `dismissed` stays terminal-only, see
 * `describeReviewItem`'s proposal case). */
export type ReviewDecision = "accept" | "decline";

export type ReviewDetailStatus =
  | { kind: "idle" }
  /** `a`/`d` was pressed but nothing could arm — either the selected item
   * isn't a proposal, or the caller wired no handler for this decision.
   * Distinct from `idle` so the Detail pane can say WHY, instead of the key
   * just silently doing nothing (the footer's `a y`/`d y` hint is a static,
   * per-modal legend — it can't itself tell the user it doesn't apply here). */
  | { kind: "unavailable"; decision: ReviewDecision }
  | { kind: "armed"; decision: ReviewDecision }
  | { kind: "running"; decision: ReviewDecision }
  | { kind: "done"; decision: ReviewDecision; outcome: { ok: true } | { ok: false; message: string } };

const DECISION_VERB: Record<ReviewDecision, string> = { accept: "Accept", decline: "Decline" };
const DECISION_ING: Record<ReviewDecision, string> = { accept: "Accepting", decline: "Declining" };
const DECISION_DONE: Record<ReviewDecision, string> = { accept: "Accepted", decline: "Declined" };
const DECISION_COMMAND: Record<ReviewDecision, string> = {
  accept: "running `keryx workspace confirm-review` then `keryx workspace review`",
  decline: "running `keryx workspace review --decision rejected`",
};

export function formatReviewDetailLines(item: CatchUpItem | undefined, status: ReviewDetailStatus): string[] {
  if (item === undefined) {
    return ["No item selected.", "", "Press Enter (or click a row) on the Review tab to view one."];
  }
  const lines = describeReviewItem(item);
  if (item.type !== "proposal") {
    if (status.kind === "unavailable") {
      return [...lines, "", `[${status.decision === "accept" ? "a" : "d"}] does nothing here — accept/decline only apply to a pending proposal, not to this item.`];
    }
    return lines;
  }
  const withAction = [...lines, ""];
  if (status.kind === "armed") {
    withAction.push(`Press [y] to CONFIRM ${status.decision}, any other key cancels.`);
  } else if (status.kind === "running") {
    withAction.push(`${DECISION_ING[status.decision]}… ${DECISION_COMMAND[status.decision]}.`);
  } else if (status.kind === "done" && status.outcome.ok) {
    withAction.push(`✓ ${DECISION_DONE[status.decision]}.`);
  } else if (status.kind === "done" && !status.outcome.ok) {
    withAction.push(`✗ ${DECISION_VERB[status.decision]} failed: ${status.outcome.message}`);
  } else if (status.kind === "unavailable") {
    withAction.push(`[${status.decision === "accept" ? "a" : "d"}] does nothing — no ${status.decision} handler is configured for this modal.`);
  } else {
    withAction.push("[a] Accept this proposal   [d] Decline this proposal");
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

/** Minimal structural view of the OpenTUI renderables the buttons paint:
 * a BoxRenderable with `add` + `backgroundColor`, a TextRenderable with
 * `content` + `fg`. Kept structural so unit tests can fake them. */
type BoxLike = { add: (child: unknown) => void; backgroundColor: string | undefined };
type TextLike = { content: string; fg: string | undefined };

type ActionButtonCallbacks = {
  onAccept: () => void;
  onDecline: () => void;
};

function paintActionButtons(
  otui: unknown,
  renderer: unknown,
  body: unknown,
  callbacks: ActionButtonCallbacks,
): { accept: ButtonRef; decline: ButtonRef } | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return undefined;
  }
  const parent = body as { add?: (child: unknown) => void };
  const boxCtor = (otui as {
    BoxRenderable?: new (r: unknown, opts: Record<string, unknown>) => BoxLike;
  }).BoxRenderable;
  const textCtor = (otui as {
    TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => TextLike;
  }).TextRenderable;
  if (parent.add === undefined || boxCtor === undefined || textCtor === undefined) {
    return undefined;
  }
  // Local aliases so TS's narrowing survives the `make` closure below
  // (`boxCtor`/`textCtor` are narrowed at this point, but the capture
  // inside `make` re-widens them; exactOptionalPropertyTypes also wants
  // plain `string | undefined` members, not optional ones).
  const BoxCtor = boxCtor;
  const TextCtor = textCtor;
  // `parent.add` is the real Box.add — must be called as a METHOD (its
  // implementation reads `this._ctx`), so no detached alias here; optional
  // call keeps TS happy without re-widening.
  const addChild = (child: unknown): void => parent.add?.(child);
  const theme = getTheme();
  const make = (label: string, id: string, color: string, onClick: () => void): ButtonRef => {
    const box = new BoxCtor(renderer, {
      id,
      flexShrink: 0,
      marginLeft: 1,
      paddingLeft: 1,
      paddingRight: 1,
      onMouseDown: (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        onClick();
      },
    });
    const text = new TextCtor(renderer, { id: `${id}-t`, content: `[${label}]` });
    text.fg = color;
    box.add(text);
    addChild(box);
    const setActive = (active: boolean): void => {
      box.backgroundColor = active ? theme.highlight : undefined;
      text.content = `[${label}]`;
      text.fg = color;
    };
    return { setActive };
  };
  return {
    accept: make("Accept", "review-accept", theme.ok, callbacks.onAccept),
    decline: make("Decline", "review-decline", theme.error, callbacks.onDecline),
  };
}

/** Highlight handle for one rendered Accept/Decline button: `setActive`
 * repaints the focused state, mirroring the queue's button refs. */
export type ButtonRef = { setActive: (active: boolean) => void };
export type AcceptProposalOutcome = { ok: true } | { ok: false; message: string };
export type AcceptProposalFn = (item: CatchUpProposalItem) => Promise<AcceptProposalOutcome>;
/** Same shape as {@link AcceptProposalFn} — a separate alias only so call
 * sites read as what they wire, not as "reusing the accept type for decline". */
export type DeclineProposalFn = (item: CatchUpProposalItem) => Promise<AcceptProposalOutcome>;

export type PresentReviewOptions = {
  items: readonly CatchUpItem[];
  /** Omitted entirely (rather than a no-op) when the caller has no way to run
   * the accept commands — `[a]` then sets `status: "unavailable"` instead of
   * arming, and the Detail pane says so, rather than doing nothing silently. */
  acceptProposal?: AcceptProposalFn;
  /** Same as {@link acceptProposal}, for `[d]` (`--decision rejected`). */
  declineProposal?: DeclineProposalFn;
  /** Fires once, after a successful accept OR decline — the caller's cue to
   * refresh the sidebar badge count; this modal's own list is already
   * updated locally either way. */
  onResolved?: (item: CatchUpProposalItem) => void;
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
  /** Which button the arrows/`a`/`d` currently highlight on a proposal's
   * Detail tab; the default is Accept. */
  let focusedAction: ReviewDecision = "accept";
  let listNode: { content: string } | undefined;
  let detailNode: { content: string } | undefined;
  let actionButtons: { accept: ButtonRef; decline: ButtonRef } | undefined;
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
    updateButtons();
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

  const handlerFor = (decision: ReviewDecision): AcceptProposalFn | DeclineProposalFn | undefined =>
    decision === "accept" ? options.acceptProposal : options.declineProposal;

  /** Repaint the Accept/Decline button highlights to match `focusedAction`
   * (idle) or the armed/running decision. No-op when buttons aren't mounted
   * (non-proposal item, or this tab isn't rendered yet). */
  const updateButtons = (): void => {
    if (actionButtons === undefined) {
      return;
    }
    const onProposal = items[selected]?.type === "proposal" && status.kind !== "done";
    const highlighted = status.kind === "armed" ? status.decision : focusedAction;
    actionButtons.accept.setActive(onProposal && highlighted === "accept");
    actionButtons.decline.setActive(onProposal && highlighted === "decline");
  };

  /** Arm the given decision (or mark it unavailable when the item isn't a
   * proposal or no handler is wired) — shared by the `a`/`d` keys and by
   * clicking a button. */
  const armDecision = (decision: ReviewDecision): void => {
    if (status.kind === "running") {
      return;
    }
    status =
      items[selected]?.type === "proposal" && handlerFor(decision) !== undefined
        ? { kind: "armed", decision }
        : { kind: "unavailable", decision };
    paintSelection();
  };

  const runDecision = (decision: ReviewDecision): void => {
    const item = items[selected];
    const run = handlerFor(decision);
    if (item === undefined || item.type !== "proposal" || run === undefined) {
      return;
    }
    status = { kind: "running", decision };
    paintSelection();
    void run(item).then((outcome) => {
      status = { kind: "done", decision, outcome };
      // Deliberately NOT spliced out of `items` here: the Detail tab needs to
      // keep showing this item so the "✓ Accepted."/"✓ Declined." confirmation
      // is actually visible. The real catch-up report will simply no longer
      // include it the next time `/review` opens (a fresh `buildCatchUp` call)
      // — this modal instance's own list is a point-in-time snapshot, not a
      // live view.
      if (outcome.ok) {
        options.onResolved?.(item);
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
    onArrowKeys: (key, direction) => {
      // Claim the arrow on a proposal's Detail tab so it moves the button
      // highlight instead of switching tabs; everywhere else modal-host's
      // tab switch wins.
      if (
        items[selected]?.type === "proposal" &&
        status.kind !== "running" &&
        status.kind !== "done" &&
        handle?.activeTab() === "detail"
      ) {
        focusedAction = direction === "left" ? "accept" : "decline";
        status = { kind: "idle" };
        paintSelection();
        return true;
      }
      return false;
    },
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      tabWidth = ctx?.width;
      if (tabId === "list") {
        // The detail tab's nodes were destroyed by modal-host when this tab
        // mounted; drop the stale references so paintSelection never writes
        // into a destroyed TextBuffer (the list and detail bodies are never
        // mounted at the same time — one `body` is reused).
        detailNode = undefined;
        actionButtons = undefined;
        listScroll = scrollToReveal(selected, listScroll, bodyRows);
        listNode = paintLines(otui, renderer, body, windowLines(listLines(), listScroll, bodyRows));
        return;
      }
      // Same stale-node reset for the list tab's node when Detail mounts.
      listNode = undefined;
      detailScroll = clampScroll(detailScroll, detailLines().length, bodyRows);
      detailNode = paintLines(otui, renderer, body, windowLines(detailLines(), detailScroll, bodyRows), tabWidth);
      if (items[selected]?.type === "proposal") {
        actionButtons = paintActionButtons(otui, renderer, body, {
          onAccept: () => {
            focusedAction = "accept";
            armDecision("accept");
          },
          onDecline: () => {
            focusedAction = "decline";
            armDecision("decline");
          },
        });
        updateButtons();
      } else {
        actionButtons = undefined;
      }
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
      // Armed accept/decline consumes the very next key unconditionally —
      // only an exact `y` or Enter confirms; everything else (including nav
      // keys) cancels back to idle rather than falling through to
      // navigation.
      if (onDetail && status.kind === "armed") {
        if (token === "y" || token === "return" || token === "enter") {
          runDecision(status.decision);
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
        // Enter on a proposal's Detail tab arms the focused button; Enter
        // again (or `y`) confirms it. Enter anywhere else opens the Detail
        // tab (the list's "open item" action).
        if (onDetail && items[selected]?.type === "proposal" && status.kind !== "running" && status.kind !== "done") {
          if (status.kind === "armed") {
            runDecision(status.decision);
          } else {
            armDecision(focusedAction);
          }
          return;
        }
        handle.setTab("detail");
        return;
      }
      // The arrows already moved the highlight via onArrowKeys; the
      // keypress still sees them (modal-host skipped its tab switch), so
      // this is the same no-op update — idempotent.
      if (onDetail && (token === "left" || token === "right") && status.kind !== "running" && status.kind !== "done") {
        focusedAction = token === "left" ? "accept" : "decline";
        status = { kind: "idle" };
        paintSelection();
        return;
      }
      if (onDetail && (token === "a" || token === "d") && status.kind !== "running" && status.kind !== "done") {
        const decision: ReviewDecision = token === "a" ? "accept" : "decline";
        focusedAction = decision;
        armDecision(decision);
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
