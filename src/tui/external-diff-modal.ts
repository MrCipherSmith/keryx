// Flow 370 (AC6): the `/external-diff` modal — claude and codex write runs whose patch waits for a
// human decision. Review is read-only. Apply never lands on a single key: `a` asks for the
// first 12 hex digits of the patch hash typed back, and only an exact match calls
// `landWriteRun` with the FULL hash; a run with flagged paths also needs `f` first. Discard
// needs `y`. The stores behind `write-land.ts` are the only source of truth.

import type { WriteRunView } from "../harness/external/write-land";
import type { ExternalWriteRunRecord } from "../harness/external/write-run";
import { NOTHING_APPLIED, clean, shortId, errorText, fileLine } from "./external-diff-text";
import type { ExternalDiffDeps } from "./external-diff-text";
import { clampScroll, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";
export { EXTERNAL_DIFF_COMMAND, EXTERNAL_DIFF_TITLE, HASH_PREFIX_LENGTH, isExternalDiffCommand, defaultExternalDiffDeps, landResultText, discardResultText, orderedFiles, externalDiffSlashText } from "./external-diff-text";
export type { ExternalDiffDeps } from "./external-diff-text";
import { EXTERNAL_DIFF_TITLE, HASH_PREFIX_LENGTH, landResultText, discardResultText, orderedFiles } from "./external-diff-text";

type OpenTui = typeof import("@opentui/core");

export const EXTERNAL_DIFF_FOOTER = [
  { key: "↑/↓", label: "run" },
  { key: "j/k", label: "scroll" },
  { key: "PgUp/PgDn", label: "page" },
  { key: "f", label: "flagged" },
  { key: "a", label: "apply" },
  { key: "d", label: "discard" },
  { key: "esc", label: "close" },
] as const;


export interface ExternalDiffKey {
  name: string;
  sequence: string;
}

/** An armed prompt carries the run it was armed for, so a refresh that moves the list cannot redirect it. */
type Mode = { kind: "browse" } | { kind: "apply"; typed: string; runId: string } | { kind: "discard"; runId: string } | { kind: "busy" };

export interface ExternalDiffControllerOptions {
  deps: ExternalDiffDeps;
  /** Something visible changed; repaint. */
  onChange?: () => void;
  /** A run was landed or discarded (or refused), so a sidebar count should re-read. */
  onActed?: () => void;
}

export interface ExternalDiffController {
  handleKey(key: ExternalDiffKey): void;
  reload(): void;
  render(width: number | undefined, rows: number): string[];
  selected(): ExternalWriteRunRecord | undefined;
  /** Resolves once an apply that is in flight has finished. */
  idle(): Promise<void>;
}

export function createExternalDiffController(options: ExternalDiffControllerOptions): ExternalDiffController {
  const { deps } = options;
  let runs: readonly ExternalWriteRunRecord[] = [];
  let selectedRunId: string | undefined;
  let scroll = 0;
  let pageRows = 10;
  let mode: Mode = { kind: "browse" };
  let notice: string | undefined;
  let allowFlaggedRun: string | undefined;
  let inflight: Promise<void> | undefined;
  const views = new Map<string, { view?: WriteRunView; error?: string }>();

  const changed = (): void => options.onChange?.();

  function refreshRuns(): void {
    const previousIndex = selectedIndex();
    try {
      runs = deps.list();
    } catch (error) {
      runs = [];
      notice = `Could not read the write runs: ${errorText(error)}`;
    }
    const ids = new Set(runs.map((run) => run.runId));
    for (const id of [...views.keys()]) {
      if (!ids.has(id)) views.delete(id);
    }
    if (selectedRunId === undefined || !ids.has(selectedRunId)) {
      const fallback = runs[Math.min(Math.max(0, previousIndex), runs.length - 1)];
      selectedRunId = fallback?.runId;
      scroll = 0;
    }
    if ((mode.kind === "apply" || mode.kind === "discard") && mode.runId !== selectedRunId) {
      mode = { kind: "browse" };
      notice = `Prompt cancelled: the run it was for is no longer selected. ${NOTHING_APPLIED}`;
    }
    if (allowFlaggedRun !== undefined && !ids.has(allowFlaggedRun)) allowFlaggedRun = undefined;
  }

  const selectedIndex = (): number => (selectedRunId === undefined ? -1 : runs.findIndex((run) => run.runId === selectedRunId));
  const selectedRun = (): ExternalWriteRunRecord | undefined => runs[selectedIndex()];

  function viewOf(run: ExternalWriteRunRecord): { view?: WriteRunView; error?: string } {
    const cached = views.get(run.runId);
    if (cached !== undefined) return cached;
    let entry: { view?: WriteRunView; error?: string };
    try {
      const view = deps.view(run.runId);
      entry = view === undefined ? {} : { view };
    } catch (error) {
      entry = { error: errorText(error) };
    }
    views.set(run.runId, entry);
    return entry;
  }

  const hashOf = (run: ExternalWriteRunRecord): string | undefined => viewOf(run).view?.record.patchHash ?? run.patchHash;
  const patchOf = (run: ExternalWriteRunRecord): string | undefined => viewOf(run).view?.patch;
  const flaggedAllowed = (run: ExternalWriteRunRecord): boolean => allowFlaggedRun === run.runId;

  function bodyLines(): string[] {
    if (runs.length === 0) return ["No write runs are waiting for review."];
    const lines = [`Write runs awaiting review (${runs.length}):`];
    for (const run of runs) {
      lines.push(`${run.runId === selectedRunId ? ">" : " "} ${shortId(run.runId)}  ${clean(run.agentId)}  ${run.files.length} file(s)  ${run.flaggedPaths.length} flagged`);
    }
    const run = selectedRun();
    if (run === undefined) return lines;
    const entry = viewOf(run);
    const record = entry.view?.record ?? run;
    const hash = record.patchHash;
    lines.push(
      "",
      `Run: ${clean(record.runId)}`,
      `Agent: ${clean(record.agentId)}`,
      `Base commit: ${clean(record.baseCommit)}`,
      `Run status: ${record.runStatus}`,
      `Patch hash: ${hash === undefined ? "(none stored)" : clean(hash)}`,
    );
    if (record.flaggedPaths.length > 0) {
      lines.push(
        "",
        `${record.flaggedPaths.length} flagged path(s) (repo plumbing, CI, hooks or agent config), listed first. Apply is blocked until you press f: flagged paths are ${flaggedAllowed(run) ? "ALLOWED" : "not allowed"}.`,
      );
    }
    lines.push("", `Files (${record.files.length}):`);
    for (const file of orderedFiles(record)) lines.push(fileLine(file));
    if (record.redacted) lines.push("", "The patch text was redacted, so it may not apply exactly as the agent wrote it.");
    lines.push("");
    if (entry.error !== undefined) {
      lines.push(`Could not read this run: ${entry.error}`, "It cannot be reviewed, so only discard (d) is offered.");
      return lines;
    }
    const patch = entry.view?.patch;
    if (patch === undefined) {
      lines.push("This run cannot be reviewed: no verified patch is stored for it. Only discard (d) is offered.");
      return lines;
    }
    const patchLines = patch.split("\n").map(clean);
    if (patchLines[patchLines.length - 1] === "") patchLines.pop();
    lines.push(`Patch (redacted, ${patchLines.length} line(s)):`, ...patchLines);
    return lines;
  }

  function statusLine(): string {
    const run = selectedRun();
    if (mode.kind === "apply" && run !== undefined && mode.runId === run.runId) {
      const prefix = (hashOf(run) ?? "").slice(0, HASH_PREFIX_LENGTH);
      const flagged = flaggedAllowed(run) ? " Flagged paths: ALLOWED." : "";
      return `Apply run ${shortId(run.runId)}? Type the first ${HASH_PREFIX_LENGTH} hex digits of the patch hash, without any sha256: prefix (${prefix}), and press Enter; anything else cancels.${flagged} > ${clean(mode.typed)}`;
    }
    if (mode.kind === "discard" && run !== undefined && mode.runId === run.runId) {
      return `Discard run ${shortId(run.runId)}? Its stored patch is deleted for good. Press y to confirm; any other key cancels.`;
    }
    return notice ?? "";
  }

  function startApply(): void {
    const run = selectedRun();
    if (run === undefined) {
      notice = "Nothing to apply.";
      return;
    }
    const hash = hashOf(run);
    if (patchOf(run) === undefined || hash === undefined || hash.length < HASH_PREFIX_LENGTH) {
      notice = "This run cannot be reviewed, so it cannot be applied: no verified patch is stored. Press d to discard it.";
      return;
    }
    if (run.flaggedPaths.length > 0 && !flaggedAllowed(run)) {
      notice = "This run changes flagged paths. Press f to allow applying them, then press a again.";
      return;
    }
    notice = undefined;
    mode = { kind: "apply", typed: "", runId: run.runId };
  }

  function submitApply(typed: string, armedRunId: string): void {
    const run = selectedRun();
    const hash = run === undefined ? undefined : hashOf(run);
    mode = { kind: "browse" };
    if (run === undefined || run.runId !== armedRunId) {
      notice = `Apply cancelled: the run it was armed for is no longer selected. ${NOTHING_APPLIED}`;
      return;
    }
    if (hash === undefined || typed !== hash.slice(0, HASH_PREFIX_LENGTH)) {
      notice = `Apply cancelled: what you typed is not the first ${HASH_PREFIX_LENGTH} hex digits of the patch hash. ${NOTHING_APPLIED}`;
      return;
    }
    const runId = run.runId;
    const allowFlagged = flaggedAllowed(run);
    mode = { kind: "busy" };
    notice = `Applying run ${shortId(runId)}...`;
    inflight = (async (): Promise<void> => {
      let text: string;
      try {
        text = landResultText(await deps.land({ runId, confirmedPatchHash: hash, allowFlagged }));
      } catch (error) {
        text = `Apply failed: ${errorText(error)}. ${NOTHING_APPLIED}`;
      }
      allowFlaggedRun = undefined;
      views.clear();
      mode = { kind: "browse" };
      refreshRuns();
      notice = text;
      options.onActed?.();
      changed();
    })();
  }

  function discardSelected(armedRunId: string): void {
    const run = selectedRun();
    mode = { kind: "browse" };
    if (run === undefined || run.runId !== armedRunId) {
      notice = "Discard cancelled: the run it was armed for is no longer selected.";
      return;
    }
    try {
      notice = discardResultText(deps.discard(run.runId), run.runId);
    } catch (error) {
      notice = `Discard failed: ${errorText(error)}`;
    }
    allowFlaggedRun = undefined;
    views.clear();
    refreshRuns();
    options.onActed?.();
  }

  function applyKey(key: ExternalDiffKey, typed: string, runId: string): void {
    if (key.name === "return" || key.name === "enter") {
      submitApply(typed, runId);
    } else if (key.name === "backspace") {
      mode = { kind: "apply", typed: typed.slice(0, -1), runId };
    } else if (key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\u007f") {
      mode = { kind: "apply", typed: `${typed}${key.sequence}`.slice(0, 64), runId };
    } else {
      mode = { kind: "browse" };
      notice = `Apply cancelled. ${NOTHING_APPLIED}`;
    }
  }

  function handleKey(key: ExternalDiffKey): void {
    if (mode.kind === "busy") return;
    const token = key.name || key.sequence;
    if (mode.kind === "apply") {
      applyKey(key, mode.typed, mode.runId);
    } else if (mode.kind === "discard") {
      if (token === "y") {
        discardSelected(mode.runId);
      } else {
        mode = { kind: "browse" };
        notice = "Discard cancelled.";
      }
    } else if (token === "up" || token === "down") {
      const current = Math.max(0, selectedIndex());
      const next = Math.min(Math.max(0, runs.length - 1), Math.max(0, current + (token === "down" ? 1 : -1)));
      if (next !== current) scroll = 0;
      selectedRunId = runs[next]?.runId;
      notice = undefined;
    } else if (token === "j" || token === "k") {
      scroll = Math.max(0, scroll + (token === "j" ? 1 : -1));
    } else if (token === "pagedown" || token === "pageup") {
      const step = Math.max(1, pageRows - 1);
      scroll = Math.max(0, scroll + (token === "pagedown" ? step : -step));
    } else if (token === "f") {
      const run = selectedRun();
      if (run === undefined || run.flaggedPaths.length === 0) {
        notice = "This run has no flagged paths.";
      } else if (flaggedAllowed(run)) {
        allowFlaggedRun = undefined;
        notice = "Flagged paths are blocked again.";
      } else {
        allowFlaggedRun = run.runId;
        notice = `Flagged paths allowed for this apply. You still have to type the first ${HASH_PREFIX_LENGTH} hex digits of the patch hash.`;
      }
    } else if (token === "a") {
      startApply();
    } else if (token === "d") {
      const armed = selectedRun();
      if (armed === undefined) {
        notice = "Nothing to discard.";
      } else {
        notice = undefined;
        mode = { kind: "discard", runId: armed.runId };
      }
    } else {
      return;
    }
    changed();
  }

  refreshRuns();

  return {
    handleKey,
    reload: () => {
      refreshRuns();
      changed();
    },
    render: (width, rows) => {
      pageRows = Math.max(1, rows);
      const status = wrapLines(statusLine(), width).split("\n");
      const body = wrapLines(bodyLines().join("\n"), width).split("\n");
      const room = Math.max(1, rows - status.length);
      scroll = clampScroll(scroll, body.length, room);
      return [...status, ...windowLines(body, scroll, room)];
    },
    selected: selectedRun,
    idle: () => inflight ?? Promise.resolve(),
  };
}

export interface ExternalDiffModalOptions {
  deps: ExternalDiffDeps;
  /** Runs after a run was landed, discarded or refused, so the sidebar count follows. */
  onActed?: () => void;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  inputBlocked?: () => boolean;
}

export interface ExternalDiffModalHandle extends ModalHandle {
  visibleLines(): readonly string[];
  selected(): ExternalWriteRunRecord | undefined;
  /** Re-reads the runs and repaints; the sidebar poll calls this while the modal is open. */
  reload(): void;
  idle(): Promise<void>;
}

export function openExternalDiff(otui: unknown, chrome: unknown, options: ExternalDiffModalOptions): ExternalDiffModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let width: number | undefined;
  let bodyNode: { content: unknown } | undefined;
  let closed = false;
  const keys: { off?: () => void } = {};

  const paint = (): void => {
    if (closed || bodyNode === undefined) return;
    bodyNode.content = core.t`${dimChunk(core, controller.render(width, bodyRows).join("\n"))}`;
  };
  const controller = createExternalDiffController({
    deps: options.deps,
    onChange: paint,
    ...(options.onActed !== undefined ? { onActed: options.onActed } : {}),
  });

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: EXTERNAL_DIFF_TITLE,
    tabs: [{ id: "runs", label: "Runs" }],
    footer: EXTERNAL_DIFF_FOOTER,
    renderTab: (_tabId, body, ctx) => {
      width = ctx.width;
      const parent = body as { add(child: unknown): void };
      bodyNode = new core.TextRenderable(r as never, { id: "external-diff-body", content: "" }) as never;
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
      "external-diff-modal",
      paint,
      () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  keys.off = options.onKeypress((key) => {
    if (closed || options.inputBlocked?.() === true) return;
    controller.handleKey(key);
  });

  return {
    ...modal,
    visibleLines: () => controller.render(width, bodyRows),
    selected: controller.selected,
    reload: controller.reload,
    idle: controller.idle,
  };
}
