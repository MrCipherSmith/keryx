// Flow 176 T16 — external inspector modal, headless (no live TTY).
// Package: docs/requirements/keryx-external-agent-runtime §8.2, D-11.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_INSPECTOR_FOOTER,
  EXTERNAL_RUN_GONE,
  externalInspectorTitle,
  presentExternalInspector,
  type OpenModalFn,
} from "./external-inspector";
import { ExternalRunStore } from "./external-session";
import { MODAL_PANEL_INNER_WIDTH, formatModalFooter } from "./modal-host";

class FakeText {
  id: string;
  content: string;
  constructor(_renderer: unknown, opts: { id: string; content: string }) {
    this.id = opts.id;
    this.content = opts.content;
  }
}

/** Renders every tab into its own captured node, the way the host would. */
function fakeHost(captured: Map<string, { content: string }>): OpenModalFn {
  return (_otui, _chrome, input) => {
    for (const tab of input.tabs) {
      input.renderTab(tab.id, {
        add: (child: unknown) => {
          captured.set(tab.id, child as { content: string });
        },
      });
    }
    return { close: () => {}, setTab: () => {}, activeTab: () => input.initialTab ?? "work" };
  };
}

function seeded(): ExternalRunStore {
  const store = new ExternalRunStore(() => 1);
  store.start("ext:1", {
    agentId: "codex-cli",
    agentLabel: "Codex",
    model: "gpt-5-codex",
    sandbox: "read-only",
    worktreePath: "/tmp/wt/ext-1",
    argv: ["codex", "exec", "--json", "do the thing"],
    reportsCost: false,
  });
  store.event("ext:1", { kind: "child_started", sessionRef: "thread-1" });
  return store;
}

describe("presentExternalInspector", () => {
  test("opens the shared host on Work + Meta + Command", () => {
    const calls: Array<{ title: string; tabs: { id: string }[]; initialTab?: string }> = [];
    const openModalFn: OpenModalFn = (_otui, _chrome, input) => {
      calls.push(input as never);
      return { close: () => {}, setTab: () => {}, activeTab: () => "work" };
    };
    const handle = presentExternalInspector(openModalFn, {}, {}, { store: seeded(), id: "ext:1" });
    expect(handle).toBeDefined();
    expect(calls[0]?.tabs.map((tab) => tab.id)).toEqual(["work", "meta", "command"]);
    expect(calls[0]?.initialTab).toBe("work");
    expect(calls[0]?.title).toBe("Codex · gpt-5-codex");
    expect(formatModalFooter(EXTERNAL_INSPECTOR_FOOTER).length).toBeLessThanOrEqual(MODAL_PANEL_INNER_WIDTH);
  });

  test("is a no-op for an unknown id", () => {
    let opened = 0;
    const openModalFn: OpenModalFn = () => {
      opened += 1;
      return { close: () => {}, setTab: () => {}, activeTab: () => "work" };
    };
    expect(
      presentExternalInspector(openModalFn, {}, {}, { store: new ExternalRunStore(), id: "nope" }),
    ).toBeUndefined();
    expect(opened).toBe(0);
  });

  test("each tab paints its own body, and live events repaint Work", () => {
    const store = seeded();
    const bodies = new Map<string, { content: string }>();
    presentExternalInspector(fakeHost(bodies), { TextRenderable: FakeText }, { renderer: {} }, {
      store,
      id: "ext:1",
    });

    expect(bodies.get("work")?.content).toContain("started · session thread-1");
    expect(bodies.get("meta")?.content).toContain("read-only");
    expect(bodies.get("command")?.content).toContain("Shell form");

    store.event("ext:1", { kind: "tool_call", name: "command_execution", detail: "bun test" });
    expect(bodies.get("work")?.content).toContain("● $ bun test");

    store.finish("ext:1", { status: "Completed", skippedLines: 0 });
    expect(bodies.get("meta")?.content).toContain("Completed");
    // codex reports no cost: MISSING, explained, never zero.
    expect(bodies.get("meta")?.content).toContain("MISSING (this CLI reports no cost)");
  });

  test("a resume argv recorded mid-run reaches the Command tab", () => {
    const store = seeded();
    const bodies = new Map<string, { content: string }>();
    presentExternalInspector(fakeHost(bodies), { TextRenderable: FakeText }, { renderer: {} }, {
      store,
      id: "ext:1",
    });
    store.setResumeArgv("ext:1", ["codex", "exec", "resume", "thread-1", "check the tests"]);
    expect(bodies.get("command")?.content).toContain("resume thread-1 'check the tests'");
  });

  test("a bulk clear() while the modal is open repaints the gone-state, not stale content", () => {
    const store = seeded();
    const bodies = new Map<string, { content: string }>();
    presentExternalInspector(fakeHost(bodies), { TextRenderable: FakeText }, { renderer: {} }, {
      store,
      id: "ext:1",
    });
    store.clear();
    expect(bodies.get("work")?.content).toBe(EXTERNAL_RUN_GONE);
    expect(bodies.get("meta")?.content).toBe(EXTERNAL_RUN_GONE);
    expect(bodies.get("command")?.content).toBe(EXTERNAL_RUN_GONE);
  });

  test("updates for OTHER runs do not repaint this modal", () => {
    const store = seeded();
    const bodies = new Map<string, { content: string }>();
    presentExternalInspector(fakeHost(bodies), { TextRenderable: FakeText }, { renderer: {} }, {
      store,
      id: "ext:1",
    });
    const before = bodies.get("work")?.content;
    store.start("ext:2", { agentId: "claude-cli" });
    store.event("ext:2", { kind: "assistant_text", text: "other child" });
    expect(bodies.get("work")?.content).toBe(before!);
  });

  test("degrades to a no-op body when the renderer package is absent", () => {
    const store = seeded();
    const bodies = new Map<string, { content: string }>();
    // No TextRenderable: OpenTUI is an OPTIONAL dependency and must not be
    // required for the modal path to be callable.
    const handle = presentExternalInspector(fakeHost(bodies), {}, {}, { store, id: "ext:1" });
    expect(handle).toBeDefined();
    expect(bodies.size).toBe(0);
    // Refreshing with no mounted nodes must not throw.
    store.event("ext:1", { kind: "assistant_text", text: "still fine" });
  });
});

describe("externalInspectorTitle", () => {
  test("falls back to the agent id and omits an empty model", () => {
    expect(externalInspectorTitle({ id: "x", agentId: "codex-cli", events: [] })).toBe("codex-cli");
    expect(externalInspectorTitle({ id: "x", agentId: "codex-cli", model: "", events: [] })).toBe("codex-cli");
  });
});

test("the inspector goes through the shared modal host and imports no optional dependency", () => {
  const source = readFileSync(join(import.meta.dir, "external-inspector.ts"), "utf8");
  expect(source).toMatch(/openModal[\s\S]*from\s*["']\.\/modal-host["']/);
  expect(source).not.toMatch(/from\s*["']@opentui\/core["']/);
  // The transcript box must never carry `alignSelf`: it collapses the box's
  // intrinsic height in OpenTUI, and an empty modal reads as a dead child.
  expect(source).not.toMatch(/alignSelf\s*:/);
});
