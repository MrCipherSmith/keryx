import { expect, test } from "bun:test";
import { renderWorkInspector, workSidebarSnapshot } from "./sidebar-work";
import { buildSidebarCards } from "./sidebar-cards";
import { SubagentSessionStore } from "./subagent-session";
import { BackgroundJobStore } from "./background-job-session";

test("Work counts active and successful workers separately, without parsing rendered text", () => {
  const snapshot = workSidebarSnapshot([
    { id: "a", label: "Running", status: "running" },
    { id: "b", label: "Queued", status: "queued" },
    { id: "c", label: "Done", status: "done" },
    { id: "d", label: "Failed", status: "failed" },
  ], [
    { jobId: "j1", command: "build", status: "running" },
    { jobId: "j2", command: "test", status: "completed" },
    { jobId: "j3", command: "lint", status: "killed" },
  ]);
  expect(snapshot.sections?.subagents).toBe("Subagents 1/1 · 1 queued · 1 failed");
  expect(snapshot.sections?.jobs).toBe("Jobs 1/1 · 1 failed");
  expect(snapshot.items?.subagents?.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  expect(snapshot.items?.jobs?.map((item) => item.id)).toEqual(["j1", "j2", "j3"]);
  const work = buildSidebarCards(snapshot).find((card) => card.id === "work")!;
  expect(work.lines(32, "default").some((line) => line.includes("Subagents 1/1"))).toBe(true);
  expect(work.lines(32, "default").some((line) => line.includes("Jobs 1/1"))).toBe(true);
});

test("empty Work snapshot suppresses worker counters; terminal failures never count as done", () => {
  expect(workSidebarSnapshot([], []).sections).toEqual({});
  expect(workSidebarSnapshot([{ id: "f", label: "bad", status: "failed" }], []).sections?.subagents)
    .toBe("Subagents 0/0 · 1 failed");
});


test("embedded subagent inspector updates live and unsubscribes exactly once", () => {
  const agents = new SubagentSessionStore();
  const jobs = new BackgroundJobStore();
  agents.apply({ kind: "upsert", id: "a", label: "Agent A", status: "running", task: "Review" });
  class Node {
    content: string;
    children: Node[] = [];
    constructor(_renderer: unknown, readonly opts: { id: string; content?: string; onMouseDown?: () => void }) {
      this.content = opts.content ?? "";
    }
    add(child: Node): void { this.children.push(child); }
    getChildren(): Node[] { return this.children; }
    remove(child: Node): void { this.children = this.children.filter((entry) => entry !== child); }
    destroy(): void {}
  }
  const body = new Node({}, { id: "body" });
  const dispose = renderWorkInspector(
    { BoxRenderable: Node, TextRenderable: Node } as unknown as Parameters<typeof renderWorkInspector>[0],
    { renderer: { requestRender() {} } } as unknown as Parameters<typeof renderWorkInspector>[1],
    body, "subagents", "a", { agents, jobs, registry: { kill: async () => ({ ok: true }) } },
  );
  const content = body.children[1]!;
  const work = content.children[0]!;
  agents.apply({ kind: "log", id: "a", entry: { kind: "tool", text: "fresh-update" } });
  expect(work.content).toContain("fresh-update");
  const previous = work.content;
  dispose();
  dispose();
  agents.apply({ kind: "log", id: "a", entry: { kind: "tool", text: "after-close" } });
  expect(work.content).toBe(previous);
});
