// Flow 273 (agent bus P2, T7): the TUI's join/status/render wiring.
//
// Pure helpers, driven without a renderer, plus source-text audits for the
// wiring points a renderer-less test cannot reach (join, leave, setSession) —
// same style `tui-session-lease.test.ts` uses for `sessionLease.release()`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyBusyDispatch } from "./busy-dispatch";
import { formatBusLeasesLines, formatBusLogLines, formatBusPeersLines } from "./bus-panel";
import { parseBusCommand } from "./bus-command";
import { formatFleetSidebarWithPeers, type FleetPeer, type FleetWorker } from "./worker-fleet";
import type { BusPeer, RenderedBusEvent } from "../bus/client";
import { formatBusEventLine } from "../bus/display";
import type { BusEvent, PauseLease, PresenceRecord } from "../bus/schema";

/** A minimal `RenderedBusEvent`, overridable per test. */
function renderedEvent(overrides: Partial<RenderedBusEvent> = {}): RenderedBusEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    shortId: "00000000",
    fromName: "release",
    fromInstanceId: "00000000-0000-4000-8000-000000000001",
    kind: "notice",
    preview: "ready for review",
    ...overrides,
  };
}

const source = readFileSync(path.join(import.meta.dir, "tui-shell.ts"), "utf8");

function presence(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId: "00000000-0000-4000-8000-000000000001",
    name: "release",
    pid: 123,
    host: "host-a",
    sessionId: "00000000-0000-4000-8000-0000000000aa",
    checkout: "/repo/worktree-a",
    branch: "main",
    surface: "tui",
    status: "working",
    activity: "flow 273 task 7",
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    keryxVersion: "0.0.0",
    ...overrides,
  };
}

function peer(overrides: Partial<PresenceRecord> = {}, state: "live" | "stale" = "live"): BusPeer {
  return { record: presence(overrides), state, ageMs: 0 };
}

describe("formatFleetSidebarWithPeers (fleet sidebar Peers group, AC5)", () => {
  test("no peers reproduces formatFleetSidebar's own output exactly", () => {
    const workers: FleetWorker[] = [{ id: "agent:main", label: "main", status: "queued" }];
    expect(formatFleetSidebarWithPeers(workers)).not.toContain("Peers");
    expect(formatFleetSidebarWithPeers(workers, [])).toBe(formatFleetSidebarWithPeers(workers));
  });

  test("peers render as their OWN group below the local fleet, never merged into it", () => {
    const workers: FleetWorker[] = [{ id: "agent:main", label: "main", status: "running", detail: "thinking" }];
    const peers: FleetPeer[] = [
      { name: "release", state: "live", status: "working", activity: "flow 190" },
      { name: "qa", state: "stale", status: "idle", activity: "" },
    ];
    const text = formatFleetSidebarWithPeers(workers, peers, 12);
    const peersAt = text.indexOf("Peers");
    expect(peersAt).toBeGreaterThan(0);
    expect(text.slice(0, peersAt)).toContain("Working");
    // review r1 F11: live/stale AND working/idle, not live/stale alone.
    expect(text).toContain("●◐ @release");
    expect(text).toContain("flow 190");
    expect(text).toContain("◌○ @qa");
  });

  test("more peers than fit are counted, not silently dropped", () => {
    const many: FleetPeer[] = Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, state: "live" as const, status: "idle", activity: "" }));
    const text = formatFleetSidebarWithPeers([], many, 5);
    expect(text).toMatch(/… \+\d+ more/);
  });

  // review r1 F3: peer name and activity are free text — a crafted presence
  // record must never paint an escape sequence into the sidebar.
  test("peer name and activity are displaySafe'd (review r1 F3)", () => {
    const ESC = "\x1b";
    const peers: FleetPeer[] = [{ name: `evil${ESC}[31mname`, state: "live", status: "working", activity: `hi${ESC}[31m there` }];
    const text = formatFleetSidebarWithPeers([], peers, 12);
    expect(text).not.toContain(ESC);
    expect(text).toContain("evilname");
    expect(text).toContain("hi there");
  });

  // review r1 F11: an unrecognized status string degrades to a `?` glyph
  // rather than throwing (a forward-compat guard, since `status` crosses the
  // module boundary as a plain string, not the closed `PresenceStatus` enum).
  test("an unrecognized peer status falls back to a glyph instead of throwing", () => {
    const peers: FleetPeer[] = [{ name: "release", state: "live", status: "somethingnew", activity: "" }];
    expect(() => formatFleetSidebarWithPeers([], peers, 12)).not.toThrow();
    expect(formatFleetSidebarWithPeers([], peers, 12)).toContain("●? @release");
  });
});

describe("classifyBusyDispatch: the bus target (AC1, AC4)", () => {
  const base = {
    isSessionInfo: false,
    isFlows: false,
    isWorkspace: false,
    isReview: false,
    isMcp: false,
    isMcpConsumer: false,
  };

  test("/bus (bare, modal) routes to bus while busy", () => {
    expect(classifyBusyDispatch({ line: "/bus", commandName: "/bus", ...base })).toBe("bus");
  });

  test("/bus send/ask/reply/name all route to bus while busy", () => {
    for (const line of ["/bus @release hi", "/bus send @release hi", "/bus ask @release hi", "/bus reply abc hi", "/bus name qa"]) {
      expect(classifyBusyDispatch({ line, commandName: "/bus", ...base })).toBe("bus");
    }
  });
});

describe("formatBusEventLine (specification §5.2: transcript rendering; review r1 F4)", () => {
  // review r1 F4: the TUI transcript line is `../bus/display`'s own
  // `formatBusEventLine(RenderedBusEvent)` — the ONE place both surfaces
  // format an event line — imported directly by `tui-shell.ts`. `bus-panel.ts`
  // no longer keeps its own copy (was a 3-arg `(fromName, kind, preview)`
  // function with no `#seq`, which is what made a `/bus reply` id invisible
  // to the operator in the first place).
  test("renders ⇄ [#seq] @from kind: preview", () => {
    expect(formatBusEventLine(renderedEvent({ seq: 7 }))).toBe("⇄ [#7] @release notice: ready for review");
  });

  test("an empty preview still renders the from/kind, just with nothing after the colon", () => {
    expect(formatBusEventLine(renderedEvent({ kind: "handoff", preview: "" }))).toBe("⇄ [#1] @release handoff: ");
  });
});

describe("parseBusCommand (specification §7.2: /bus subcommand parsing and refusals)", () => {
  test("bare /bus opens the modal", () => {
    expect(parseBusCommand("/bus")).toEqual({ kind: "modal" });
    expect(parseBusCommand("/bus   ")).toEqual({ kind: "modal" });
  });

  test("the @name shorthand is a send", () => {
    expect(parseBusCommand("/bus @release ready for review")).toEqual({
      kind: "send",
      toLabel: "@release",
      text: "ready for review",
    });
  });

  test("send / ask / reply / name, spelled out", () => {
    expect(parseBusCommand("/bus send @release hi")).toEqual({ kind: "send", toLabel: "@release", text: "hi" });
    expect(parseBusCommand("/bus ask @release are you done?")).toEqual({
      kind: "ask",
      toLabel: "@release",
      text: "are you done?",
    });
    expect(parseBusCommand("/bus reply abc-123 thanks")).toEqual({ kind: "reply", id: "abc-123", text: "thanks" });
    expect(parseBusCommand("/bus name qa-2")).toEqual({ kind: "name", name: "qa-2" });
  });

  test("refusals: missing body, missing name, and an unknown subcommand", () => {
    expect(parseBusCommand("/bus @release").kind).toBe("error");
    expect(parseBusCommand("/bus send @release").kind).toBe("error");
    expect(parseBusCommand("/bus ask @release").kind).toBe("error");
    expect(parseBusCommand("/bus reply abc").kind).toBe("error");
    expect(parseBusCommand("/bus name").kind).toBe("error");
    expect(parseBusCommand("/bus pause @all --scope turns reason").kind).toBe("error"); // P4, not wired here
    expect(parseBusCommand("/bus nonsense")).toEqual({ kind: "error", reason: 'unknown /bus subcommand "nonsense"' });
  });
});

describe("/bus modal tab content builders (specification §7.2)", () => {
  test("Peers: live/stale, name, status, activity, checkout, branch", () => {
    const lines = formatBusPeersLines([peer({ name: "release" }, "live"), peer({ name: "qa", branch: null }, "stale")]);
    expect(lines[0]).toContain("● live");
    expect(lines[0]).toContain("@release");
    expect(lines[0]).toContain("working");
    expect(lines[0]).toContain("flow 273 task 7");
    expect(lines[0]).toContain("/repo/worktree-a");
    expect(lines[0]).toContain("main");
    expect(lines[1]).toContain("◌ stale");
    expect(lines[1]).toContain("@qa");
  });

  test("Peers: empty list says so instead of rendering nothing", () => {
    expect(formatBusPeersLines([])).toEqual(["No other instances on this bus."]);
  });

  // review r1 F3: name/activity/checkout/branch are peer-supplied free text
  // (specification §4.1) — a crafted presence record must never paint an
  // escape sequence into the operator's terminal.
  test("Peers: name, activity, checkout and branch are displaySafe'd (review r1 F3)", () => {
    const ESC = "\x1b";
    const lines = formatBusPeersLines([
      peer({
        name: `evil${ESC}[31mname`,
        activity: `hi${ESC}[31m there`,
        checkout: `/repo${ESC}[2Jworktree`,
        branch: `main${ESC}[31mbranch`,
      }),
    ]);
    for (const line of lines) {
      expect(line).not.toContain(ESC);
    }
    expect(lines[0]).toContain("evilname");
    expect(lines[0]).toContain("hi there");
    expect(lines[0]).toContain("repoworktree");
    expect(lines[0]).toContain("mainbranch");
  });

  test("Leases: active leases only, holder, targets, reason, expiry", () => {
    const lease: PauseLease = {
      schemaVersion: 1,
      leaseId: "00000000-0000-4000-8000-000000000002",
      holder: { instanceId: "00000000-0000-4000-8000-000000000001", name: "release", origin: "operator" },
      targets: ["*"],
      scope: "turns",
      reason: "cutting the release branch",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      requestEventSeq: 1,
    };
    const lines = formatBusLeasesLines([lease]);
    expect(lines[0]).toContain("turns");
    expect(lines[0]).toContain("@release");
    expect(lines[0]).toContain("@all");
    expect(lines[0]).toContain("cutting the release branch");
    expect(lines[0]).toContain("2026-01-01T01:00:00.000Z");
  });

  test("Leases: none active says so", () => {
    expect(formatBusLeasesLines([])).toEqual(["No active leases."]);
  });

  // review r1 F3: `reason` and the holder's `name` are peer-supplied free
  // text — a crafted lease record must never paint an escape sequence into
  // the operator's terminal.
  test("Leases: holder name and reason are displaySafe'd (review r1 F3)", () => {
    const ESC = "\x1b";
    const lease: PauseLease = {
      schemaVersion: 1,
      leaseId: "00000000-0000-4000-8000-000000000002",
      holder: { instanceId: "00000000-0000-4000-8000-000000000001", name: `evil${ESC}[31mname`, origin: "operator" },
      targets: ["*"],
      scope: "turns",
      reason: `cutting${ESC}[31m the release branch`,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      requestEventSeq: 1,
    };
    const lines = formatBusLeasesLines([lease]);
    expect(lines[0]).not.toContain(ESC);
    expect(lines[0]).toContain("evilname");
    expect(lines[0]).toContain("cutting the release branch");
  });

  test("Log: displaySafe'd, at most the last 50", () => {
    const events: BusEvent[] = Array.from({ length: 55 }, (_, i) => ({
      schemaVersion: 1,
      seq: i + 1,
      id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
      ts: "2026-01-01T00:00:00.000Z",
      from: { instanceId: "00000000-0000-4000-8000-000000000001", name: "release", origin: "operator" },
      to: ["*"],
      toLabel: "@all",
      kind: "notice",
      body: i === 54 ? "hello[31m world" : `msg ${i}`,
    }));
    const lines = formatBusLogLines(events);
    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain("msg 5"); // the oldest of the last 50 kept (index 5)
    expect(lines.at(-1)).toContain("hello world"); // ANSI stripped by displaySafe
    expect(lines.at(-1)).not.toContain("");
  });

  // review r1 F4: an operator copies either the `#seq` or the short id into
  // `/bus reply <ref>` — both must be on the line.
  test("Log: shows both #seq and the 8-character short id (review r1 F4)", () => {
    const event: BusEvent = {
      schemaVersion: 1,
      seq: 42,
      id: "a1b2c3d4-0000-4000-8000-000000000001",
      ts: "2026-01-01T00:00:00.000Z",
      from: { instanceId: "00000000-0000-4000-8000-000000000001", name: "release", origin: "operator" },
      to: ["*"],
      toLabel: "@all",
      kind: "notice",
      body: "ready for review",
    };
    const [line] = formatBusLogLines([event]);
    expect(line).toContain("#42");
    expect(line).toContain("a1b2c3d4");
  });

  // review r1 F3: `fromName` and `toLabel` are peer-supplied free text too —
  // same escape-sequence guard as the Peers/Leases tabs above.
  test("Log: fromName and toLabel are displaySafe'd (review r1 F3)", () => {
    const ESC = "\x1b";
    const event: BusEvent = {
      schemaVersion: 1,
      seq: 1,
      id: "00000000-0000-4000-8000-000000000001",
      ts: "2026-01-01T00:00:00.000Z",
      from: { instanceId: "00000000-0000-4000-8000-000000000001", name: `evil${ESC}[31mname`, origin: "operator" },
      to: ["*"],
      toLabel: `@all${ESC}[31m`,
      kind: "notice",
      body: "hi",
    };
    const [line] = formatBusLogLines([event]);
    expect(line).not.toContain(ESC);
    expect(line).toContain("evilname");
    expect(line).toContain("@all");
  });

  test("Log: no events says so", () => {
    expect(formatBusLogLines([])).toEqual(["No events yet."]);
  });
});

describe("tui-shell.ts wiring (source-text audit — a renderer-less test cannot reach these)", () => {
  // review r1 F9: specification §5.4 orders a clean exit as "leave the bus,
  // THEN release the session lease" — every real exit path is checked for
  // that exact order below, not just that both calls are present.
  test("onDestroy (Ctrl+C) leaves the bus BEFORE releasing the session lease", () => {
    const start = source.indexOf("onDestroy: () => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("void (async () => {", start));
    const leaveIdx = body.indexOf("liveBus?.leave();");
    const releaseIdx = body.indexOf("sessionLease.release();");
    expect(leaveIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(leaveIdx);
  });

  test("/exit and the busy-menu exit leave the bus before releasing the session lease, before destroying the renderer", () => {
    for (const marker of ['if (command.name === "/exit") {', 'case "exit": {']) {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = source.slice(start, source.indexOf("r.destroy();", start));
      const leaveIdx = block.indexOf("liveBus?.leave();");
      const releaseIdx = block.indexOf("sessionLease.release();");
      expect(leaveIdx).toBeGreaterThanOrEqual(0);
      expect(releaseIdx).toBeGreaterThan(leaveIdx);
    }
  });

  test("the outer finally leaves the bus before releasing the session lease", () => {
    const tail = source.slice(source.lastIndexOf("} finally {"));
    const leaveIdx = tail.indexOf("liveBus?.leave();");
    const releaseIdx = tail.indexOf("sessionLease.release();");
    expect(leaveIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(leaveIdx);
  });

  test("applyOpened (startup picker, fork/view/cancel, /resume) updates presence.sessionId, caught (review r1 F10)", () => {
    const start = source.indexOf("const applyOpened = (");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("const pickRecentSession", start));
    expect(body).toContain("liveBus?.setSession(opened.handle.summary.id).catch(");
  });

  test("startNewSession (/new, /clear) updates presence.sessionId outside applyOpened, caught (review r1 F10)", () => {
    const start = source.indexOf("const startNewSession = (");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("const resumeSessionInteractive", start));
    expect(body).toContain("liveBus?.setSession(liveSession.summary.id).catch(");
  });

  test("resumeSessionInteractive (/resume, /sessions) goes through applyOpened, not a second setSession call", () => {
    const start = source.indexOf("const resumeSessionInteractive = ");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("paintSessionHeader();\n\n", start));
    expect(body).toContain("applyOpened(opened, true);");
  });

  test("the join call passes surface tui, a session-lease GETTER, and status from herdrStateFor (review r1 F2)", () => {
    const start = source.indexOf("await joinBus({");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("});", start));
    expect(block).toContain('surface: "tui"');
    // review r1 F2: a GETTER, not a value captured once — `/new` swaps
    // `sessionLease.current` to a fresh lease handle, and a captured value
    // would keep refreshing the old, already-released one.
    expect(block).toContain("sessionLease: () => sessionLease.current");
    expect(block).toContain("herdrStateFor(lastMainAgentStatus)");
    expect(block).toContain("opts.session?.busName");
    expect(block).toContain("onError: makeBusErrorReporter(");
  });

  test("a bus error is caught and never escapes the join — the TUI must never break on it", () => {
    const start = source.indexOf("await joinBus({");
    const tryStart = source.lastIndexOf("try {", start);
    const catchStart = source.indexOf("} catch (error) {", start);
    expect(tryStart).toBeGreaterThanOrEqual(0);
    expect(catchStart).toBeGreaterThan(start);
    const catchBlock = source.slice(catchStart, source.indexOf("})();", catchStart));
    expect(catchBlock).toContain("bus: off");
  });

  // review r1 F6: `joinBus` is awaited inside a fire-and-forget IIFE, so
  // Ctrl+C (`onDestroy`) can land while it is still in flight.
  describe("the join guards a destroyed renderer (review r1 F6)", () => {
    test("onDestroy sets the destroyed flag", () => {
      const start = source.indexOf("onDestroy: () => {");
      const body = source.slice(start, source.indexOf("void (async () => {", start));
      expect(body).toContain("destroyed = true;");
    });

    test("onEvent and onPeers bail out before painting when destroyed", () => {
      const joinStart = source.indexOf("await joinBus({");
      const eventIdx = source.indexOf("onEvent: (event) => {", joinStart);
      const peersIdx = source.indexOf("onPeers: (peers: BusPeer[]) => {", joinStart);
      expect(eventIdx).toBeGreaterThan(joinStart);
      expect(peersIdx).toBeGreaterThan(joinStart);
      const eventBody = source.slice(eventIdx, source.indexOf("},", eventIdx));
      const peersBody = source.slice(peersIdx, source.indexOf("paintFleet();", peersIdx));
      expect(eventBody).toContain("if (destroyed) return;");
      expect(peersBody).toContain("if (destroyed) return;");
    });

    test("once resolved, a destroyed join leaves immediately instead of adopting the client", () => {
      const joinEnd = source.indexOf("});", source.indexOf("await joinBus({"));
      const disabledIdx = source.indexOf('if ("disabled" in joined) {', joinEnd);
      expect(disabledIdx).toBeGreaterThan(joinEnd);
      const tail = source.slice(disabledIdx, disabledIdx + 500);
      const destroyedIdx = tail.indexOf("if (destroyed) {");
      const joinedLeaveIdx = tail.indexOf("joined.leave();");
      const assignIdx = tail.indexOf("liveBus = joined;");
      expect(destroyedIdx).toBeGreaterThanOrEqual(0);
      expect(joinedLeaveIdx).toBeGreaterThan(destroyedIdx);
      expect(assignIdx).toBeGreaterThan(joinedLeaveIdx);
    });

    test("once assigned, the client resyncs to whatever session is live by then, caught (review r1 F10)", () => {
      const assignIdx = source.indexOf("liveBus = joined;");
      expect(assignIdx).toBeGreaterThanOrEqual(0);
      const tail = source.slice(assignIdx, assignIdx + 600);
      expect(tail).toContain("joined.setSession(liveSession.summary.id).catch(");
    });
  });

  // review r1 F4: `/bus reply <ref>` goes through the client's own
  // `resolveRef`/`reply` (`../bus/client`) instead of a local id→name map.
  test("/bus reply goes through client.reply, no local recentBusSenders map", () => {
    expect(source).not.toContain("recentBusSenders");
    const replyIdx = source.indexOf('if (parsed.kind === "reply") {');
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    const block = source.slice(replyIdx, source.indexOf("return;", replyIdx));
    expect(block).toContain(".reply(parsed.id, parsed.text)");
    expect(block).toContain("result.event.toLabel");
  });

  // review r1 F10: reading presence/leases/log for the `/bus` modal must not
  // throw into the shell.
  test("showBus's IIFE catches and reports instead of throwing", () => {
    const start = source.indexOf("const showBus = (): void => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("const runBusCommand", start));
    expect(body).toContain("try {");
    expect(body).toContain("} catch (error) {");
  });

  test("/bus is dispatched both while busy and not busy, through the one runBusCommand", () => {
    expect(source).toContain('case "bus": {');
    expect(source).toContain('if (command.name === "/bus") {');
    expect((source.match(/runBusCommand\(line\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// Flow 274 (agent bus P3, T7; specification §5.3, AC5/AC6): delivery to the
// agent — pushing polled events into `busInbox` and waking an idle TUI on a
// wake-eligible one. The OpenTUI REPL is not mountable under the unit harness
// (same limitation the flow 265 task-notification wake audit documents in
// `tui-shell.test.ts`), so wiring order/plumbing stays a source-text audit
// here; the actual DECISION/print/wake behaviour (review r1 F11: what used to
// be duplicated as source audits and a reimplemented loop) is driven directly
// through the real `createBusWakeController` factory in `bus-wake.test.ts`
// and `../bus/delivery.integration.test.ts`.
describe("flow 274 T7 — TUI bus delivery wiring (source-text audit)", () => {
  test("onEvent pushes the rendered event into busInbox, body defaulted, and marks the poll as having delivered something (review r1 F1)", () => {
    const joinIndex = source.indexOf("await joinBus({");
    expect(joinIndex).toBeGreaterThanOrEqual(0);
    const eventIdx = source.indexOf("onEvent: (event) => {", joinIndex);
    expect(eventIdx).toBeGreaterThan(joinIndex);
    const eventBody = source.slice(eventIdx, source.indexOf("},", eventIdx));
    expect(eventBody).toContain("busInbox.push({ ...event, body: event.body ?? \"\" });");
    expect(eventBody).toContain("busPollDeliveredEvent = true;");
  });

  test("onPeers reports this poll's delivery to the wake controller once per poll, after painting the fleet, and resets for the next poll", () => {
    const joinIndex = source.indexOf("await joinBus({");
    const peersIdx = source.indexOf("onPeers: (peers: BusPeer[]) => {", joinIndex);
    expect(peersIdx).toBeGreaterThan(joinIndex);
    const peersBody = source.slice(peersIdx, source.indexOf("},", source.indexOf("paintFleet();", peersIdx)));
    expect(peersBody).toContain("paintFleet();");
    expect(peersBody.indexOf("busWakeController?.onPoll(busPollDeliveredEvent);")).toBeGreaterThan(
      peersBody.indexOf("paintFleet();"),
    );
    // review r1 F1: reset AFTER reporting, so the next poll starts fresh.
    expect(peersBody.indexOf("busPollDeliveredEvent = false;")).toBeGreaterThan(
      peersBody.indexOf("busWakeController?.onPoll(busPollDeliveredEvent);"),
    );
    // review r1 F10: the drop notifier is also re-armed once the inbox empties.
    expect(peersBody).toContain("busDropNotifier.onInboxSizeObserved(busInbox.size);");
  });

  test("createBusWakeController is imported and used to build the bus-wake controller (review r1 F11)", () => {
    expect(source).toContain('createBusWakeController,\n  type BusDropNotifier,\n  type BusWakeController,\n} from "./bus-wake";');
    expect(source).toContain("busWakeController = createBusWakeController({");
  });

  test("the bus-wake controller is built from the SAME idle test, inbox, consecutiveAutoWakes/resolveMaxAutoWake, and runLine as the task-notification wake", () => {
    const start = source.indexOf("busWakeController = createBusWakeController({");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 900);
    expect(block).toContain("chrome.isBusy()");
    expect(block).toContain("foregroundOperation.isActive");
    expect(block).toContain("mainQueue.length === 0");
    expect(block).toContain("inbox: busInbox,");
    expect(block).toContain("consecutiveAutoWakes");
    expect(block).toContain("resolveMaxAutoWake()");
    expect(block).toContain('runLine("", "bus-message")');
    // review r1 F4: no wake before this session's own deps carry busInbox/busAck.
    expect(block).toContain("hasBusDeps: () => deps.busInbox !== undefined,");
    // Never a second, bus-only counter — the SAME variable the task
    // notification wake increments/resets.
    expect(block).not.toMatch(/consecutiveBusWakes|busWakeCount/);
  });

  test("the bus-wake controller never treats the session as idle once the destroyed guard is set (review r1 F6 pattern)", () => {
    const start = source.indexOf("busWakeController = createBusWakeController({");
    const block = source.slice(start, start + 300);
    expect(block).toContain("isIdle: () => !destroyed && !chrome.isBusy()");
  });

  test("the capped bus-wake message mirrors the task-notification cap wording", () => {
    expect(source).toContain(
      "a peer message arrived; automatic wakes are capped, so it will be delivered with your next message",
    );
  });

  test("turn settle also triggers the bus-wake controller's onSettle, only when no queued operator item ran instead", () => {
    const nextIdx = source.lastIndexOf("const next = forceHandoff.takeNext() ?? mainQueue.shift();");
    expect(nextIdx).toBeGreaterThanOrEqual(0);
    const block = source.slice(nextIdx, nextIdx + 700);
    expect(block).toContain("runLine(next.question);");
    expect(block).toContain("busWakeController?.onSettle();");
    // The queued item wins — bus-wake only runs in the `else` branch.
    expect(block.indexOf("} else {")).toBeGreaterThan(block.indexOf("runLine(next.question);"));
  });

  test("busInbox/busAck are merged onto deps only once the join actually succeeds — never for a disabled bus", () => {
    const disabledIdx = source.indexOf('if ("disabled" in joined) {');
    const assignIdx = source.indexOf("liveBus = joined;");
    expect(disabledIdx).toBeGreaterThanOrEqual(0);
    expect(assignIdx).toBeGreaterThan(disabledIdx);
    const disabledBlock = source.slice(disabledIdx, assignIdx);
    expect(disabledBlock).not.toContain("busInbox");
    // Widened for review r1 F7's `selAtJoin`/comment ahead of these fields.
    const successBlock = source.slice(assignIdx, assignIdx + 2600);
    expect(successBlock).toContain("busInbox,");
    expect(successBlock).toContain("busAck: (events) => joined.ack(events),");
  });

  // review r1 F7: a concurrent `/model`/`/connect` must never be reverted by
  // this rebuild finishing later with a stale `currentSel`.
  test("the join-success rebuild captures currentSel as selAtJoin before its own await and only merges bus fields when a switch landed meanwhile", () => {
    const assignIdx = source.indexOf("liveBus = joined;");
    const block = source.slice(assignIdx, assignIdx + 2600);
    expect(block).toContain("const selAtJoin = currentSel;");
    expect(block).toContain("opts.makeAgentDeps(selAtJoin, liveSlateSession, busClientRef)");
    expect(block).toContain("currentSel === selAtJoin");
  });

  test("busClientRef is a live getter, not a captured value, threaded through every real opts.makeAgentDeps call that needs the bus", () => {
    expect(source).toContain("const busClientRef = { client: (): BusClient | undefined => liveBus };");
    // review r1 F9: the side-worker call site no longer passes busClientRef.
    expect((source.match(/opts\.makeAgentDeps\([^)]*busClientRef\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  // review r1 F9: a side worker must not even be told the session is
  // bus-joined — it answers a transient status question and never speaks on
  // the session's own bus identity.
  test("the side-worker deps rebuild passes no bus getter at all (review r1 F9)", () => {
    const baseIdx = source.indexOf("const base = await opts.makeAgentDeps(");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    const block = source.slice(baseIdx, baseIdx + 200);
    expect(block).toContain("opts.makeAgentDeps(currentSel, liveSlateSession, undefined)");
  });

  // review r1 F10: an operator gets one notice per overflow episode, never
  // one per dropped event.
  test("the inbox is created with onDrop wired to the throttled drop notifier (review r1 F10)", () => {
    expect(source).toContain(
      "const busInbox: BusInbox = createBusInbox({ onDrop: (droppedTotal) => busDropNotifier.onDrop(droppedTotal) });",
    );
    expect(source).toContain(
      "busDropNotifier = createBusDropNotifier((droppedTotal) => io.onSystem?.(busInboxFullNotice(droppedTotal)));",
    );
  });
});
