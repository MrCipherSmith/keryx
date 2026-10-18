// flow 461: the `/projectctx` modal and the `ProjectCtx` sidebar line. The state
// they show lives in project files (`tasks.config.json`, `last.json`, the rule
// registry), read through `loadProjectContextStatus`, which never throws. The
// matrix of states and events is docs/requirements/keryx-project-implementation-rules/TUI-states.md.
// Flow 462 adds the `refs` segment and the References tab (docs/requirements/keryx-conditional-reads/TUI-states.md);
// their text lives in project-references-view.ts.

import type { ProjectContextStatus } from "../gdskills/project-context-status";
import { openModal, type ModalHandle, type OpenModalInput } from "./modal-host";
import { cardSafe } from "../lib/card-safe";
import { stylePlanText } from "./execution-plan-inspector";
import { formatProjectReferencesLines, referencesSidebarSegment } from "./project-references-view";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";

export { formatProjectReferencesLines, NO_REFERENCES_TEXT } from "./project-references-view";

export const PROJECT_CONTEXT_COMMAND = "/projectctx";

export type EnforcementMode = ProjectContextStatus["enforcement"];

export type ProjectContextTab = "status" | "last" | "references";

export type ProjectContextCommand =
  | { kind: "open"; /** Absent: the Status tab. */ tab?: "references" }
  | { kind: "set"; mode: EnforcementMode }
  | { kind: "invalid"; message: string };

export function isProjectContextCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === PROJECT_CONTEXT_COMMAND;
}

export function parseProjectContextCommand(line: string): ProjectContextCommand {
  const [, ...rest] = line.trim().split(/\s+/);
  if (rest.length === 0) return { kind: "open" };
  const arg = rest[0] as string;
  if (rest.length === 1 && (arg === "warn" || arg === "block")) return { kind: "set", mode: arg };
  if (rest.length === 1 && arg === "refs") return { kind: "open", tab: "references" };
  return { kind: "invalid", message: `Unknown ${PROJECT_CONTEXT_COMMAND} argument '${rest.join(" ")}'. Usage: ${PROJECT_CONTEXT_COMMAND} [warn|block|refs]` };
}

export const NO_RESOLVE_TEXT = "no resolve recorded yet";

export const PROJECT_CONTEXT_CONFIG_REFUSAL = "projectctx: tasks.config.json is not valid JSON, refusing to overwrite it";

export function projectContextFooter(status: ProjectContextStatus): readonly { key: string; label: string }[] {
  const toggle =
    status.configError === undefined
      ? { key: "e", label: "toggle warn/block" }
      : { key: "e", label: "toggle off: fix tasks.config.json" };
  return [toggle, { key: "esc", label: "close" }];
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function formatProjectContextStatusLines(status: ProjectContextStatus): string[] {
  const lines = [
    `Enforcement: ${status.enforcement} (${status.enforcementSource})`,
    `Context cap: ${status.maxBytes} bytes (${status.maxBytesSource})`,
    `Project rules: ${status.ruleCount} (${status.linkedCount} linked)`,
  ];
  if (status.configError !== undefined) {
    lines.push("", `config unreadable: ${status.configError}; defaults used`);
  }
  if (status.last?.result.budget.exceeded === true) {
    lines.push("", `cap exceeded: raise gdskills.projectContext.maxBytes (now ${status.maxBytes}, from ${status.maxBytesSource})`);
  }
  return lines;
}

export function formatProjectContextLastLines(status: ProjectContextStatus): string[] {
  if (status.lastError !== undefined) return [`last resolve unreadable: ${status.lastError}`];
  const last = status.last;
  if (last === undefined) return [NO_RESOLVE_TEXT];
  const { result } = last;
  const lines = [
    `Last resolve: for ${result.for}, ${plural(result.files.length, "file")}, ${last.recordedAt}`,
    `budget: ${result.budget.usedBytes}/${result.budget.limitBytes} bytes`,
  ];
  for (const tier of ["must_read", "on_demand"] as const) {
    const entries = result.entries.filter((entry) => entry.tier === tier);
    lines.push("", `${tier} (${entries.length}):`);
    if (entries.length === 0) lines.push("  (none)");
    for (const entry of entries) {
      lines.push(`  ${entry.path} [${entry.source}] ${entry.reason}`);
      if (entry.shadows !== undefined) lines.push(`    shadows ${entry.shadows}`);
      if (entry.also_at !== undefined) lines.push(`    also at ${entry.also_at.join(", ")}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("", `warnings (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`  ${warning}`);
  }
  return lines;
}

/** `undefined` (row hidden) when there is nothing to show: no rules, no recorded resolve and no references file. */
export function renderProjectContextSidebarValue(status: ProjectContextStatus): string | undefined {
  if (status.ruleCount === 0 && status.last === undefined && status.lastError === undefined && status.references === undefined) return undefined;
  const parts = [status.enforcement, plural(status.ruleCount, "rule")];
  const refs = referencesSidebarSegment(status);
  if (refs !== undefined) parts.push(refs);
  if (status.last?.result.budget.exceeded === true) parts.push("cap exceeded");
  if (status.configError !== undefined) parts.push("config unreadable");
  return cardSafe(parts.join(" · "));
}

type Body = { add?(child: unknown): void; getChildren?(): unknown[]; remove?(child: unknown): void };
type TextCtor = new (renderer: unknown, options: { id: string; content: unknown }) => unknown;
type OpenModalFn = (otui: never, chrome: never, input: OpenModalInput) => ModalHandle | undefined;

export interface ProjectContextModalOptions {
  initial: ProjectContextStatus;
  loadStatus: () => Promise<ProjectContextStatus>;
  /** Persist the mode; may reject (the writer refuses an invalid `tasks.config.json`). */
  setEnforcement: (mode: EnforcementMode) => Promise<void>;
  onKeypress: (handler: (key: { name: string; sequence: string }) => void) => () => void;
  inputBlocked?: () => boolean;
  /** Called when a toggle is refused or fails; never thrown into the modal. */
  onError?: (message: string) => void;
  /** Called after the status was reloaded, so the sidebar can follow. */
  onStatus?: (status: ProjectContextStatus) => void;
  /** The tab shown first; `/projectctx refs` passes "references". */
  initialTab?: ProjectContextTab;
  /** Told when the status changed outside the modal (a new resolve recorded); the open tab repaints in place. */
  subscribe?: (listener: (status: ProjectContextStatus) => void) => () => void;
}

const sameStatus = (a: ProjectContextStatus | undefined, b: ProjectContextStatus): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

export interface ProjectContextFeed {
  current(): ProjectContextStatus | undefined;
  /** Loads the status now; listeners hear of it only when it differs from the last one seen. */
  reload(): Promise<ProjectContextStatus>;
  subscribe(listener: (status: ProjectContextStatus) => void): () => void;
  stop(): void;
}

export interface ProjectContextFeedOptions {
  load: () => Promise<ProjectContextStatus>;
  /** Test seam; the default is an unref'd `setInterval`. */
  interval?: (tick: () => Promise<void>, ms: number) => () => void;
  pollMs?: number;
  /** A failing poll is reported once until a poll succeeds again. */
  onError?: (message: string) => void;
}

export const PROJECT_CONTEXT_POLL_MS = 5000;

function defaultInterval(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/**
 * The one reader of the project-context status for the sidebar and the modal. It
 * polls, because a resolve is recorded by a worker outside the TUI, and tells
 * subscribers only when the status actually changed, so a quiet project repaints nothing.
 */
export function createProjectContextFeed(options: ProjectContextFeedOptions): ProjectContextFeed {
  let current: ProjectContextStatus | undefined;
  let failing = false;
  const listeners = new Set<(status: ProjectContextStatus) => void>();

  let started = 0;
  let applied = 0;
  let polling = false;

  const reload = async (): Promise<ProjectContextStatus> => {
    const mine = ++started;
    const next = await options.load();
    // A load that began before the one already applied is older news, whatever order they finished in.
    if (mine > applied && !sameStatus(current, next)) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    }
    applied = Math.max(applied, mine);
    return next;
  };

  const poll = async (): Promise<void> => {
    // A load slower than the interval must not pile up another scan behind it.
    if (polling) return;
    polling = true;
    try {
      await reload();
      failing = false;
    } catch (error) {
      if (!failing) options.onError?.(error instanceof Error ? error.message : String(error));
      failing = true;
    } finally {
      polling = false;
    }
  };

  const stop = (options.interval ?? defaultInterval)(poll, options.pollMs ?? PROJECT_CONTEXT_POLL_MS);
  return {
    current: () => current,
    reload,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop,
  };
}

export function presentProjectContext(
  openModalFn: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: ProjectContextModalOptions,
): { close(): void } | undefined {
  let status = options.initial;
  let tab: string = options.initialTab ?? "status";
  let closed = false;
  let busy = false;
  let body: Body | undefined;
  let off: () => void = () => {};
  let unsubscribeTheme: () => void = () => {};
  let unsubscribeStatus: () => void = () => {};
  const renderer = (chrome as { renderer?: unknown } | undefined)?.renderer;

  const paint = (): void => {
    if (closed || body?.add === undefined) return;
    const Ctor = (otui as { TextRenderable?: TextCtor }).TextRenderable;
    if (Ctor === undefined) return;
    for (const child of [...(body.getChildren?.() ?? [])]) body.remove?.(child);
    const lines =
      tab === "last"
        ? formatProjectContextLastLines(status)
        : tab === "references"
          ? formatProjectReferencesLines(status)
          : formatProjectContextStatusLines(status);
    // Reference descriptions, anchors and keywords are file text; control bytes must not reach the terminal.
    body.add(new Ctor(renderer, { id: `projectctx-${tab}`, content: stylePlanText(otui, lines.map(cardSafe).join("\n"), "plain") }));
  };

  const handle = openModalFn(otui as never, chrome as never, {
    title: PROJECT_CONTEXT_COMMAND,
    tabs: [
      { id: "status", label: "Status" },
      { id: "last", label: "Last resolve" },
      { id: "references", label: "References" },
    ],
    initialTab: options.initialTab ?? "status",
    footer: projectContextFooter(status),
    contentRows:
      Math.max(
        formatProjectContextStatusLines(status).length,
        formatProjectContextLastLines(status).length,
        formatProjectReferencesLines(status).length,
      ) + 2,
    renderTab: (tabId, nextBody) => {
      tab = tabId;
      body = nextBody as Body;
      paint();
    },
    onClose: () => {
      closed = true;
      off();
      unsubscribeTheme();
      unsubscribeStatus();
    },
  });
  if (handle === undefined) return undefined;

  unsubscribeStatus =
    options.subscribe?.((next) => {
      if (closed || sameStatus(status, next)) return;
      status = next;
      paint();
    }) ?? unsubscribeStatus;

  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint(
      "project-context-modal",
      paint,
      () => closed || isRenderableGone(body) || (renderer as { isDestroyed?: boolean } | undefined)?.isDestroyed === true,
    ),
  );

  off = options.onKeypress((key) => {
    if (closed || busy || options.inputBlocked?.() === true) return;
    if ((key.name || key.sequence) !== "e") return;
    if (status.configError !== undefined) {
      options.onError?.(PROJECT_CONTEXT_CONFIG_REFUSAL);
      return;
    }
    busy = true;
    void options
      .setEnforcement(status.enforcement === "warn" ? "block" : "warn")
      .then(() => options.loadStatus())
      .then((next) => {
        status = next;
        options.onStatus?.(next);
      })
      .catch((error: unknown) => options.onError?.(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        busy = false;
        paint();
      });
  });

  return handle;
}

export function openProjectContext(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: ProjectContextModalOptions,
): { close(): void } | undefined {
  return presentProjectContext(openModal as unknown as OpenModalFn, otui, chrome, options);
}
