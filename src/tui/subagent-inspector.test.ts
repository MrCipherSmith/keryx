// Flow 162 — subagent inspector modal (AC2, AC4, AC6).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODAL_PANEL_INNER_WIDTH, formatModalFooter } from "./modal-host";
import {
  SUBAGENT_INSPECTOR_FOOTER,
  paintSubagentSidebar,
  presentSubagentInspector,
  type OpenModalFn,
} from "./subagent-inspector";
import { SubagentSessionStore } from "./subagent-session";

test("AC2: presentSubagentInspector opens host modal with Work + Meta tabs", () => {
  const store = new SubagentSessionStore();
  store.apply({
    kind: "upsert",
    id: "sub:1",
    label: "review-logic",
    status: "running",
    model: "ollama/fake",
    task: "Review auth",
  });
  const calls: unknown[] = [];
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    calls.push(input);
    return { close: () => {}, setTab: () => {}, activeTab: () => input.initialTab ?? "work" };
  };
  const handle = presentSubagentInspector(openModal, {}, {}, { store, id: "sub:1" });
  expect(handle).toBeDefined();
  expect(calls).toHaveLength(1);
  const input = calls[0] as { title: string; tabs: { id: string; label: string }[]; initialTab?: string };
  expect(input.title).toContain("review-logic");
  expect(input.tabs.map((t) => t.id)).toEqual(["work", "meta"]);
  expect(input.initialTab).toBe("work");
  expect((input as { footer?: { key: string }[] }).footer?.map((item) => item.key)).toEqual(["←/→", "esc"]);
  expect(formatModalFooter(SUBAGENT_INSPECTOR_FOOTER).length).toBeLessThanOrEqual(MODAL_PANEL_INNER_WIDTH);
});

test("presentSubagentInspector is a no-op for an unknown id", () => {
  const store = new SubagentSessionStore();
  let opened = 0;
  const openModal: OpenModalFn = () => {
    opened += 1;
    return { close: () => {}, setTab: () => {}, activeTab: () => "work" };
  };
  expect(presentSubagentInspector(openModal, {}, {}, { store, id: "missing" })).toBeUndefined();
  expect(opened).toBe(0);
});

test("AC4: store updates after open repaint the Work tab body", () => {
  const store = new SubagentSessionStore();
  store.apply({ kind: "upsert", id: "sub:1", label: "one", status: "running", task: "go" });
  let body: { content: string } | undefined;
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    const node = { content: "" };
    body = node;
    input.renderTab("work", {
      add: (child: { content: string }) => {
        body = child;
      },
    });
    return { close: () => {}, setTab: () => {}, activeTab: () => "work" };
  };
  presentSubagentInspector(
    openModal,
    { TextRenderable: class { content = ""; constructor(_r: unknown, opts: { content: string }) { this.content = opts.content; } } },
    { renderer: {} },
    { store, id: "sub:1" },
  );
  expect(body?.content).toContain("go");
  store.apply({ kind: "log", id: "sub:1", entry: { kind: "tool", text: "search_code" } });
  expect(body?.content).toContain("search_code");
});

test("AC2: paintSubagentSidebar rows fire onOpen on mouse down", () => {
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
  paintSubagentSidebar(
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
    [
      {
        id: "sub:1",
        label: "review-logic",
        status: "running",
        startedAt: 1,
        events: [],
      },
    ],
    { onOpen: (id) => opened.push(id) },
  );
  const row = nodes.find((node) => node.id === "sb-sub-sub:1");
  expect(row?.onMouseDown).toBeTypeOf("function");
  row?.onMouseDown?.();
  expect(opened).toEqual(["sub:1"]);
});

test("review finding: a bulk clear() while the inspector is open repaints the gone-state, not frozen stale content", () => {
  const store = new SubagentSessionStore();
  store.apply({ kind: "upsert", id: "sub:1", label: "one", status: "running", task: "go" });
  let workBody: { content: string } | undefined;
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    input.renderTab("work", {
      add: (child: { content: string }) => {
        workBody = child;
      },
    });
    return { close: () => {}, setTab: () => {}, activeTab: () => "work" };
  };
  presentSubagentInspector(
    openModal,
    { TextRenderable: class { content = ""; constructor(_r: unknown, opts: { content: string }) { this.content = opts.content; } } },
    { renderer: {} },
    { store, id: "sub:1" },
  );
  expect(workBody?.content).toContain("go");

  // /clear or a new turn wipes the whole sidebar (wildcard id "*") while
  // this inspector is still open on a subagent that no longer exists.
  store.clear();

  expect(workBody?.content).toBe("Subagent is gone.");
});

/**
 * Structural-guard helper (docs/requirements/keryx-shell-split): concatenates
 * every non-test `.ts` source file under this module directory, recursively,
 * so a module-boundary check keeps covering the code once `tui-shell.ts` is
 * split into `src/tui/shell/*.ts` instead of breaking outright because the
 * call site it used to read moved to a different file. `exclude` names files
 * whose own identifier DEFINITIONS would make a presence check vacuous (e.g.
 * the file that defines the symbol a sibling call site is expected to use).
 */
function readTuiModuleSources(exclude: readonly string[] = []): string {
  const dir = import.meta.dir;
  const excluded = new Set(exclude);
  const collect = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
      const full = join(d, entry.name);
      if (entry.isDirectory()) return collect(full);
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
      if (excluded.has(entry.name)) return [];
      return [full];
    });
  return collect(dir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

// Structural (module-boundary), not behavioural — kept as a text audit on
// purpose (see docs/requirements/keryx-shell-split/audits-tui-other.md's
// Notes, and its Corrections section: `expect(tui).toMatch(hostImport)`
// really does read tui-shell.ts, and that is correct — the inventory's
// earlier claim of a wrong-file bug here was itself wrong). Two independent
// rules:
//  (1) SOMEWHERE in the module — not necessarily tui-shell.ts once it's
//      split — must import from "./subagent-inspector" and call both
//      `paintSubagentSidebar`/`openSubagentInspector`. Scanning the whole
//      module directory (excluding subagent-inspector.ts, which DEFINES both
//      names and would make the presence checks vacuous) survives that
//      split; the import-path regex tolerates one extra ".." level too, in
//      case the split nests the call site one directory deeper.
//  (2) `subagent-inspector.ts` itself must stay built on the shared
//      `openModal` host, never a private `overlayBox`. This file is small
//      and is not part of the god-file split, so reading it directly is
//      fine.
// Dropped: the old `local` check for `/onMouseDown/` — that behaviour is
// now proven directly above ("AC2: paintSubagentSidebar rows fire onOpen on
// mouse down", which calls the real `row.onMouseDown()`), so the text
// presence check on the same file was redundant, not a second guarantee.
test("AC2/AC6: tui-shell wires inspector through openModal, no private overlay", () => {
  const hostImport = /from\s*["']\.{1,2}\/subagent-inspector["']/;
  const moduleSource = readTuiModuleSources(["subagent-inspector.ts"]);
  const local = readFileSync(join(import.meta.dir, "subagent-inspector.ts"), "utf8");
  expect(local).toMatch(/openModal[\s\S]*from\s*["']\.\/modal-host["']/);
  expect(moduleSource).toMatch(hostImport);
  expect(moduleSource).toMatch(/paintSubagentSidebar/);
  expect(moduleSource).toMatch(/openSubagentInspector/);
  expect(local).not.toMatch(/overlayBox/);
});
