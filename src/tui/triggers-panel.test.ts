// Flow 300 T7 — AC4: the Triggers section over fixture triggers.json +
// runs.jsonl, and the AC10 theme half for it.

import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { loadTriggerLedgerView } from "./trigger-ledger";
import { mountTriggersPanel, NET_MARKER, projectTriggersPanel } from "./triggers-panel";
import {
  appendRuns,
  chunkColors,
  clickNode,
  DISPATCH_NET,
  findById,
  loadOpenTui,
  makeProject,
  mountChrome,
  textOf,
  writeTriggers,
} from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const root = await makeProject("keryx-trgpanel-");
  roots.push(root);
  return root;
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

/** Three event triggers (one with network), one schedule, one rejected, a ledger with spend and an open reservation. */
async function fixture(): Promise<string> {
  const root = await project();
  await writeTriggers(root, [
    { name: "rebuild-on-merge", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
    { name: "work-flow", on: { kind: "event", event: "ci" }, action: { kind: "flow-next", flow: "001", dispatch: DISPATCH_NET } },
    { name: "sync-off", on: { kind: "event", event: "post-commit" }, action: { kind: "reconcile" }, enabled: false },
    { name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "reconcile" } },
    { name: "broken", on: { kind: "event", event: "nope" }, action: { kind: "rebuild" } },
  ]);
  await appendRuns(root, [
    {
      at: "2026-09-23T09:00:00.000Z",
      trigger: "rebuild-on-merge",
      firedBy: { kind: "event", event: "post-merge" },
      action: { kind: "rebuild" },
      outcome: "ok",
      detail: "done",
      cost: { recorded: false, reason: "no model" },
    },
    {
      at: "2026-09-23T11:30:00.000Z",
      trigger: "work-flow",
      firedBy: { kind: "event", event: "ci" },
      action: { kind: "flow-next", flow: "001" },
      outcome: "reserved",
      detail: "reserved $0.5",
      cost: { recorded: false, reason: "reservation" },
      reservation: { runId: "trg-1", usd: 0.5 },
    },
    {
      at: "2026-09-22T11:00:00.000Z",
      trigger: "nightly",
      firedBy: { kind: "schedule", cron: "0 2 * * *" },
      action: { kind: "reconcile" },
      outcome: "ok",
      detail: "done",
      cost: { recorded: true, usd: 0.25 },
    },
  ]);
  return root;
}

test("AC4: hidden when triggers.json is absent", async () => {
  const view = await loadTriggerLedgerView(await project());
  expect(projectTriggersPanel(view, { width: SIDEBAR_TEXT_WIDTH, now: NOW })).toEqual({ visible: false, rows: [] });
});

test("AC4: a config that cannot be read is ONE error row", async () => {
  const root = await project();
  await writeFile(path.join(root, ".metaproject", "triggers.json"), "{ nope", "utf8");
  const p = projectTriggersPanel(await loadTriggerLedgerView(root), { width: SIDEBAR_TEXT_WIDTH, now: NOW });
  expect(p.rows).toHaveLength(1);
  expect(p.rows[0]?.chunks).toEqual([{ role: "error", text: "config unreadable (not-json)" }]);
});

test("AC4: spend (unrecorded never folded into $0), reservations, one row per EVENT trigger, NET marker, N scheduled", async () => {
  const p = projectTriggersPanel(await loadTriggerLedgerView(await fixture()), { width: SIDEBAR_TEXT_WIDTH, now: NOW });
  const text = (id: string) => p.rows.find((r) => r.id === id)?.chunks.map((c) => c.text).join("");
  expect(text("sb-triggers-spend")).toBe("spent $0.25 · 2 not recorded");
  expect(p.rows.find((r) => r.id === "sb-triggers-reservations")?.chunks).toEqual([{ role: "attention", text: "! 1 open reservation" }]);
  // 34 columns would not fit in 30: the NAME is shortened, the outcome kept whole.
  expect(text("sb-triggers-rebuild-on-merge")).toBe("rebuild-on-… · enabled · ok 3h");
  expect(text("sb-triggers-sync-off")).toBe("sync… · disabled · never fired");
  const net = p.rows.find((r) => r.id === "sb-triggers-work-flow");
  expect(net?.chunks[0]).toEqual({ role: "attention", text: `${NET_MARKER} ` });
  expect(text("sb-triggers-work-flow")).toContain("reserved 30m");
  // Schedule-fired: no row of its own, only the count (flow 295 owns the rows).
  expect(p.rows.some((r) => r.id === "sb-triggers-nightly")).toBe(false);
  expect(text("sb-triggers-scheduled")).toBe("1 scheduled");
  for (const row of p.rows) expect(row.chunks.map((c) => c.text).join("").length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
  // A row's click opens that trigger.
  expect(p.rows.find((r) => r.id === "sb-triggers-rebuild-on-merge")?.target).toEqual({ kind: "trigger", name: "rebuild-on-merge" });
});

otuiTest("AC4: mounted — rows painted from the fixture; a click on a trigger row opens THAT trigger", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const root = await fixture();
  const opened: Array<string | undefined> = [];
  const panel = mountTriggersPanel(otui.core, h.renderer, h.chrome.sidebarTop, {
    cwd: root,
    width: SIDEBAR_TEXT_WIDTH,
    onOpen: (name) => opened.push(name),
    now: () => NOW,
  });
  try {
    await panel.refresh();
    expect(textOf(findById(h.chrome.sidebarTop, "sb-triggers-k"))).toBe("Triggers");
    expect(textOf(findById(h.chrome.sidebarTop, "sb-triggers-rebuild-on-merge"))).toBe("rebuild-on-… · enabled · ok 3h");
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-triggers-rebuild-on-merge"));
    await clickNode(h, findById(h.chrome.sidebarTop, "sb-triggers-k"));
    expect(opened).toEqual(["rebuild-on-merge", undefined]);
  } finally {
    panel.dispose();
    h.destroy();
  }
});

otuiTest("AC10: a /theme switch recolours the Triggers section (theme roles, no fixed hex)", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const root = await fixture();
  const before = getThemeId();
  applyThemeId("groknight");
  const panel = mountTriggersPanel(otui.core, h.renderer, h.chrome.sidebarTop, { cwd: root, width: SIDEBAR_TEXT_WIDTH, onOpen: () => {}, now: () => NOW });
  try {
    await panel.refresh();
    const dark = chunkColors(findById(h.chrome.sidebarTop, "sb-triggers-work-flow"));
    expect(dark[0]).toBe(roleColor("attention").toLowerCase());
    applyThemeId("grokday");
    const light = chunkColors(findById(h.chrome.sidebarTop, "sb-triggers-work-flow"));
    expect(light[0]).toBe(roleColor("attention").toLowerCase());
    expect(light[0]).not.toBe(dark[0]);
  } finally {
    applyThemeId(before);
    panel.dispose();
    h.destroy();
  }
});
