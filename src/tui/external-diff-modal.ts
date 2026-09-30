// Flow 370 (AC6): the `/external-diff` modal — claude write runs whose patch waits for a
// human decision. Review is read-only. Apply never lands on a single key: `a` asks for the
// first 12 characters of the patch hash typed back, and only an exact match calls
// `landWriteRun` with the FULL hash; a run with flagged paths also needs `f` first. Discard
// needs `y`. The stores behind `write-land.ts` are the only source of truth.

import {
  discardWriteRun,
  landWriteRun,
  listPendingWriteRuns,
  viewWriteRun,
  type DiscardResult,
  type LandResult,
  type WriteRunView,
} from "../harness/external/write-land";
import type { ExternalWriteRunRecord, WriteRunFile } from "../harness/external/write-run";
import { clampScroll, windowLines, wrapLines } from "./flow-inspector";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const EXTERNAL_DIFF_COMMAND = "/external-diff";
export const EXTERNAL_DIFF_TITLE = "External write review";
/** How many characters of the patch hash the operator has to type back. */
export const HASH_PREFIX_LENGTH = 12;

export function isExternalDiffCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === EXTERNAL_DIFF_COMMAND;
}

export const EXTERNAL_DIFF_FOOTER = [
  { key: "↑/↓", label: "run" },
  { key: "j/k", label: "scroll" },
  { key: "PgUp/PgDn", label: "page" },
  { key: "f", label: "flagged" },
  { key: "a", label: "apply" },
  { key: "d", label: "discard" },
  { key: "esc", label: "close" },
] as const;

/** The four calls the modal makes; tests inject fakes, the shell uses {@link defaultExternalDiffDeps}. */
export interface ExternalDiffDeps {
  list(): readonly ExternalWriteRunRecord[];
  view(runId: string): WriteRunView | undefined;
  land(input: { runId: string; confirmedPatchHash: string; allowFlagged: boolean }): Promise<LandResult>;
  discard(runId: string): DiscardResult;
}

export function defaultExternalDiffDeps(cwd: string): ExternalDiffDeps {
  return {
    list: () => listPendingWriteRuns(cwd),
    view: (runId) => viewWriteRun(cwd, runId),
    land: ({ runId, confirmedPatchHash, allowFlagged }) =>
      landWriteRun({ cwd, runId, confirmedPatchHash, ...(allowFlagged ? { allowFlagged: true } : {}) }),
    discard: (runId) => discardWriteRun({ cwd, runId }),
  };
}

// eslint-disable-next-line no-control-regex -- strips terminal control bytes from agent-controlled text
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Paths and patch lines come from an agent's worktree: never let them drive the terminal. */
function clean(text: string): string {
  return text.replace(/\r/g, "").replace(/\t/g, "  ").replace(CONTROL_CHARACTERS, "?");
}

const shortId = (runId: string): string => clean(runId).slice(0, 8);

const NOTHING_APPLIED = "Nothing was applied to your current branch or working tree.";

export function landResultText(result: LandResult): string {
  if (result.kind === "landed") {
    return `Applied as branch ${clean(result.branch)} at commit ${clean(result.commit)}. ${NOTHING_APPLIED}`;
  }
  return `Not applied (${result.reason}): ${clean(result.detail)} ${NOTHING_APPLIED}`;
}

export function discardResultText(result: DiscardResult, runId: string): string {
  if (result.kind === "discarded") return `Discarded run ${shortId(runId)}. Its stored patch was deleted.`;
  return `Not discarded (${result.reason}): ${clean(result.detail)}`;
}

function errorText(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error));
}

/** Flagged paths first, each marked; flagged paths the file list does not carry are still shown. */
export function orderedFiles(record: ExternalWriteRunRecord): Array<{ file: WriteRunFile | undefined; path: string; flagged: boolean }> {
  const flagged = new Set(record.flaggedPaths);
  const known = new Set(record.files.map((file) => file.path));
  const entries = record.files.map((file) => ({ file: file as WriteRunFile | undefined, path: file.path, flagged: flagged.has(file.path) }));
  for (const path of record.flaggedPaths) {
    if (!known.has(path)) entries.push({ file: undefined, path, flagged: true });
  }
  return [...entries.filter((entry) => entry.flagged), ...entries.filter((entry) => !entry.flagged)];
}

function fileLine(entry: { file: WriteRunFile | undefined; path: string; flagged: boolean }): string {
  const marker = entry.flagged ? "!! FLAGGED  " : "            ";
  const status = entry.file?.status ?? "changed";
  const binary = entry.file?.binary === true ? " (binary, content not shown)" : "";
  return `  ${marker}${status}  ${clean(entry.path)}${binary}`;
}

/** The read-only fallback for the readline REPL; it never lands anything. */
export function externalDiffSlashText(deps: Pick<ExternalDiffDeps, "list">): string {
  const lines: string[] = [];
  try {
    const runs = deps.list();
    if (runs.length === 0) {
      lines.push("No write runs are waiting for review.");
    } else {
      lines.push(`Write runs awaiting review (${runs.length}):`);
      for (const run of runs) {
        lines.push(`  ${clean(run.runId)}  ${clean(run.agentId)}  ${run.files.length} file(s)  ${run.flaggedPaths.length} flagged`);
      }
    }
  } catch (error) {
    lines.push(`Could not read the write runs: ${errorText(error)}`);
  }
  lines.push("Use keryx agents external review <run-id> and keryx agents external apply <run-id> in a terminal.");
  return `${lines.join("\n")}\n`;
}

export interface ExternalDiffKey {
  name: string;
  sequence: string;
}

type Mode = { kind: "browse" } | { kind: "apply"; typed: string } | { kind: "discard" } | { kind: "busy" };

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
  let selectedIndex = 0;
  let scroll = 0;
  let pageRows = 10;
  let mode: Mode = { kind: "browse" };
  let notice: string | undefined;
  let allowFlaggedRun: string | undefined;
  let inflight: Promise<void> | undefined;
  const views = new Map<string, { view?: WriteRunView; error?: string }>();

  const changed = (): void => options.onChange?.();

  function refreshRuns(): void {
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
    selectedIndex = Math.min(Math.max(0, runs.length - 1), Math.max(0, selectedIndex));
    if ((mode.kind === "apply" || mode.kind === "discard") && runs[selectedIndex] === undefined) mode = { kind: "browse" };
  }

  const selectedRun = (): ExternalWriteRunRecord | undefined => runs[selectedIndex];

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
    runs.forEach((run, index) => {
      lines.push(`${index === selectedIndex ? ">" : " "} ${shortId(run.runId)}  ${clean(run.agentId)}  ${run.files.length} file(s)  ${run.flaggedPaths.length} flagged`);
    });
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
    const patchLines = clean(patch).split("\n");
    if (patchLines[patchLines.length - 1] === "") patchLines.pop();
    lines.push(`Patch (redacted, ${patchLines.length} line(s)):`, ...patchLines);
    return lines;
  }

  function statusLine(): string {
    const run = selectedRun();
    if (mode.kind === "apply" && run !== undefined) {
      const prefix = (hashOf(run) ?? "").slice(0, HASH_PREFIX_LENGTH);
      const flagged = flaggedAllowed(run) ? " Flagged paths: ALLOWED." : "";
      return `Apply run ${shortId(run.runId)}? Type the first ${HASH_PREFIX_LENGTH} characters of the patch hash (${prefix}) and press Enter; anything else cancels.${flagged} > ${clean(mode.typed)}`;
    }
    if (mode.kind === "discard" && run !== undefined) {
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
    mode = { kind: "apply", typed: "" };
  }

  function submitApply(typed: string): void {
    const run = selectedRun();
    const hash = run === undefined ? undefined : hashOf(run);
    mode = { kind: "browse" };
    if (run === undefined || hash === undefined || typed !== hash.slice(0, HASH_PREFIX_LENGTH)) {
      notice = `Apply cancelled: what you typed is not the first ${HASH_PREFIX_LENGTH} characters of the patch hash. ${NOTHING_APPLIED}`;
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

  function discardSelected(): void {
    const run = selectedRun();
    mode = { kind: "browse" };
    if (run === undefined) {
      notice = "Nothing to discard.";
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

  function applyKey(key: ExternalDiffKey, typed: string): void {
    if (key.name === "return" || key.name === "enter") {
      submitApply(typed);
    } else if (key.name === "backspace") {
      mode = { kind: "apply", typed: typed.slice(0, -1) };
    } else if (key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\u007f") {
      mode = { kind: "apply", typed: `${typed}${key.sequence}`.slice(0, 64) };
    } else {
      mode = { kind: "browse" };
      notice = `Apply cancelled. ${NOTHING_APPLIED}`;
    }
  }

  function handleKey(key: ExternalDiffKey): void {
    if (mode.kind === "busy") return;
    const token = key.name || key.sequence;
    if (mode.kind === "apply") {
      applyKey(key, mode.typed);
    } else if (mode.kind === "discard") {
      if (token === "y") {
        discardSelected();
      } else {
        mode = { kind: "browse" };
        notice = "Discard cancelled.";
      }
    } else if (token === "up" || token === "down") {
      const next = Math.min(Math.max(0, runs.length - 1), Math.max(0, selectedIndex + (token === "down" ? 1 : -1)));
      if (next !== selectedIndex) scroll = 0;
      selectedIndex = next;
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
        notice = `Flagged paths allowed for this apply. You still have to type the first ${HASH_PREFIX_LENGTH} characters of the patch hash.`;
      }
    } else if (token === "a") {
      startApply();
    } else if (token === "d") {
      if (selectedRun() === undefined) {
        notice = "Nothing to discard.";
      } else {
        notice = undefined;
        mode = { kind: "discard" };
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
