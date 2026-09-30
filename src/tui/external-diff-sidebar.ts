// Flow 370 (AC6): the sidebar row and the `/external-diff` composition the shell mounts
// after Approvals. ONE row, present only while a write run awaits review, so it can never
// push the Model / Context / Tools / Status / Ready labels off a 24-row terminal. The
// contract functions throw until a checkout has anything to read: a throw hides the row.

import { findAgentCommand } from "../commands/agent-commands";
import type { ExternalWriteRunRecord } from "../harness/external/write-run";
import {
  defaultExternalDiffDeps,
  EXTERNAL_DIFF_COMMAND,
  isExternalDiffCommand,
  openExternalDiff,
  type ExternalDiffDeps,
  type ExternalDiffModalHandle,
  type ExternalDiffModalOptions,
} from "./external-diff-modal";
import type { ModalChrome } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";

type OpenTui = typeof import("@opentui/core");

export { EXTERNAL_DIFF_COMMAND };

export const EXTERNAL_DIFF_POLL_MS = 5000;

export interface ExternalDiffPanelProjection {
  readonly visible: boolean;
  readonly text: string;
}

/** One row, always: the count is what a person has to see, the command is the way in when it fits. */
export function projectExternalDiffPanel(pending: number, width: number): ExternalDiffPanelProjection {
  if (pending <= 0) {
    return { visible: false, text: "" };
  }
  const base = `External diffs: ${pending} pending`;
  const candidates = [`${base} · ${EXTERNAL_DIFF_COMMAND}`, base];
  const text = candidates.find((candidate) => candidate.length <= width) ?? base.slice(0, Math.max(1, width));
  return { visible: true, text };
}

export interface ExternalDiffSidebarOptions {
  otui: unknown;
  chrome: ModalChrome & { showToast(message: string): void };
  parent: unknown;
  width: number;
  cwd: string;
  onKeypress: ExternalDiffModalOptions["onKeypress"];
  deps?: ExternalDiffDeps;
  inputBlocked?: () => boolean;
  /** The poll; injectable so a test fires the tick itself. */
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
}

export interface ExternalDiffSidebar {
  projection(): ExternalDiffPanelProjection;
  paintCount(): number;
  show(): ExternalDiffModalHandle | undefined;
  /** Routes `/external-diff`; false for any other line. */
  handleCommand(line: string): boolean;
  openModal(): ExternalDiffModalHandle | undefined;
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * The shell's routing of `/external-diff`, called from BOTH of `runLine`'s branches. Landing
 * cuts a new local branch in a throwaway worktree and never touches the running turn's
 * checkout, so busy routes to the same handler as idle.
 */
export function routeExternalDiffCommand(line: string, external: Pick<ExternalDiffSidebar, "handleCommand">): boolean {
  const command = findAgentCommand(line, "agent");
  if (command === undefined || command.name !== EXTERNAL_DIFF_COMMAND) return false;
  return external.handleCommand(line);
}

function defaultInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function mountExternalDiffSidebar(options: ExternalDiffSidebarOptions): ExternalDiffSidebar {
  const core = options.otui as OpenTui;
  const { chrome } = options;
  const r = chrome.renderer as never;
  const deps = options.deps ?? defaultExternalDiffDeps(options.cwd);
  const inputBlocked =
    options.inputBlocked ?? ((): boolean => (chrome as { keyboardOwnedElsewhere?: () => boolean }).keyboardOwnedElsewhere?.() === true);

  const box = new core.BoxRenderable(r, { id: "sb-external-diff", flexDirection: "column", flexShrink: 0 });
  (options.parent as { add(child: unknown): void }).add(box);
  let modal: ExternalDiffModalHandle | undefined;
  let projected: ExternalDiffPanelProjection = { visible: false, text: "" };
  let paintedKey: string | undefined;
  let paints = 0;
  let disposed = false;

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
        id: "sb-external-diff-row",
        content: new core.StyledText(chunks),
        onMouseDown: () => {
          show();
        },
      }),
    );
  };

  const show = (): ExternalDiffModalHandle | undefined => {
    modal?.close({ restoreFocus: false });
    modal = openExternalDiff(core, chrome, {
      deps,
      onKeypress: options.onKeypress,
      inputBlocked,
      onActed: () => {
        void refresh();
      },
    });
    return modal;
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    let runs: readonly ExternalWriteRunRecord[];
    try {
      runs = deps.list();
    } catch {
      runs = [];
    }
    projected = projectExternalDiffPanel(runs.length, options.width);
    paint();
    modal?.reload();
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("external-diff-row", () => paint(true), () => disposed || isRenderableGone(box)));
  void refresh();
  const stopPoll = (options.interval ?? defaultInterval)(refresh, options.pollMs ?? EXTERNAL_DIFF_POLL_MS);

  return {
    projection: () => projected,
    paintCount: () => paints,
    show,
    handleCommand(line) {
      if (!isExternalDiffCommand(line)) return false;
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
