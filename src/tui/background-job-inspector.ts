// Background job inspector + clickable sidebar list (flow 173, T4/T5, AC8).
// Presentation only: `BackgroundJobStore` owns job state. TUI open goes
// through `openModal` from `./modal-host`. No private overlay. Structural
// mirror of `subagent-inspector.ts` (flow 162) — same host, same
// no-private-overlay rule, same `onMouseDown`-per-row sidebar pattern.
//
// Differences from the subagent inspector, all deliberate:
//   - Tabs are "Output"/"Meta" (not "Work"/"Meta") — a job has raw
//     stdout/stderr text, not a structured work-event log.
//   - The footer gains a THIRD action, `k: kill`, alongside the existing
//     `←/→ tabs` / `esc close` pair.
//   - The kill action calls `JobRegistry.kill(jobId)` — the SAME registry
//     instance `shell_job_kill` (the model-facing tool) calls, never a
//     second, private kill path. `modal-host.ts`'s shared keypress handler
//     has no generic custom-action hook to bind a literal "k" keypress to;
//     rather than add one (real, separate `modal-host.ts` scope), the kill
//     action is rendered as a CLICKABLE row inside the Meta tab body — the
//     same `onMouseDown` idiom already used for sidebar rows and the modal's
//     own tab strip/close-hint. The footer's `k: kill` entry stays a static
//     key-hint label only (same as `←/→`/`esc`, which are ALSO not bound via
//     a generic action table today).

import { openModal } from "./modal-host";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import {
  formatJobListHeader,
  formatJobMeta,
  formatJobOutput,
  formatJobRow,
  type BackgroundJobEntry,
  type BackgroundJobStore,
  type BackgroundJobStoreHint,
} from "./background-job-session";

export const JOB_INSPECTOR_FOOTER = [
  { key: "←/→", label: "tabs" },
  { key: "k", label: "kill" },
  { key: "esc", label: "close" },
] as const;

export type ModalTab = { id: string; label: string };

export type OpenModalInput = {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown) => void | (() => void);
  onClose?: () => void;
};

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export type OpenModalFn = (otui: unknown, chrome: unknown, input: OpenModalInput) => ModalHandle | undefined;

/**
 * F-016: the inspector only ever calls `.kill()` on the registry it is
 * handed, never `start`/`get`/`list`/`readOutput`/`sweepAll` — narrowed here
 * (rather than in `JobRegistry`'s own definition) so this module's declared
 * dependency matches what it actually uses. A real `JobRegistry` satisfies
 * this structurally, so every existing call site (which passes the full
 * registry) is unaffected.
 */
export type JobKillCapability = Pick<JobRegistry, "kill">;

export type PresentJobInspectorOptions = {
  store: BackgroundJobStore;
  id: string;
  registry: JobKillCapability;
  renderer?: unknown;
};

type TextNode = { content: string };

type OtuiLike = {
  TextRenderable?: new (renderer: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) => TextNode;
  ScrollBoxRenderable?: new (
    renderer: unknown,
    opts: {
      id: string;
      flexGrow?: number;
      minHeight?: number;
      scrollY?: boolean;
      stickyScroll?: boolean;
      stickyStart?: string;
      contentOptions?: { flexDirection: string };
    },
  ) => { content?: { add?: (child: unknown) => void }; add?: (child: unknown) => void };
};

function resolveTarget(
  otui: unknown,
  renderer: unknown,
  body: unknown,
): { add: (child: unknown) => void } | undefined {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return undefined;
  }
  const parent = body as { add?: (child: unknown) => void };
  if (parent.add === undefined) {
    return undefined;
  }
  const scrollCtor = (otui as OtuiLike).ScrollBoxRenderable;
  if (scrollCtor === undefined) {
    return { add: parent.add.bind(parent) };
  }
  const scroll = new scrollCtor(renderer, {
    id: "job-inspector-scroll",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column" },
  });
  parent.add(scroll);
  const target = scroll.content ?? scroll;
  if (target.add === undefined) {
    return undefined;
  }
  return { add: target.add.bind(target) };
}

function paintContent(otui: unknown, renderer: unknown, body: unknown, content: string): TextNode | undefined {
  const target = resolveTarget(otui, renderer, body);
  const textCtor = (otui as OtuiLike).TextRenderable;
  if (target === undefined || textCtor === undefined) {
    return undefined;
  }
  const node = new textCtor(renderer, { id: "job-inspector-output", content });
  target.add(node);
  return node;
}

function paintMetaTab(
  otui: unknown,
  renderer: unknown,
  body: unknown,
  entry: BackgroundJobEntry,
  registry: JobKillCapability,
  jobId: string,
): TextNode | undefined {
  const target = resolveTarget(otui, renderer, body);
  const textCtor = (otui as OtuiLike).TextRenderable;
  if (target === undefined || textCtor === undefined) {
    return undefined;
  }
  const metaNode = new textCtor(renderer, { id: "job-inspector-meta", content: formatJobMeta(entry) });
  target.add(metaNode);
  // F-015: AC9 keeps a finished job's entry visible after it exits, so
  // clicking Kill on an already-finished job is the COMMON case, not an
  // edge case — `registry.kill()`'s `{ok:false, error}` result was
  // previously discarded, so that click silently no-opped with zero
  // feedback. Surface it on a dedicated status line instead.
  const killStatusNode = new textCtor(renderer, { id: "job-inspector-kill-status", content: "" });
  const killNode = new textCtor(renderer, {
    id: "job-inspector-kill",
    content: "[ Kill ]",
    onMouseDown: () => {
      void registry.kill(jobId).then((result) => {
        if (!result.ok) {
          killStatusNode.content = `Kill failed: ${result.error}`;
        }
      });
    },
  });
  target.add(killNode);
  target.add(killStatusNode);
  return metaNode;
}

const GONE_TEXT = "Background job is gone.";

export function inspectorTitleForJob(entry: BackgroundJobEntry): string {
  return entry.command;
}

export function presentJobInspector(
  openModalFn: OpenModalFn,
  otui: unknown,
  chrome: unknown,
  options: PresentJobInspectorOptions,
): ModalHandle | undefined {
  const entry = options.store.get(options.id);
  if (entry === undefined) {
    return undefined;
  }

  let outputNode: TextNode | undefined;
  let metaNode: TextNode | undefined;
  let unsubscribe: (() => void) | undefined;

  const refresh = (hint?: BackgroundJobStoreHint): void => {
    if (hint !== undefined && hint.id !== options.id) {
      return;
    }
    const current = options.store.get(options.id);
    if (current === undefined) {
      if (outputNode !== undefined) {
        outputNode.content = GONE_TEXT;
      }
      if (metaNode !== undefined) {
        metaNode.content = GONE_TEXT;
      }
      return;
    }
    if (outputNode !== undefined) {
      outputNode.content = formatJobOutput(current);
    }
    if (metaNode !== undefined) {
      metaNode.content = formatJobMeta(current);
    }
  };

  const handle = openModalFn(otui, chrome, {
    title: inspectorTitleForJob(entry),
    tabs: [
      { id: "output", label: "Output" },
      { id: "meta", label: "Meta" },
    ],
    initialTab: "output",
    footer: JOB_INSPECTOR_FOOTER,
    renderTab: (tabId, body) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const current = options.store.get(options.id);
      if (current === undefined) {
        paintContent(otui, renderer, body, GONE_TEXT);
        return;
      }
      if (tabId === "meta") {
        metaNode = paintMetaTab(otui, renderer, body, current, options.registry, options.id);
        // F-018: the Output tab's node is now detached (its parent body was
        // replaced) — null it so `refresh()` never writes to a stale node.
        // (`subagent-inspector.ts` has the same gap; not mirrored — fixed
        // independently here.)
        outputNode = undefined;
        return;
      }
      outputNode = paintContent(otui, renderer, body, formatJobOutput(current));
      metaNode = undefined; // F-018: ditto, the other direction
    },
    onClose: () => {
      unsubscribe?.();
    },
  });
  if (handle === undefined) {
    return undefined;
  }
  unsubscribe = options.store.subscribe(refresh);
  return handle;
}

/** Open the shared host on Output + Meta. No-op when OpenTUI/chrome/id is missing. */
export function openJobInspector(
  otui: Parameters<typeof openModal>[0],
  chrome: Parameters<typeof openModal>[1],
  options: PresentJobInspectorOptions,
): ModalHandle | undefined {
  return presentJobInspector(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

export type PaintBackgroundJobSidebarOptions = {
  width?: number;
  onOpen: (id: string) => void;
};

type SidebarParent = {
  add?: (child: unknown) => void;
  getChildren?: () => unknown[];
  remove?: (child: unknown) => void;
};

/** Rebuild the clickable Background Jobs list. Each row opens the inspector. */
export function paintBackgroundJobSidebar(
  otui: unknown,
  renderer: unknown,
  parent: unknown,
  entries: readonly BackgroundJobEntry[],
  options: PaintBackgroundJobSidebarOptions,
): void {
  const box = parent as SidebarParent;
  const ctor = (otui as OtuiLike).TextRenderable;
  if (box.add === undefined || ctor === undefined) {
    return;
  }
  if (box.getChildren !== undefined && box.remove !== undefined) {
    for (const child of [...box.getChildren()]) {
      box.remove(child);
    }
  }
  if (entries.length === 0) {
    return;
  }
  const width = options.width ?? SIDEBAR_TEXT_WIDTH;
  box.add(
    new ctor(renderer, {
      id: "sb-jobs-h",
      content: formatJobListHeader(entries.length),
    }),
  );
  for (const entry of entries) {
    const id = entry.jobId;
    box.add(
      new ctor(renderer, {
        id: `sb-job-${id}`,
        content: formatJobRow(entry, width),
        onMouseDown: () => {
          options.onOpen(id);
        },
      }),
    );
  }
}
