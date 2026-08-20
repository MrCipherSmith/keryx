// Flow 176 T16 — the external run store behind the operator surface.
import { describe, expect, test } from "bun:test";
import { ExternalRunStore, MAX_EXTERNAL_EVENTS, type ExternalStoreHint } from "./external-session";
import { formatExternalMeta } from "./external-transcript";

const launch = { agentId: "codex-cli", agentLabel: "Codex", reportsCost: false } as const;

describe("ExternalRunStore", () => {
  test("start/event/finish build the view the modal renders", () => {
    const store = new ExternalRunStore(() => 1_000);
    store.start("ext:1", { ...launch, sandbox: "read-only", worktreePath: "/tmp/wt", argv: ["codex", "exec"] });
    store.event("ext:1", { kind: "child_started", sessionRef: "thread-1" });
    store.event("ext:1", { kind: "assistant_text", text: "working" });
    store.finish("ext:1", { status: "Completed", skippedLines: 2, argv: ["codex", "exec", "--json"] });

    const view = store.get("ext:1")!;
    expect(view.sessionRef).toBe("thread-1");
    expect(view.status).toBe("Completed");
    expect(view.skippedLines).toBe(2);
    expect(view.argv).toEqual(["codex", "exec", "--json"]);
    expect(view.events).toHaveLength(2);
    expect(store.isRunning("ext:1")).toBe(false);
    expect(formatExternalMeta(view)).toContain("Codex (codex-cli)");
  });

  test("events for an unknown run are ignored rather than inventing a nameless entry", () => {
    const store = new ExternalRunStore();
    store.event("ghost", { kind: "assistant_text", text: "x" });
    store.warn("ghost", "w");
    store.finish("ghost", { status: "Error" });
    expect(store.list()).toEqual([]);
  });

  test("a run is live until it finishes", () => {
    const store = new ExternalRunStore();
    store.start("ext:1", launch);
    expect(store.isRunning("ext:1")).toBe(true);
    store.finish("ext:1", { status: "Timeout" });
    expect(store.isRunning("ext:1")).toBe(false);
    expect(store.isRunning("missing")).toBe(false);
  });

  test("trimming keeps the tail but never loses the session handle", () => {
    const store = new ExternalRunStore();
    store.start("ext:1", launch);
    store.event("ext:1", { kind: "child_started", sessionRef: "thread-1" });
    for (let i = 0; i < MAX_EXTERNAL_EVENTS + 10; i += 1) {
      store.event("ext:1", { kind: "assistant_text", text: `line ${i}` });
    }
    const view = store.get("ext:1")!;
    expect(view.events).toHaveLength(MAX_EXTERNAL_EVENTS);
    expect(view.events.some((event) => event.kind === "child_started")).toBe(false);
    // Lifted onto the record before trimming, so the resume route survives.
    expect(view.sessionRef).toBe("thread-1");
  });

  test("an absent cost on completion never overwrites a reported one and never becomes zero", () => {
    const store = new ExternalRunStore();
    store.start("ext:1", { agentId: "claude-cli", reportsCost: true });
    store.finish("ext:1", { status: "Completed" });
    expect(store.get("ext:1")?.costUnits).toBeUndefined();

    store.start("ext:2", { agentId: "claude-cli", reportsCost: true });
    store.finish("ext:2", { status: "Completed", costUnits: 0.5 });
    expect(store.get("ext:2")?.costUnits).toBe(0.5);
  });

  test("warnings accumulate and reach Meta", () => {
    const store = new ExternalRunStore();
    store.start("ext:1", launch);
    store.warn("ext:1", "version drift");
    store.warn("ext:1", "diff truncated");
    expect(store.get("ext:1")?.warnings).toEqual(["version drift", "diff truncated"]);
  });

  test("subscribers get hints; a throwing subscriber never breaks the run", () => {
    const store = new ExternalRunStore();
    const hints: ExternalStoreHint[] = [];
    store.subscribe(() => {
      throw new Error("boom");
    });
    const off = store.subscribe((hint) => hints.push(hint));
    store.start("ext:1", launch);
    store.event("ext:1", { kind: "retry", message: "again" });
    store.setResumeArgv("ext:1", ["codex", "exec", "resume", "t"]);
    store.warn("ext:1", "w");
    store.finish("ext:1", { status: "Completed" });
    store.clear();
    expect(hints.map((hint) => hint.kind)).toEqual(["start", "event", "event", "warning", "end", "end"]);
    expect(hints.at(-1)?.id).toBe("*");
    expect(store.get("ext:1")).toBeUndefined();

    off();
    store.start("ext:2", launch);
    expect(hints).toHaveLength(6);
  });

  test("clear on an empty store repaints nothing", () => {
    const store = new ExternalRunStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.clear();
    expect(calls).toBe(0);
  });
});
