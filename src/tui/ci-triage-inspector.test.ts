// Flow 306 (AC12): the `/ci` modal, driven by real keypresses.

import { afterEach, expect, test } from "bun:test";
import { computeCiTriageVerdict } from "../review/ci-triage";
import {
  CI_TRIAGE_FOOTER,
  formatCiTriageDetailLines,
  formatCiTriageListLines,
  openCiTriage,
  type CiTriageJobItem,
  type CiTriageListRead,
  type CiTriageRunResult,
} from "./ci-triage-inspector";
import { formatModalFooter } from "./modal-host";
import { applyThemeId, getThemeId, roleColor } from "./theme";
import { chunkColors, findById, keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const ITEMS: readonly CiTriageJobItem[] = [
  { runId: "1", jobName: "typecheck-and-tests", workflowName: "CI", headBranch: "feat/x", conclusion: "failure", createdAt: "2026-09-25T04:36:33Z" },
  { runId: "2", jobName: "opentui native (linux-x64)", workflowName: "CI", headBranch: "feat/x", conclusion: "failure", createdAt: "2026-09-24T00:00:00Z" },
];

test("formatCiTriageListLines: marks the selected row and shows conclusion, run, workflow/branch and state", () => {
  const lines = formatCiTriageListLines(ITEMS, new Map(), 0);
  expect(lines[0]).toContain(">");
  expect(lines[0]).toContain("typecheck-and-tests");
  expect(lines[0]).toContain("[failure]");
  expect(lines[0]).toContain("run 1");
  expect(lines[0]).toContain("CI/feat/x");
  expect(lines[0]).toContain("not triaged — press t");
  expect(lines[1]?.startsWith(" ")).toBe(true);
});

test("formatCiTriageListLines: an empty item list says so", () => {
  expect(formatCiTriageListLines([], new Map(), 0)).toEqual(["No failed CI runs found for the current branch's pull request."]);
});

test("formatCiTriageDetailLines: no selection, idle, triaging, error and done states each read distinctly", () => {
  expect(formatCiTriageDetailLines(undefined, undefined)[0]).toBe("No job selected.");
  expect(formatCiTriageDetailLines(ITEMS[0], undefined)[0]).toContain("has not been triaged yet");
  expect(formatCiTriageDetailLines(ITEMS[0], { kind: "triaging" })[0]).toContain("Triaging");
  expect(formatCiTriageDetailLines(ITEMS[0], { kind: "error", reason: "boom" }).join("\n")).toContain("boom");
  const verdict = computeCiTriageVerdict({ flaky: { noul: 0.8 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.1 } });
  const done = formatCiTriageDetailLines(ITEMS[0], { kind: "done", verdict }).join("\n");
  expect(done).toContain("ADVISORY ONLY");
  expect(done).toContain("top: flaky");
});

test("flow 307 AC4: the detail view shows the signal lines as evidence, verdict still labelled advisory", () => {
  const verdict = computeCiTriageVerdict({ flaky: { noul: 0.7 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.2 } });
  const done = formatCiTriageDetailLines(ITEMS[0], {
    kind: "done",
    verdict,
    signalLines: ["rerun: 0 prior attempt(s) checked; no earlier attempt of this job passed.", "log markers: none detected."],
  }).join("\n");
  expect(done).toContain("ADVISORY ONLY");
  expect(done).toContain("evidence (computed signals, before Jev):");
  expect(done).toContain("rerun: 0 prior attempt(s) checked");
  expect(done).toContain("log markers: none detected.");
});

test("flow 306 review item 1: a timeout state reads distinctly from a generic error, in both the list row and the detail", () => {
  const listLine = formatCiTriageListLines(ITEMS, new Map([["1:typecheck-and-tests", { kind: "timeout" as const }]]), 0);
  expect(listLine[0]).toContain("timed out — r to retry");
  const detail = formatCiTriageDetailLines(ITEMS[0], { kind: "timeout" }).join("\n");
  expect(detail).toContain("timed out");
  expect(detail).toContain("r to retry");
});

const roots: string[] = [];
afterEach(() => {
  roots.length = 0;
});

async function load(): Promise<CiTriageListRead> {
  return { items: ITEMS };
}

otuiTest("AC12: lists failed jobs, `t` triages the selected one, enter opens its detail labelled advisory", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const verdict = computeCiTriageVerdict({ flaky: { noul: 0.74 }, infra: { noul: 0.05 }, "real-regression": { noul: 0.21 } });
  let triaged: CiTriageJobItem | undefined;
  const modal = openCiTriage(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    load,
    triage: async (_cwd, item) => {
      triaged = item;
      return { ok: true, verdict, testName: "src/x.test.ts:1" };
    },
    visibleRows: 10,
  });
  try {
    expect(modal).toBeDefined();
    await modal!.ready;
    expect(modal!.visibleLines()[0]).toContain("typecheck-and-tests");
    expect(modal!.selected()?.jobName).toBe("typecheck-and-tests");

    h.mockInput.pressKey("t");
    await settle(h);
    await modal!.settled();
    expect(triaged?.jobName).toBe("typecheck-and-tests");
    expect(modal!.visibleLines()[0]).toContain("flaky 74% (advisory)");

    await h.mockInput.pressEnter();
    await settle(h);
    const detail = modal!.visibleLines().join("\n");
    expect(detail).toContain("ADVISORY ONLY");
    expect(detail).toContain("top: flaky");
    expect(detail).toContain("flaky: 74%");

    expect(h.captureCharFrame()).toContain(formatModalFooter(CI_TRIAGE_FOOTER));
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("AC12: a triage failure is shown, not swallowed", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openCiTriage(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    load,
    triage: async () => ({ ok: false, reason: "OPENROUTER_API_KEY is not set" }),
    visibleRows: 10,
  });
  try {
    await modal!.ready;
    h.mockInput.pressKey("t");
    await settle(h);
    await modal!.settled();
    expect(modal!.visibleLines()[0]).toContain("error: OPENROUTER_API_KEY is not set");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("flow 306 review item 1: `r` retries a selected item exactly like `t`", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const verdict = computeCiTriageVerdict({ flaky: { noul: 0.6 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.3 } });
  let calls = 0;
  const modal = openCiTriage(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    load,
    triage: async () => {
      calls += 1;
      return { ok: true, verdict };
    },
    visibleRows: 10,
  });
  try {
    await modal!.ready;
    h.mockInput.pressKey("r");
    await settle(h);
    await modal!.settled();
    expect(calls).toBe(1);
    expect(modal!.visibleLines()[0]).toContain("flaky 60% (advisory)");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("flow 306 review items 1/3: closing the modal mid-triage aborts the signal; the late response causes no crash and no stale paint", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let capturedSignal: AbortSignal | undefined;
  let resolveTriage: ((result: CiTriageRunResult) => void) | undefined;
  const pending = new Promise<CiTriageRunResult>((resolve) => {
    resolveTriage = resolve;
  });
  const modal = openCiTriage(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    load,
    triage: async (_cwd, _item, signal) => {
      capturedSignal = signal;
      return pending;
    },
    visibleRows: 10,
  });
  try {
    await modal!.ready;
    h.mockInput.pressKey("t");
    await settle(h);
    expect(modal!.visibleLines()[0]).toContain("triaging…");
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    modal!.close();
    // The whole point of item 1/3: the modal does not merely stop LISTENING
    // to the request, it actually cancels it.
    expect(capturedSignal!.aborted).toBe(true);

    // The in-flight call "comes back" after close, as a real abort racing a
    // late response would. Awaiting it here is the "no crash" assertion:
    // if `runTriage`'s `.then()` handler touched a destroyed renderable or
    // threw on a closed modal, this would reject or throw instead of
    // resolving quietly.
    resolveTriage!({ ok: false, reason: "aborted", timedOut: true });
    await modal!.settled();
    // No live renderable is left to paint into — `findById` on a closed
    // modal's panel finds nothing, which is the "no stale paint" half: there
    // is nothing on screen a late response could have overwritten.
    expect(findById(h.renderer.root, "ci-triage-body")).toBeUndefined();
  } finally {
    h.destroy();
  }
});

otuiTest("no failed runs: the note is shown instead of an empty panel", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openCiTriage(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    load: async () => ({ items: [], note: "review.jev.ci_triage is not enabled for this project" }),
    triage: async () => ({ ok: false, reason: "unused" }),
    visibleRows: 10,
  });
  try {
    await modal!.ready;
    expect(modal!.visibleLines()[0]).toContain("not enabled for this project");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("a /theme switch recolours the open modal", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const before = getThemeId();
  applyThemeId("groknight");
  const modal = openCiTriage(otui.core, h.chrome, {
    cwd: "/tmp/does-not-matter",
    onKeypress: keypressSource(h.renderer),
    load,
    triage: async () => ({ ok: false, reason: "unused" }),
  });
  try {
    await modal!.ready;
    // The body is painted with `dimChunk` (secondary/informational text, same
    // choice `triggers-inspector.ts` makes for its own list+detail body): a
    // dark palette keeps the `text` role's colour under OpenTUI's DIM
    // attribute, a light palette switches to the `muted` role instead
    // (`theme-text.ts`'s own header explains why DIM cannot de-emphasise a
    // light palette's dark foreground).
    const dark = chunkColors(findById(h.renderer.root, "ci-triage-body"));
    expect(dark[0]).toBe(roleColor("text").toLowerCase());
    applyThemeId("grokday");
    const light = chunkColors(findById(h.renderer.root, "ci-triage-body"));
    expect(light[0]).toBe(roleColor("muted").toLowerCase());
    expect(light[0]).not.toBe(dark[0]);
  } finally {
    applyThemeId(before);
    modal?.close();
    h.destroy();
  }
});
