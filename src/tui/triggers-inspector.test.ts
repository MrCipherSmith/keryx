// Flow 300 T7 — AC5 (the modal's detail, and the CLI and the modal printing
// the same descriptor for the same entry) and AC6's modal half (r arms, y
// confirms, any other key cancels; disabled/rejected cannot be armed; running…
// then the new ledger record and the child's output tail).

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describeEntry, describeOpenReservation, NETWORK_ON_WARNING, UNATTENDED_ROSTER_DESCRIPTION } from "../trigger/describe";
import { formatModalFooter, MODAL_PANEL_INNER_WIDTH } from "./modal-host";
import { GOVERNANCE_FOOTER } from "./governance-inspector";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { findEntry, loadTriggerLedgerView } from "./trigger-ledger";
import { armPrompt, formatTriggerDetailLines, openTriggers, STATUS_ROWS, TRIGGERS_FOOTER, type TriggerModalItem } from "./triggers-inspector";
import type { TriggerRunNow, TriggerRunNowResult } from "./trigger-run-now";
import {
  appendRuns,
  chunkColors,
  CLI,
  DISPATCH_NET,
  findById,
  keypressSource,
  loadOpenTui,
  makeProject,
  mountChrome,
  settle,
  writeTriggers,
} from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await makeProject("keryx-trgmodal-");
  roots.push(root);
  await writeTriggers(root, [
    { name: "rebuild", on: { kind: "event", event: "post-merge" }, action: { kind: "rebuild" } },
    { name: "work-flow", on: { kind: "event", event: "ci" }, action: { kind: "flow-next", flow: "001", dispatch: DISPATCH_NET } },
    { name: "sync-off", on: { kind: "event", event: "post-commit" }, action: { kind: "reconcile" }, enabled: false },
    { name: "broken", on: { kind: "event", event: "nope" }, action: { kind: "rebuild" } },
  ]);
  await appendRuns(root, [
    {
      at: "2026-09-23T11:30:00.000Z",
      trigger: "work-flow",
      firedBy: { kind: "event", event: "ci" },
      action: { kind: "flow-next", flow: "001" },
      outcome: "reserved",
      detail: "reserved $0.5",
      cost: { recorded: false, reason: "reservation" },
      reservation: { runId: "trg-abc", usd: 0.5 },
    },
    {
      at: "2026-09-22T11:00:00.000Z",
      trigger: "work-flow",
      firedBy: { kind: "event", event: "ci" },
      action: { kind: "flow-next", flow: "001" },
      outcome: "dispatch-refused",
      detail: "flow 001 is not in progress",
      cost: { recorded: false, reason: "refused before any model call" },
      dispatch: { runId: "trg-old", flow: "001", refusal: "flow-not-in-progress", denials: [{ tool: "shell_exec", reason: "ask mode" }] },
    },
  ]);
  return root;
}

/**
 * Run the real `keryx trigger` CLI as a child process, pinned to its OWN
 * isolated config dir under `root` rather than inheriting whatever
 * `XDG_DATA_HOME`/`APPDATA` the parent `bun test` process happens to have —
 * belt-and-braces on top of `test-preload.ts`'s own redirect, so this test
 * never depends on that shared, run-wide temp root staying uncontended.
 */
function cli(root: string, ...args: string[]): string {
  const configDir = path.join(root, ".keryx-home");
  return execFileSync(process.execPath, [CLI, "trigger", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_DATA_HOME: configDir, APPDATA: configDir },
  });
}

// Two real `bun src/cli.ts …` child processes, unbundled (no prebuilt dist),
// so each spawn pays real module-resolution/transpile cost on top of process
// start — measured ~300ms/call on a quiet Linux box, and slower still on a
// loaded macOS CI runner. `waitForFrame`-style pass budgets don't apply here
// (no renderer at all); bun's 5s default test timeout is the only bound, and
// two cold spawns plus fixture setup can run close enough to it under CI
// contention to flake. Widened, justified by the real subprocess work above,
// not lowered coverage.
test("AC5: the CLI and the modal print the SAME descriptor for the same entry (shared formatter, not a copy)", async () => {
  const root = await fixture();
  const view = await loadTriggerLedgerView(root);
  const status = cli(root, "status");
  const list = cli(root, "list");
  for (const name of ["rebuild", "work-flow", "sync-off"]) {
    const entry = findEntry(view, name)!;
    const descriptor = describeEntry(entry.entry);
    expect(status).toContain(`  - ${descriptor}\n`);
    expect(list).toContain(`  - ${descriptor}  hook: `);
    const item: TriggerModalItem = { kind: "entry", view: entry, hook: "n/a" };
    expect(formatTriggerDetailLines(item, view, undefined)[0]).toBe(descriptor);
  }
  // The open reservation line, byte for byte.
  const reservation = view.openReservations[0]!;
  expect(status).toContain(`  ${describeOpenReservation(reservation)}\n`);
}, 20_000);

test("AC5: detail — fire, action, hook, full dispatch posture with the NETWORK ON warning, runs with cost/refusal/denials, reservation with its resolve command", async () => {
  const root = await fixture();
  const view = await loadTriggerLedgerView(root);
  const entry = findEntry(view, "work-flow")!;
  const lines = formatTriggerDetailLines({ kind: "entry", view: entry, hook: "n/a (ci — fired by a CI job's own `keryx trigger run` call)" }, view, undefined);
  const text = lines.join("\n");
  expect(text).toContain("fire     event:ci");
  expect(text).toContain("hook     n/a (ci");
  expect(text).toContain("provider/model   anthropic/claude-x");
  expect(text).toContain("permission mode  ask");
  expect(text).toContain("ceiling          $1");
  expect(text).toContain("max seconds      600");
  expect(text).toContain("max attempts     2");
  expect(text).toContain(`roster           ${UNATTENDED_ROSTER_DESCRIPTION}`);
  expect(text).toContain(`network          NETWORK ON — ${NETWORK_ON_WARNING}`);
  expect(text).toContain("dispatch-refused — flow 001 is not in progress  [cost: not recorded (refused before any model call)]");
  expect(text).toContain("refusal: flow-not-in-progress");
  expect(text).toContain("denials: shell_exec: ask mode");
  expect(text).toContain("keryx trigger resolve trg-abc --spent <usd>");
});

function fakeRunNow(): TriggerRunNow & { started: string[]; finish(result: Partial<TriggerRunNowResult>): void } {
  const started: string[] = [];
  let resolve: ((r: TriggerRunNowResult) => void) | undefined;
  let current: string | undefined;
  return {
    started,
    run(name) {
      if (current !== undefined) return undefined;
      started.push(name);
      current = name;
      return new Promise<TriggerRunNowResult>((r) => {
        resolve = r;
      });
    },
    running: () => new Set(current === undefined ? [] : [current]),
    dispose: () => [],
    inFlightRuns: () => [],
    finish(result) {
      const name = current ?? "?";
      current = undefined;
      resolve?.({ name, argv: ["bun", "cli.ts", "trigger", "run", name], exitCode: 0, output: "", logPath: "/tmp/x.log", startedAt: "2026-09-23T00:00:00.000Z", endedAt: "x", ...result });
    },
  };
}

otuiTest("AC6: r arms, any other key cancels, y confirms; disabled and rejected entries cannot be armed and say why", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const root = await fixture();
  const runNow = fakeRunNow();
  const modal = openTriggers(otui.core, h.chrome, { cwd: root, runNow, onKeypress: keypressSource(h.renderer) });
  try {
    await modal!.ready;
    expect(modal!.selectedName()).toBe("rebuild");

    h.mockInput.pressKey("r");
    await settle(h);
    expect(modal!.status()).toContain("run rebuild now (keryx trigger run rebuild)? y to confirm");
    h.mockInput.pressKey("q"); // any other key
    await settle(h);
    expect(modal!.status()).toBe("run-now of rebuild cancelled");
    expect(runNow.started).toEqual([]);

    // Disabled: `]` to sync-off, r refuses with the reason.
    h.mockInput.pressKey("]");
    h.mockInput.pressKey("]");
    await settle(h);
    expect(modal!.selectedName()).toBe("sync-off");
    h.mockInput.pressKey("r");
    await settle(h);
    expect(modal!.status()).toContain("cannot run: sync-off is disabled");
    // Rejected: the malformed entry is listed, and cannot be armed either.
    h.mockInput.pressKey("]");
    await settle(h);
    expect(modal!.selectedName()).toBe("broken");
    h.mockInput.pressKey("r");
    await settle(h);
    expect(modal!.status()).toContain("cannot run: broken is malformed and cannot run: on.event: unknown event");
    h.mockInput.pressKey("y"); // not armed — y does nothing
    await settle(h);
    expect(runNow.started).toEqual([]);

    // Back to rebuild; arm; confirm.
    h.mockInput.pressKey("[");
    h.mockInput.pressKey("[");
    h.mockInput.pressKey("[");
    h.mockInput.pressKey("r");
    h.mockInput.pressKey("y");
    await settle(h);
    expect(runNow.started).toEqual(["rebuild"]);
    expect(modal!.status()).toBe("running rebuild… (keryx trigger run rebuild)");

    // The child ends: the modal re-reads the ledger and shows the new record + output tail.
    await appendRuns(root, [
      {
        at: "2026-09-23T13:00:00.000Z",
        trigger: "rebuild",
        firedBy: { kind: "event", event: "post-merge" },
        action: { kind: "rebuild" },
        outcome: "lock-refused",
        detail: "another keryx run holds this project's maintenance lock",
        cost: { recorded: false, reason: "run was refused before the action could start" },
      },
    ]);
    runNow.finish({ output: "keryx trigger run rebuild: another keryx run holds the lock\n" });
    await modal!.settled();
    expect(modal!.status()).toBe("rebuild: lock-refused — another keryx run holds this project's maintenance lock");
    modal!.setTab("detail");
    await settle(h);
    const detail = modal!.visibleLines().join("\n");
    expect(detail).toContain("rebuild  [enabled]  event:post-merge  -> rebuild");
    for (let i = 0; i < 10; i += 1) h.mockInput.pressArrow("down");
    await settle(h);
    const tail = modal!.visibleLines().join("\n");
    expect(tail).toContain("Last run-now (exit 0) — trigger run rebuild");
    expect(tail).toContain("keryx trigger run rebuild: another keryx run holds the lock");

    expect(h.captureCharFrame()).toContain(formatModalFooter(TRIGGERS_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("AC10: a /theme switch recolours the open triggers modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const root = await fixture();
  const before = getThemeId();
  applyThemeId("groknight");
  const modal = openTriggers(otui.core, h.chrome, { cwd: root, runNow: fakeRunNow(), onKeypress: keypressSource(h.renderer) });
  try {
    await modal!.ready;
    const dark = chunkColors(findById(h.renderer.root, "trg-status"));
    expect(dark[0]).toBe(roleColor("muted").toLowerCase());
    applyThemeId("grokday");
    const light = chunkColors(findById(h.renderer.root, "trg-status"));
    expect(light[0]).toBe(roleColor("muted").toLowerCase());
    expect(light[0]).not.toBe(dark[0]);
  } finally {
    applyThemeId(before);
    modal?.close();
    h.destroy();
  }
});

test("AC8: both modals' footers list their keys and fit the narrowest panel", () => {
  for (const footer of [TRIGGERS_FOOTER, GOVERNANCE_FOOTER]) {
    expect(formatModalFooter(footer).length).toBeLessThanOrEqual(MODAL_PANEL_INNER_WIDTH);
  }
  expect(formatModalFooter(TRIGGERS_FOOTER)).toContain("r run");
  expect(formatModalFooter(TRIGGERS_FOOTER)).toContain("y confirm");
  expect(formatModalFooter(GOVERNANCE_FOOTER)).toContain("r re-run");
});

otuiTest("review F9: `/triggers <typo>` stays on the list and says `no trigger named`", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const root = await fixture();
  const modal = openTriggers(otui.core, h.chrome, { cwd: root, runNow: fakeRunNow(), onKeypress: keypressSource(h.renderer), initialName: "rebiuld" });
  try {
    await modal!.ready;
    expect(modal!.activeTab()).toBe("list");
    expect(modal!.status()).toBe('no trigger named "rebiuld"');
  } finally {
    modal?.close();
    h.destroy();
  }
});

test("review F10: the arm prompt of a dispatching entry names its ceiling and NETWORK ON; the status block is two lines", async () => {
  const root = await fixture();
  const view = await loadTriggerLedgerView(root);
  const net = armPrompt({ kind: "entry", view: findEntry(view, "work-flow")!, hook: "n/a" });
  expect(net).toContain("ceiling $1");
  expect(net).toContain("NETWORK ON");
  const plain = armPrompt({ kind: "entry", view: findEntry(view, "rebuild")!, hook: "n/a" });
  expect(plain).toBe("run rebuild now (keryx trigger run rebuild)? y to confirm · any other key cancels");
  expect(STATUS_ROWS).toBe(2);
});

otuiTest("review F11: while a composer choice or permission prompt owns the keyboard, the modal ignores `r` and `y`", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const root = await fixture();
  const runNow = fakeRunNow();
  let blocked = true;
  const modal = openTriggers(otui.core, h.chrome, {
    cwd: root,
    runNow,
    onKeypress: keypressSource(h.renderer),
    inputBlocked: () => blocked,
  });
  try {
    await modal!.ready;
    const before = modal!.status();
    h.mockInput.pressKey("r");
    h.mockInput.pressKey("y");
    await settle(h);
    expect(runNow.started).toEqual([]);
    expect(modal!.status()).toBe(before);
    blocked = false;
    h.mockInput.pressKey("r");
    await settle(h);
    expect(modal!.status()).toContain("run rebuild now");
  } finally {
    modal?.close();
    h.destroy();
  }
});
