import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "../acp/types";
import type { RoutedUpdate } from "./reducer";
import { SessionRegistry } from "./sessionRegistry";

const upd = (sessionId: string, text = "x"): RoutedUpdate => ({
  sessionId,
  at: 0,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as SessionUpdate,
});

/** A registry holding a (shown) and b. */
function holding() {
  const r = new SessionRegistry<string>();
  r.created("a", r.beginCreate());
  r.endCreate();
  r.created("b", r.beginCreate());
  r.endCreate();
  r.showLocal("a");
  return r;
}

describe("switching", () => {
  test("a held session is shown locally: no request", () => {
    const r = holding();
    expect(r.planSwitch("b")).toBe("show");
    r.showLocal("b");
    expect(r.shown).toBe("b");
    expect(r.held.has("a")).toBeTrue(); // switching away kills nothing
  });

  test("a session from history needs session/load", () => {
    expect(holding().planSwitch("old")).toBe("load");
  });

  test("a released session needs session/load on return", () => {
    const r = holding();
    expect(r.release("b")).toBeTrue();
    expect(r.planSwitch("b")).toBe("load");
    expect(r.release("b")).toBeFalse();
  });

  test("a load already in flight is not sent twice", () => {
    const r = holding();
    r.beginLoad("c");
    expect(r.planSwitch("c")).toBe("pending");
  });

  test("a load that finishes after the user moved on does not take the screen", () => {
    const r = holding();
    r.beginLoad("c");
    r.showLocal("b");
    expect(r.loadDone("c")).toBeFalse();
    expect(r.shown).toBe("b");
    expect(r.held.has("c")).toBeTrue();
  });

  test("a pending navigation from a revoked Issues account never shows the replay", () => {
    const r = holding();
    const scope = new AbortController();
    r.beginLoad("private");
    r.wantLoad("private", scope.signal);
    scope.abort();
    expect(r.loadDone("private")).toBeFalse();
    expect(r.shown).toBe("a");
  });

  test("asking again for a session that is loading shows it when it lands", () => {
    const r = holding();
    r.beginLoad("c");
    r.showLocal("b");
    r.wantLoad("c");
    expect(r.loadDone("c")).toBeTrue();
    expect(r.shown).toBe("c");
  });

  test("of two new sessions started back to back, the later one is shown", () => {
    const r = holding();
    const first = r.beginCreate();
    const second = r.beginCreate();
    expect(r.created("n2", second)).toBeTrue();
    expect(r.created("n1", first)).toBeFalse();
    expect(r.shown).toBe("n2");
    expect(r.held.has("n1")).toBeTrue();
  });

  test("a failed load leaves what is shown alone", () => {
    const r = holding();
    r.beginLoad("c");
    r.loadFailed("c");
    expect(r.shown).toBe("a");
    expect(r.planSwitch("c")).toBe("load");
  });

  test("a reset forgets what keryx held but keeps the shown session for a restart", () => {
    const r = holding();
    r.turns.set("a", "turn");
    r.reset();
    expect(r.held.size).toBe(0);
    expect(r.turns.size).toBe(0);
    expect(r.shown).toBe("a");
    expect(r.planSwitch("a")).toBe("load");
  });
});

describe("routing updates", () => {
  test("updates for held and loading sessions apply, shown or not", () => {
    const r = holding();
    r.beginLoad("c");
    expect(r.route(upd("a"))).toBe("apply");
    expect(r.route(upd("b"))).toBe("apply");
    expect(r.route(upd("c"))).toBe("apply");
  });

  test("an unknown session's update is dropped", () => {
    expect(holding().route(upd("zzz"))).toBe("drop");
  });

  test("while a session/new is in flight an unknown id is held and handed over with the reply", () => {
    const r = holding();
    const intent = r.beginCreate();
    expect(r.route(upd("n", "early"))).toBe("hold");
    expect(r.route(upd("other"))).toBe("hold");
    r.created("n", intent);
    expect(r.takeOrphans("n").map((u) => (u.update as { content: { text: string } }).content.text)).toEqual(["early"]);
    r.endCreate();
    expect(r.takeOrphans("other")).toEqual([]);
  });

  test("held updates are bounded", () => {
    const r = new SessionRegistry(2);
    const intent = r.beginCreate();
    for (let i = 0; i < 5; i++) r.route(upd("n"));
    r.created("n", intent);
    expect(r.takeOrphans("n")).toHaveLength(2);
  });
});

describe("admitting keryx's requests", () => {
  test("a request for a held session with a running turn is admitted", () => {
    const r = holding();
    r.turns.set("b", "turn");
    expect(r.admit({ sessionId: "b" })).toBe("b");
  });

  test("a request without a string sessionId is refused", () => {
    const r = holding();
    r.turns.set("a", "turn");
    expect(r.admit({})).toBeNull();
    expect(r.admit({ sessionId: 1 })).toBeNull();
    expect(r.admit(null)).toBeNull();
    expect(r.admit(undefined)).toBeNull();
  });

  test("a request for an unknown or released session is refused", () => {
    const r = holding();
    r.turns.set("b", "turn");
    expect(r.admit({ sessionId: "zzz" })).toBeNull();
    r.release("b");
    expect(r.admit({ sessionId: "b" })).toBeNull();
  });

  test("a request for a session with no running turn (a late one after it ended) is refused", () => {
    const r = holding();
    expect(r.admit({ sessionId: "a" })).toBeNull();
  });

  test("a held session with a command in flight is admitted, and not once the command settled", () => {
    const r = holding();
    const end = r.beginCommand("a");
    expect(r.admit({ sessionId: "a" })).toBe("a");
    end();
    expect(r.admit({ sessionId: "a" })).toBeNull();
  });

  test("overlapping commands keep the session admitted until the last settles; ending twice is harmless", () => {
    const r = holding();
    const e1 = r.beginCommand("a");
    const e2 = r.beginCommand("a");
    e1();
    e1();
    expect(r.admit({ sessionId: "a" })).toBe("a");
    e2();
    expect(r.admit({ sessionId: "a" })).toBeNull();
  });

  test("a command for an unheld session does not admit it; release and reset forget the command", () => {
    const r = holding();
    r.beginCommand("zzz");
    expect(r.admit({ sessionId: "zzz" })).toBeNull();
    r.beginCommand("b");
    r.release("b");
    expect(r.admit({ sessionId: "b" })).toBeNull();
    r.beginCommand("a");
    r.reset();
    expect(r.commands.size).toBe(0);
  });
});
