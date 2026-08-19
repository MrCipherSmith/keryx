// Flow 173 (T4/T5, AC8) — background-job-inspector.ts: clickable sidebar +
// modal inspector for background jobs. Structural mirror of
// `subagent-inspector.ts` (flow 162) — same `openModal` host, same
// no-private-overlay rule, same `onMouseDown`-per-row sidebar pattern (this
// file's "paintBackgroundJobSidebar rows fire onOpen on mouse down" test
// directly mirrors `subagent-inspector.test.ts`'s "AC2: paintSubagentSidebar
// rows fire onOpen on mouse down", per this flow's explicit instruction to
// use that as the template).
//
// Differences from the subagent inspector, all deliberate (description.md /
// plan.md):
//   - Tabs are "Output"/"Meta" (not "Work"/"Meta") — a job has raw
//     stdout/stderr text, not a structured work-event log.
//   - The footer gains a THIRD action, `k: kill`, alongside the existing
//     `←/→ tabs` / `esc close` pair (`SUBAGENT_INSPECTOR_FOOTER`'s exact two
//     entries, extended by one).
//   - The kill action must call `JobRegistry.kill(jobId)` — the SAME
//     registry instance `shell_job_kill` (the model-facing tool,
//     `background-job-registry.ts`) calls — never a second, private kill
//     path. `modal-host.ts`'s shared keypress handler (escape/left/right/
//     digit-jump) has no generic custom-action hook to bind a literal "k"
//     keypress to; rather than invent one (no seam for it exists — a real
//     modal-host change would be its own, separate concern, not silently
//     bundled into this test-only task), the pinned shape below renders the
//     kill action as a CLICKABLE row inside the Meta tab body — the exact
//     same `onMouseDown` idiom already used for sidebar rows and for
//     `modal-host.ts`'s own tab strip / close-hint — with the footer's
//     `k: kill` entry staying a static key-hint label (same as the existing
//     `←/→`/`esc` hints, which are ALSO not bound via a generic action
//     table — `modal-host.ts` hard-codes their handling). Flag in
//     journal.md: if a task-implementer instead wants a REAL "k" keypress
//     binding, that requires an actual `modal-host.ts` capability addition,
//     which is real implementation work out of this test-writing task's
//     scope — not a silent given.
//
// Does NOT exist yet.
//
// PINNED SHAPE (task-implementer builds exactly this; adjust only if a
// genuinely better shape is found, and flag it in journal.md if so):
//   export const JOB_INSPECTOR_FOOTER = [
//     { key: "←/→", label: "tabs" },
//     { key: "k", label: "kill" },
//     { key: "esc", label: "close" },
//   ] as const;
//   export type PresentJobInspectorOptions = {
//     store: BackgroundJobStore; id: string; registry: JobRegistry; renderer?: unknown;
//   };
//   export function inspectorTitleForJob(entry: BackgroundJobEntry): string;
//   export function presentJobInspector(openModalFn, otui, chrome, options): ModalHandle | undefined;
//   export function openJobInspector(otui, chrome, options): ModalHandle | undefined;
//   export type PaintBackgroundJobSidebarOptions = { width?: number; onOpen: (id: string) => void };
//   export function paintBackgroundJobSidebar(otui, renderer, parent, entries, options): void;
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODAL_PANEL_INNER_WIDTH, formatModalFooter } from "./modal-host";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import {
  JOB_INSPECTOR_FOOTER,
  paintBackgroundJobSidebar,
  presentJobInspector,
  type OpenModalFn,
} from "./background-job-inspector";
import { BackgroundJobStore } from "./background-job-session";

function fakeRegistry(overrides: Partial<JobRegistry> = {}): JobRegistry {
  return {
    start: async () => ({ ok: true, jobId: "unused", pid: 0, output: "" }),
    get: () => undefined,
    list: () => [],
    readOutput: () => ({ ok: true, output: "" }),
    kill: async () => ({ ok: true }),
    sweepAll: async () => {},
    ...overrides,
  };
}

test("AC8: presentJobInspector opens host modal with Output + Meta tabs", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  const calls: unknown[] = [];
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    calls.push(input);
    return { close: () => {}, setTab: () => {}, activeTab: () => input.initialTab ?? "output" };
  };
  const handle = presentJobInspector(openModal, {}, {}, { store, id: "job-1", registry: fakeRegistry() });
  expect(handle).toBeDefined();
  expect(calls).toHaveLength(1);
  const input = calls[0] as { title: string; tabs: { id: string; label: string }[]; initialTab?: string };
  expect(input.title).toContain("npm run dev");
  expect(input.tabs.map((t) => t.id)).toEqual(["output", "meta"]);
  expect(input.initialTab).toBe("output");
});

test("AC8: the footer adds k: kill alongside the existing ←/→ tabs / esc close pair", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  const calls: unknown[] = [];
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    calls.push(input);
    return { close: () => {}, setTab: () => {}, activeTab: () => "output" };
  };
  presentJobInspector(openModal, {}, {}, { store, id: "job-1", registry: fakeRegistry() });
  const input = calls[0] as { footer?: { key: string; label: string }[] };
  expect(input.footer?.map((item) => item.key)).toEqual(["←/→", "k", "esc"]);
  expect(input.footer).toEqual([...JOB_INSPECTOR_FOOTER]);
  expect(formatModalFooter(JOB_INSPECTOR_FOOTER).length).toBeLessThanOrEqual(MODAL_PANEL_INNER_WIDTH);
});

test("presentJobInspector is a no-op for an unknown id", () => {
  const store = new BackgroundJobStore();
  let opened = 0;
  const openModal: OpenModalFn = () => {
    opened += 1;
    return { close: () => {}, setTab: () => {}, activeTab: () => "output" };
  };
  expect(
    presentJobInspector(openModal, {}, {}, { store, id: "missing", registry: fakeRegistry() }),
  ).toBeUndefined();
  expect(opened).toBe(0);
});

test("AC8: store output updates after open repaint the Output tab body", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  let body: { content: string } | undefined;
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    input.renderTab("output", {
      add: (child: { content: string }) => {
        body = child;
      },
    });
    return { close: () => {}, setTab: () => {}, activeTab: () => "output" };
  };
  presentJobInspector(
    openModal,
    { TextRenderable: class { content = ""; constructor(_r: unknown, opts: { content: string }) { this.content = opts.content; } } },
    { renderer: {} },
    { store, id: "job-1", registry: fakeRegistry() },
  );
  store.apply({ type: "output", jobId: "job-1", chunk: "compiled successfully", stream: "stdout" });
  expect(body?.content).toContain("compiled successfully");
});

test("AC8: a removeAll() session-teardown sweep while the inspector is open repaints the gone-state", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  let body: { content: string } | undefined;
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    input.renderTab("output", {
      add: (child: { content: string }) => {
        body = child;
      },
    });
    return { close: () => {}, setTab: () => {}, activeTab: () => "output" };
  };
  presentJobInspector(
    openModal,
    { TextRenderable: class { content = ""; constructor(_r: unknown, opts: { content: string }) { this.content = opts.content; } } },
    { renderer: {} },
    { store, id: "job-1", registry: fakeRegistry() },
  );
  store.removeAll();
  expect(body?.content).not.toBe("");
  expect(body?.content.toLowerCase()).toContain("gone");
});

test("AC8: the Meta tab's Kill action calls registry.kill(jobId) — NOT a private separate kill path", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  const killed: string[] = [];
  const registry = fakeRegistry({
    kill: async (jobId: string) => {
      killed.push(jobId);
      return { ok: true };
    },
  });

  type MouseNode = { id: string; content: string; onMouseDown: (() => void) | undefined };
  const nodes: MouseNode[] = [];
  class FakeText implements MouseNode {
    id: string;
    content: string;
    onMouseDown: (() => void) | undefined;
    constructor(_r: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) {
      this.id = opts.id;
      this.content = opts.content;
      this.onMouseDown = opts.onMouseDown;
      nodes.push(this);
    }
  }

  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    input.renderTab("meta", {
      add: () => {},
    });
    return { close: () => {}, setTab: () => {}, activeTab: () => "meta" };
  };
  presentJobInspector(
    openModal,
    { TextRenderable: FakeText },
    { renderer: {} },
    { store, id: "job-1", registry },
  );

  const killRow = nodes.find((n) => n.onMouseDown !== undefined && /kill/i.test(n.content ?? n.id));
  expect(killRow).toBeDefined();
  killRow?.onMouseDown?.();
  expect(killed).toEqual(["job-1"]);
});

test("F-015: a failed kill (the common case — AC9 keeps a finished job visible) surfaces the error, not a silent no-op", async () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  const registry = fakeRegistry({
    kill: async () => ({ ok: false, error: "job already exited" }),
  });

  type MouseNode = { id: string; content: string; onMouseDown: (() => void) | undefined };
  const nodes: MouseNode[] = [];
  class FakeText implements MouseNode {
    id: string;
    content: string;
    onMouseDown: (() => void) | undefined;
    constructor(_r: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) {
      this.id = opts.id;
      this.content = opts.content;
      this.onMouseDown = opts.onMouseDown;
      nodes.push(this);
    }
  }

  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    input.renderTab("meta", { add: () => {} });
    return { close: () => {}, setTab: () => {}, activeTab: () => "meta" };
  };
  presentJobInspector(openModal, { TextRenderable: FakeText }, { renderer: {} }, { store, id: "job-1", registry });

  const killRow = nodes.find((n) => n.onMouseDown !== undefined && /kill/i.test(n.content ?? n.id));
  expect(killRow).toBeDefined();
  killRow?.onMouseDown?.();
  // registry.kill() is async — let its microtask settle.
  await Promise.resolve();
  await Promise.resolve();

  const statusNode = nodes.find((n) => n.id === "job-inspector-kill-status");
  expect(statusNode).toBeDefined();
  expect(statusNode?.content).toContain("job already exited");
});

test("F-018: switching tabs nulls the OTHER tab's node — a late store update cannot write into a detached node", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  type IdNode = { id: string; content: string };
  const outputTabNodes: IdNode[] = [];
  const metaTabNodes: IdNode[] = [];
  class FakeText implements IdNode {
    id: string;
    content: string;
    constructor(_r: unknown, opts: { id: string; content: string }) {
      this.id = opts.id;
      this.content = opts.content;
    }
  }
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    // Simulate the real modal host: initial open on "output", then a tab
    // switch to "meta" — each call hands a FRESH body container, exactly as
    // a real tab switch does. The Meta tab's `add` sees THREE nodes (meta
    // text + kill button + kill-status line), so nodes are collected by id
    // rather than assumed to be the last (or only) one added.
    input.renderTab("output", {
      add: (child: IdNode) => {
        outputTabNodes.push(child);
      },
    });
    input.renderTab("meta", {
      add: (child: IdNode) => {
        metaTabNodes.push(child);
      },
    });
    return { close: () => {}, setTab: () => {}, activeTab: () => "meta" };
  };
  presentJobInspector(openModal, { TextRenderable: FakeText }, { renderer: {} }, { store, id: "job-1", registry: fakeRegistry() });
  const outputBody = outputTabNodes.find((n) => n.id === "job-inspector-output");
  const metaBody = metaTabNodes.find((n) => n.id === "job-inspector-meta");
  const outputContentBeforeUpdate = outputBody?.content;
  store.apply({ type: "output", jobId: "job-1", chunk: "late chunk", stream: "stdout" });
  // The Output tab's node was detached by the switch to Meta — refresh()
  // must not write into it (before the fix, it silently did).
  expect(outputBody?.content).toBe(outputContentBeforeUpdate);
  // The Meta tab (the currently-active one) DOES get the live update.
  expect(metaBody?.content).toContain("running");
});

test("F-016: the inspector only requires .kill() from its registry — a kill-only stub is a valid registry", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  const killOnlyRegistry: Pick<JobRegistry, "kill"> = { kill: async () => ({ ok: true }) };
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    input.renderTab("meta", { add: () => {} });
    return { close: () => {}, setTab: () => {}, activeTab: () => "meta" };
  };
  const handle = presentJobInspector(
    openModal,
    { TextRenderable: class { content = ""; constructor(_r: unknown, opts: { content: string }) { this.content = opts.content; } } },
    { renderer: {} },
    { store, id: "job-1", registry: killOnlyRegistry },
  );
  expect(handle).toBeDefined();
});

test("AC8: paintBackgroundJobSidebar rows fire onOpen on mouse down", () => {
  const opened: string[] = [];
  const nodes: Array<{ id?: string; onMouseDown: (() => void) | undefined }> = [];
  class FakeText {
    id: string;
    content: string;
    onMouseDown: (() => void) | undefined;
    constructor(_r: unknown, opts: { id: string; content: string; onMouseDown?: () => void }) {
      this.id = opts.id;
      this.content = opts.content;
      this.onMouseDown = opts.onMouseDown;
      nodes.push(this);
    }
  }
  const children: unknown[] = [];
  const store = new BackgroundJobStore();
  store.apply({ type: "start", jobId: "job-1", pid: 1001, command: "npm run dev", startedAt: "2026-08-19T10:00:00.000Z" });
  paintBackgroundJobSidebar(
    { TextRenderable: FakeText },
    {},
    {
      add: (child: unknown) => {
        children.push(child);
      },
      getChildren: () => children,
      remove: (child: unknown) => {
        const idx = children.indexOf(child);
        if (idx >= 0) children.splice(idx, 1);
      },
    },
    store.list(),
    { onOpen: (id) => opened.push(id) },
  );
  const row = nodes.find((node) => node.id === "sb-job-job-1");
  expect(row?.onMouseDown).toBeTypeOf("function");
  row?.onMouseDown?.();
  expect(opened).toEqual(["job-1"]);
});

test("background-job-inspector.ts routes through the shared openModal host, no private overlay", () => {
  const local = readFileSync(join(import.meta.dir, "background-job-inspector.ts"), "utf8");
  expect(local).toMatch(/openModal[\s\S]*from\s*["']\.\/modal-host["']/);
  expect(local).toMatch(/onMouseDown/);
  expect(local).not.toMatch(/overlayBox/);
});
