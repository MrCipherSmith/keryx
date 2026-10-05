// Flow 404 (AC9): the sidebar row that shows when the Part 1 materials were last synced. It reads the run line
// of `sync-status.md` through the helpers `keryx research sync` itself writes the page with, so the label is
// never restated here. Read-only, one poll a minute; the row exists only in a checkout that has the catalog.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CATALOG_DIR, STATUS_FILE } from "../commands/research-sync";
import { isFailureStatus, readRunLine } from "../commands/research-sync-status";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { onThemeChange, type TextRole } from "./theme";
import { dimChunk, roleChunk } from "./theme-text";
import { clearTranscriptChildren } from "./transcript-blocks";

type OpenTui = typeof import("@opentui/core");

export const RESEARCH_SYNC_LABEL = "Материалы части 1";
export const RESEARCH_SYNC_POLL_MS = 60_000;
const NEVER = "ещё не запускалась";

export interface ResearchSyncSnapshot {
  /** The catalog directory exists in this checkout. */
  catalog: boolean;
  /** The text of `sync-status.md`, or null when the page is not there. */
  status: string | null;
}

export interface ResearchSyncRow {
  readonly visible: boolean;
  readonly text: string;
  readonly role: TextRole;
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Nothing outside a checkout with the catalog; "ещё не запускалась" until the first run; the run time after. */
export function projectResearchSyncRow(snapshot: ResearchSyncSnapshot, width: number): ResearchSyncRow {
  if (!snapshot.catalog) return { visible: false, text: "", role: "muted" };
  const run = snapshot.status === null ? null : readRunLine(snapshot.status);
  if (snapshot.status === null || run === null || run.length === 0) return { visible: true, text: fit(NEVER, width), role: "muted" };
  if (isFailureStatus(snapshot.status)) return { visible: true, text: fit(`ошибка ${run}`, width), role: "error" };
  return { visible: true, text: fit(run, width), role: "ok" };
}

export async function readResearchSyncSnapshot(root: string): Promise<ResearchSyncSnapshot> {
  const dir = path.join(root, CATALOG_DIR);
  try {
    if (!(await stat(dir)).isDirectory()) return { catalog: false, status: null };
  } catch {
    return { catalog: false, status: null };
  }
  try {
    return { catalog: true, status: await readFile(path.join(dir, STATUS_FILE), "utf8") };
  } catch {
    return { catalog: true, status: null };
  }
}

type PanelParent = { add(child: unknown): void };

export interface ResearchSyncPanelOptions {
  root: string;
  width: number;
  /** Injectable for tests. Default `readResearchSyncSnapshot`. */
  read?: (root: string) => Promise<ResearchSyncSnapshot>;
  /** Injectable for tests: returns the function that stops the poll. */
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
}

export interface ResearchSyncPanelHandle {
  refresh(): Promise<void>;
  row(): ResearchSyncRow;
  dispose(): void;
}

function defaultInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function mountResearchSyncPanel(otui: unknown, renderer: unknown, parent: unknown, options: ResearchSyncPanelOptions): ResearchSyncPanelHandle {
  const core = otui as OpenTui;
  const r = renderer as never;
  const box = new core.BoxRenderable(r, { id: "sb-research-sync", flexDirection: "column", flexShrink: 0 });
  (parent as PanelParent).add(box);
  const read = options.read ?? readResearchSyncSnapshot;
  let current: ResearchSyncRow = { visible: false, text: "", role: "muted" };
  let generation = 0;
  let disposed = false;
  let paintedKey: string | undefined;

  const draw = (force = false): void => {
    if (disposed) return;
    const key = JSON.stringify(current);
    if (!force && key === paintedKey) return;
    paintedKey = key;
    clearTranscriptChildren(box);
    if (!current.visible) return;
    box.add(new core.TextRenderable(r, { id: "sb-research-sync-k", content: core.t`${dimChunk(core, RESEARCH_SYNC_LABEL)}`, marginTop: 1 }));
    box.add(new core.TextRenderable(r, { id: "sb-research-sync-v", content: core.t`${roleChunk(core, current.role, current.text)}` }));
  };

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    let next: ResearchSyncRow;
    try {
      next = projectResearchSyncRow(await read(options.root), options.width);
    } catch {
      next = { visible: false, text: "", role: "muted" };
    }
    if (disposed || mine !== generation) return;
    current = next;
    draw();
  };

  const unsubscribeTheme = onThemeChange(guardedThemeRepaint("research-sync-panel", () => draw(true), () => disposed || isRenderableGone(box)));
  void refresh();
  const stopPoll = (options.interval ?? defaultInterval)(refresh, options.pollMs ?? RESEARCH_SYNC_POLL_MS);

  return {
    refresh,
    row: () => current,
    dispose() {
      disposed = true;
      generation += 1;
      stopPoll();
      unsubscribeTheme();
    },
  };
}
