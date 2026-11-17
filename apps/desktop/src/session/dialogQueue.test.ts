import { describe, expect, test } from "bun:test";
import type { AskUserRequest, PermissionRequest } from "../acp/types";
import { DialogQueue } from "./dialogQueue";

const perm = (sessionId: string): PermissionRequest => ({ sessionId, toolCall: { toolCallId: "c" }, options: [] });
const ask = (sessionId: string): AskUserRequest => ({ sessionId, question: "?" });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("DialogQueue", () => {
  test("dialogs queue on their own session; only that session's are put on screen", () => {
    const q = new DialogQueue();
    void q.permission("a", perm("a"));
    void q.ask("b", ask("b"));
    void q.permission("b", perm("b"));
    expect(q.forSession("a").permissions).toHaveLength(1);
    expect(q.forSession("a").asks).toHaveLength(0);
    expect(q.forSession("b").permissions).toHaveLength(1);
    expect(q.forSession("b").asks).toHaveLength(1);
    expect(q.forSession(null).permissions).toHaveLength(0);
    expect([...q.waiting()].sort()).toEqual(["a", "b"]);
  });

  test("a turn that ends drops its session's dialogs as cancelled, and only those", async () => {
    const q = new DialogQueue();
    const late = q.permission("a", perm("a"));
    const lateAsk = q.ask("a", ask("a"));
    const other = q.permission("b", perm("b"));
    let otherDone = false;
    void other.then(() => (otherDone = true));
    q.dropSession("a");
    expect(await late).toEqual({ outcome: "cancelled" });
    expect(await lateAsk).toEqual({ outcome: "cancelled" });
    await tick();
    expect(otherDone).toBeFalse();
    expect([...q.waiting()]).toEqual(["b"]);
  });

  test("an answer settles the request once; a later drop does not answer it again", async () => {
    const q = new DialogQueue();
    const p = q.permission("a", perm("a"));
    const [pending] = q.forSession("a").permissions;
    q.answerPermission(pending!, { outcome: "selected", optionId: "allow" });
    q.dropSession("a");
    q.answerPermission(pending!, { outcome: "cancelled" });
    expect(await p).toEqual({ outcome: "selected", optionId: "allow" });
    expect(q.waiting().size).toBe(0);
  });

  test("dropAll cancels everything and reports the change", async () => {
    let changes = 0;
    const q = new DialogQueue(() => changes++);
    const a = q.ask("a", ask("a"));
    const b = q.permission("b", perm("b"));
    q.dropAll();
    expect(await a).toEqual({ outcome: "cancelled" });
    expect(await b).toEqual({ outcome: "cancelled" });
    expect(changes).toBe(3);
    q.dropAll();
    expect(changes).toBe(3);
  });
});
