// Flow 369 (R4d): the Approvals composition the shell mounts after Schedules.
//
//   - sidebar section `sb-approvals`: ONE row, `N pending · /approvals`, present only
//     while something is pending. Zero rows otherwise, so it can never push the
//     Model / Context / Tools / Status / Ready labels off a 24-row terminal;
//   - `/approvals`: the list modal (`./approvals-inspector.ts`); a click on the row too;
//   - a poll of the approval store (it lives in the config dir, so the project
//     watcher never sees it): the row, an open modal and a one-line transcript
//     notice for each approval that arrives while the shell is open. Approvals
//     already pending when the shell started are the baseline and not announced.

import { findAgentCommand } from "../commands/agent-commands";
import { splitApprovals } from "../lib/serve-approvals-format";
import { listApprovals, type ApprovalView } from "../lib/serve-approvals-store";
import { classifyBusyDispatch } from "./busy-dispatch";
import { APPROVALS_COMMAND, isApprovalsCommand, openApprovals, type ApprovalsModalHandle, type ApprovalsModalOptions } from "./approvals-inspector";
import type { ModalChrome } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";

// eslint-disable-next-line no-control-regex -- strips terminal control bytes from a summary shown in the transcript
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

type OpenTui = typeof import("@opentui/core");

export { APPROVALS_COMMAND };

export const APPROVALS_POLL_MS = 3000;

export interface ApprovalsPanelProjection {
  readonly visible: boolean;
  readonly text: string;
}

/** One row, always: the count is what a person has to see, the command is the way in. */
export function projectApprovalsPanel(pending: number, width: number): ApprovalsPanelProjection {
  if (pending <= 0) {
    return { visible: false, text: "" };
  }
  const candidates = [`${pending} pending · /approvals`, `${pending} pending`];
  const text = candidates.find((candidate) => candidate.length <= width) ?? `${pending} pending`.slice(0, Math.max(1, width));
  return { visible: true, text };
}

export interface ApprovalsSidebarOptions {
  otui: unknown;
  chrome: ModalChrome & { showToast(message: string): void };
  parent: unknown;
  width: number;
  onKeypress: ApprovalsModalOptions["onKeypress"];
  /** One transcript line (the shell's `io.onSystem`). */
  notice?: (text: string) => void;
  load?: () => readonly ApprovalView[];
  answer?: ApprovalsModalOptions["answer"];
  now?: () => Date;
  inputBlocked?: () => boolean;
  /** The poll; injectable so a test fires the tick itself. */
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
}

export interface ApprovalsSidebar {
  projection(): ApprovalsPanelProjection;
  paintCount(): number;
  show(): ApprovalsModalHandle | undefined;
  /** Routes `/approvals`; false for any other line. */
  handleCommand(line: string): boolean;
  openModal(): ApprovalsModalHandle | undefined;
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * The shell's routing of `/approvals`, called from BOTH of `runLine`'s branches:
 * idle resolves through the agent-mode registry; busy must classify as `approvals`
 * (read-only, never deferred: a turn waiting on an approval is what the operator
 * is here to unblock). Returns whether the line was handled.
 */
export function routeApprovalsCommand(line: string, busy: boolean, approvals: Pick<ApprovalsSidebar, "handleCommand">): boolean {
  const command = findAgentCommand(line, "agent");
  if (command === undefined || command.name !== APPROVALS_COMMAND) return false;
  if (busy) {
    const target = classifyBusyDispatch({
      line,
      commandName: command.name,
      isSessionInfo: false,
      isFlows: false,
      isWorkspace: false,
      isReview: false,
      isMcp: false,
      isMcpConsumer: false,
    });
    if (target !== "approvals") return false;
  }
  return approvals.handleCommand(line);
}

function defaultInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function mountApprovalsSidebar(options: ApprovalsSidebarOptions): ApprovalsSidebar {
  const core = options.otui as OpenTui;
  const { chrome } = options;
  const r = chrome.renderer as never;
  const now = options.now ?? (() => new Date());
  const load = options.load ?? ((): readonly ApprovalView[] => listApprovals(undefined, { now: now() }));
  const notice = options.notice ?? (() => {});
  const inputBlocked =
    options.inputBlocked ?? ((): boolean => (chrome as { keyboardOwnedElsewhere?: () => boolean }).keyboardOwnedElsewhere?.() === true);

  const box = new core.BoxRenderable(r, { id: "sb-approvals", flexDirection: "column", flexShrink: 0 });
  (options.parent as { add(child: unknown): void }).add(box);
  let modal: ApprovalsModalHandle | undefined;
  let projected: ApprovalsPanelProjection = { visible: false, text: "" };
  let paintedKey: string | undefined;
  let paints = 0;
  let disposed = false;
  let known: Set<string> | undefined;

  const paint = (force = false): void => {
    if (disposed) return;
    const key = JSON.stringify(projected);
    if (!force && key === paintedKey) return;
    paintedKey = key;
    paints += 1;
    clearTranscriptChildren(box);
    if (!projected.visible) return;
    const [count, ...hint] = projected.text.split(" · ");
    const chunks = [roleChunk(core, "attention", count ?? projected.text), ...(hint.length > 0 ? [dimChunk(core, ` · ${hint.join(" · ")}`)] : [])];
    box.add(
      new core.TextRenderable(r, {
        id: "sb-approvals-row",
        content: new core.StyledText(chunks),
        onMouseDown: () => {
          show();
        },
      }),
    );
  };

  const show = (): ApprovalsModalHandle | undefined => {
    modal?.close({ restoreFocus: false });
    modal = openApprovals(core, chrome, {
      load,
      now,
      onKeypress: options.onKeypress,
      inputBlocked,
      onAnswered: () => {
        void refresh();
      },
      ...(options.answer !== undefined ? { answer: options.answer } : {}),
    });
    return modal;
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    let views: readonly ApprovalView[];
    try {
      views = load();
    } catch {
      views = [];
    }
    const { pending } = splitApprovals(views, now());
    projected = projectApprovalsPanel(pending.length, options.width);
    paint();
    if (known === undefined) {
      known = new Set(pending.map((view) => view.approvalId));
    } else {
      for (const view of pending) {
        if (known.has(view.approvalId)) continue;
        known.add(view.approvalId);
        notice(`Remote approval pending: ${view.summary.replace(CONTROL_CHARACTERS, " ")} - ${APPROVALS_COMMAND} to answer\n`);
      }
    }
    modal?.reload();
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("approvals-row", () => paint(true), () => disposed || isRenderableGone(box)));
  void refresh();
  const stopPoll = (options.interval ?? defaultInterval)(refresh, options.pollMs ?? APPROVALS_POLL_MS);

  return {
    projection: () => projected,
    paintCount: () => paints,
    show,
    handleCommand(line) {
      if (!isApprovalsCommand(line)) return false;
      show();
      return true;
    },
    openModal: () => modal,
    refresh,
    dispose() {
      disposed = true;
      stopPoll();
      unsubscribeTheme();
      modal?.close({ restoreFocus: false });
    },
  };
}
