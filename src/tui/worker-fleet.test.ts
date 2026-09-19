import { expect, test } from "bun:test";
import {
  formatFleetSidebar,
  formatFleetSidebarWithPeers,
  humanFleetPhase,
  MAIN_AGENT_ID,
  mainHeadline,
  shortWorkerLabel,
  WorkerFleet,
  type FleetPeer,
} from "./worker-fleet";

test("shortWorkerLabel strips path and .md", () => {
  expect(shortWorkerLabel("components/src-wiki.md")).toBe("src-wiki");
  expect(shortWorkerLabel("src-foo")).toBe("src-foo");
});

test("humanFleetPhase maps cryptic keys to readable phrases", () => {
  expect(humanFleetPhase("blocked", "approval")).toBe("shell permission");
  expect(humanFleetPhase("blocked", "ask")).toBe("answer a question");
  expect(humanFleetPhase("running", "thinking")).toBe("thinking…");
  expect(humanFleetPhase("running", "streaming")).toBe("writing reply…");
  expect(humanFleetPhase("running", "shell_exec")).toBe("tool: shell_exec");
  expect(humanFleetPhase("queued", "idle")).toBe("ready");
  expect(mainHeadline("blocked")).toContain("Waiting for you");
});

test("formatFleetSidebar idle and blocked main are human-readable", () => {
  expect(formatFleetSidebar([])).toContain("Ready");

  const blocked = formatFleetSidebar([
    { id: MAIN_AGENT_ID, label: "main", status: "blocked", detail: "approval" },
  ]);
  expect(blocked).toContain("Waiting for you");
  expect(blocked).toContain("shell permission");
  expect(blocked).toMatch(/pick menu above input/i);
  // Must NOT claim "run" for a user wait.
  expect(blocked).not.toMatch(/\d+ run/);
});

test("formatFleetSidebar fleet counts busy not wait-as-run", () => {
  const text = formatFleetSidebar([
    { id: MAIN_AGENT_ID, label: "main", status: "running", detail: "thinking" },
    { id: "a", label: "page-a", status: "done" },
    { id: "b", label: "page-b", status: "running", detail: "model" },
    { id: "c", label: "page-c", status: "failed", detail: "validate" },
    { id: "d", label: "page-d", status: "queued" },
  ]);
  expect(text).toContain("Working");
  expect(text).toContain("thinking");
  expect(text).toMatch(/Fleet/);
  expect(text).toMatch(/busy/);
  expect(text).toMatch(/ok/);
  expect(text).toMatch(/fail/);
  // running glyph appears for page workers
  expect(text).toContain("◐");
});

test("formatFleetSidebar pins main agent first", () => {
  const text = formatFleetSidebar([
    { id: "z", label: "page-z", status: "running", detail: "model" },
    { id: MAIN_AGENT_ID, label: "main", status: "running", detail: "thinking" },
    { id: "a", label: "page-a", status: "queued" },
  ]);
  const headIdx = text.indexOf("Working");
  const pageIdx = text.indexOf("page-z");
  expect(headIdx).toBeGreaterThanOrEqual(0);
  expect(headIdx).toBeLessThan(pageIdx);
});

test("WorkerFleet upsert and subscribe", () => {
  const fleet = new WorkerFleet();
  let n = 0;
  const unsub = fleet.subscribe(() => {
    n += 1;
  });
  fleet.upsert({ id: "w1", label: "one", status: "queued" });
  fleet.upsert({ id: "w1", label: "one", status: "running", detail: "model" });
  expect(fleet.list()).toHaveLength(1);
  expect(fleet.list()[0]?.status).toBe("running");
  expect(n).toBe(2);
  fleet.clear();
  expect(fleet.list()).toHaveLength(0);
  unsub();
});

// review r1 F3/F11: `FleetPeer.name`/`activity` are bus-peer-supplied free
// text (specification §4.1), and the line also carries the peer's own
// live/stale AND working/idle status (F11) — see `tui-bus.test.ts` for the
// fuller `formatFleetSidebarWithPeers` coverage (name/status/activity
// composition, the unrecognized-status fallback). This is the escape-sequence
// guard on its own, in the module that owns the sidebar's peer line.
test("a peer's name and activity never paint an escape sequence into the sidebar", () => {
  const ESC = "\x1b";
  const peers: FleetPeer[] = [
    { name: `evil${ESC}[31mname`, state: "live", status: "working", activity: `hi${ESC}]0;pwned${ESC}\\there` },
  ];
  const text = formatFleetSidebarWithPeers([], peers, 12);
  expect(text).not.toContain(ESC);
  expect(text).toContain("evilname");
});

test("WorkerFleet clearMatching keeps side workers", () => {
  const fleet = new WorkerFleet();
  fleet.upsert({ id: MAIN_AGENT_ID, label: "main", status: "running" });
  fleet.upsert({ id: "side:1", label: "side-1", status: "running" });
  fleet.upsert({ id: "page-a", label: "page-a", status: "queued" });
  fleet.clearMatching((w) => w.id !== MAIN_AGENT_ID && !w.id.startsWith("side:"));
  const ids = fleet.list().map((w) => w.id).sort();
  expect(ids).toEqual([MAIN_AGENT_ID, "side:1"].sort());
});
