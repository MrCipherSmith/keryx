// Flow 273 (agent bus P2, T7): the TUI's join/status/render wiring.
//
// Pure helpers, driven without a renderer, plus source-text audits for the
// wiring points a renderer-less test cannot reach (join, leave, setSession) —
// same style `tui-session-lease.test.ts` uses for `sessionLease.release()`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyBusyDispatch } from "./busy-dispatch";
import { formatBusEventLine, formatBusLeasesLines, formatBusLogLines, formatBusPeersLines } from "./bus-panel";
import { parseBusCommand } from "./bus-command";
import { formatFleetSidebarWithPeers, type FleetPeer, type FleetWorker } from "./worker-fleet";
import type { BusPeer } from "../bus/client";
import type { BusEvent, PauseLease, PresenceRecord } from "../bus/schema";

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
      { name: "release", state: "live", activity: "flow 190" },
      { name: "qa", state: "stale", activity: "" },
    ];
    const text = formatFleetSidebarWithPeers(workers, peers, 12);
    const peersAt = text.indexOf("Peers");
    expect(peersAt).toBeGreaterThan(0);
    expect(text.slice(0, peersAt)).toContain("Working");
    expect(text).toContain("● @release");
    expect(text).toContain("flow 190");
    expect(text).toContain("◌ @qa");
  });

  test("more peers than fit are counted, not silently dropped", () => {
    const many: FleetPeer[] = Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, state: "live" as const, activity: "" }));
    const text = formatFleetSidebarWithPeers([], many, 5);
    expect(text).toMatch(/… \+\d+ more/);
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

describe("formatBusEventLine (specification §5.2: transcript rendering)", () => {
  test("renders ⇄ @from kind: preview", () => {
    expect(formatBusEventLine("release", "notice", "ready for review")).toBe("⇄ @release notice: ready for review");
  });

  test("an empty preview still renders the from/kind, just with nothing after the colon", () => {
    expect(formatBusEventLine("release", "handoff", "")).toBe("⇄ @release handoff: ");
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

  test("Log: no events says so", () => {
    expect(formatBusLogLines([])).toEqual(["No events yet."]);
  });
});

describe("tui-shell.ts wiring (source-text audit — a renderer-less test cannot reach these)", () => {
  test("onDestroy (Ctrl+C) leaves the bus, next to releasing the session lease", () => {
    const start = source.indexOf("onDestroy: () => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("void (async () => {", start));
    expect(body).toContain("sessionLease.release();");
    expect(body).toContain("liveBus?.leave();");
  });

  test("/exit and the busy-menu exit leave the bus before destroying the renderer", () => {
    for (const marker of ['if (command.name === "/exit") {', 'case "exit": {']) {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = source.slice(start, source.indexOf("r.destroy();", start));
      expect(block).toContain("sessionLease.release();");
      expect(block).toContain("liveBus?.leave();");
    }
  });

  test("the outer finally leaves the bus", () => {
    const tail = source.slice(source.lastIndexOf("} finally {"));
    expect(tail).toContain("sessionLease.release();");
    expect(tail).toContain("liveBus?.leave();");
  });

  test("applyOpened (startup picker, fork/view/cancel, /resume) updates presence.sessionId", () => {
    const start = source.indexOf("const applyOpened = (");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("const pickRecentSession", start));
    expect(body).toContain("liveBus?.setSession(opened.handle.summary.id)");
  });

  test("startNewSession (/new, /clear) updates presence.sessionId outside applyOpened", () => {
    const start = source.indexOf("const startNewSession = (");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("const resumeSessionInteractive", start));
    expect(body).toContain("liveBus?.setSession(liveSession.summary.id)");
  });

  test("resumeSessionInteractive (/resume, /sessions) goes through applyOpened, not a second setSession call", () => {
    const start = source.indexOf("const resumeSessionInteractive = ");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("paintSessionHeader();\n\n", start));
    expect(body).toContain("applyOpened(opened, true);");
  });

  test("the join call passes surface tui, the session lease, and status from herdrStateFor", () => {
    const start = source.indexOf("await joinBus({");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("});", start));
    expect(block).toContain('surface: "tui"');
    expect(block).toContain("sessionLease: sessionLease.current");
    expect(block).toContain("herdrStateFor(lastMainAgentStatus)");
    expect(block).toContain("opts.session?.busName");
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

  test("/bus is dispatched both while busy and not busy, through the one runBusCommand", () => {
    expect(source).toContain('case "bus": {');
    expect(source).toContain('if (command.name === "/bus") {');
    expect((source.match(/runBusCommand\(line\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
