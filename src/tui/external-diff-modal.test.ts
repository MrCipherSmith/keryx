// Flow 370 (AC6): the `/external-diff` modal. The typed-hash gate lives in a pure controller,
// so the safety properties are tested without a renderer; a couple of cases mount the real
// modal to prove the keys reach it.

import { describe, expect, test } from "bun:test";
import type { DiscardResult, LandResult, WriteRunView } from "../harness/external/write-land";
import type { ExternalWriteRunRecord } from "../harness/external/write-run";
import {
  createExternalDiffController,
  discardResultText,
  externalDiffSlashText,
  landResultText,
  openExternalDiff,
  orderedFiles,
  type ExternalDiffDeps,
  type ExternalDiffKey,
} from "./external-diff-modal";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const HASH = "0123456789abcdef".repeat(4);
const PREFIX = HASH.slice(0, 12);

function record(runId: string, overrides: Partial<ExternalWriteRunRecord> = {}): ExternalWriteRunRecord {
  return {
    runId,
    agentId: "claude",
    baseCommit: "b".repeat(40),
    patchHash: HASH,
    files: [{ path: "src/a.ts", status: "modified" }],
    flaggedPaths: [],
    refusedPaths: [],
    state: "pending-review",
    redacted: false,
    runStatus: "Completed",
    projectRoot: "/repo",
    createdAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

interface Fake {
  deps: ExternalDiffDeps;
  lands: Array<{ runId: string; confirmedPatchHash: string; allowFlagged: boolean }>;
  discards: string[];
  state: { runs: ExternalWriteRunRecord[]; patches: Record<string, string | undefined>; land: LandResult; discard: DiscardResult };
}

function fake(runs: ExternalWriteRunRecord[], patches: Record<string, string | undefined> = {}): Fake {
  const state: Fake["state"] = {
    runs,
    patches,
    land: { kind: "landed", branch: "external/run-1", commit: "c".repeat(40) },
    discard: { kind: "discarded" },
  };
  const lands: Fake["lands"] = [];
  const discards: string[] = [];
  const deps: ExternalDiffDeps = {
    list: () => state.runs,
    view: (runId): WriteRunView | undefined => {
      const found = state.runs.find((run) => run.runId === runId);
      if (found === undefined) return undefined;
      const patch = runId in state.patches ? state.patches[runId] : "diff --git a/src/a.ts b/src/a.ts\n+added line\n";
      return patch === undefined ? { record: found } : { record: found, patch };
    },
    land: async (input) => {
      lands.push(input);
      const result = state.land;
      if (result.kind === "landed") state.runs = state.runs.filter((run) => run.runId !== input.runId);
      return result;
    },
    discard: (runId) => {
      discards.push(runId);
      if (state.discard.kind === "discarded") state.runs = state.runs.filter((run) => run.runId !== runId);
      return state.discard;
    },
  };
  return { deps, lands, discards, state };
}

const KEYS: Record<string, ExternalDiffKey> = {
  enter: { name: "return", sequence: "\r" },
  backspace: { name: "backspace", sequence: "\u007f" },
  escape: { name: "escape", sequence: "\u001b" },
  up: { name: "up", sequence: "\u001b[A" },
  down: { name: "down", sequence: "\u001b[B" },
  pageup: { name: "pageup", sequence: "\u001b[5~" },
  pagedown: { name: "pagedown", sequence: "\u001b[6~" },
};

function press(controller: ReturnType<typeof createExternalDiffController>, ...names: string[]): void {
  for (const name of names) controller.handleKey(KEYS[name] ?? { name, sequence: name });
}

function type(controller: ReturnType<typeof createExternalDiffController>, text: string): void {
  for (const char of text) controller.handleKey({ name: char, sequence: char });
}

const text = (controller: ReturnType<typeof createExternalDiffController>, rows = 200): string => controller.render(400, rows).join("\n");

describe("list and detail", () => {
  test("lists each run with short id, agent, file count and flagged count", () => {
    const { deps } = fake([
      record("aaaaaaaa-1111-2222", { files: [{ path: "a", status: "added" }, { path: "b", status: "added" }], flaggedPaths: ["b"] }),
      record("bbbbbbbb-3333-4444", { agentId: "claude-2" }),
    ]);
    const out = text(createExternalDiffController({ deps }));
    expect(out).toContain("Write runs awaiting review (2):");
    expect(out).toContain("> aaaaaaaa  claude  2 file(s)  1 flagged");
    expect(out).toContain("  bbbbbbbb  claude-2  1 file(s)  0 flagged");
  });

  test("says so when nothing is waiting", () => {
    expect(text(createExternalDiffController({ deps: fake([]).deps }))).toContain("No write runs are waiting for review.");
  });

  test("shows base commit, run status, the full patch hash and the redacted patch", () => {
    const out = text(createExternalDiffController({ deps: fake([record("run-1")]).deps }));
    expect(out).toContain(`Base commit: ${"b".repeat(40)}`);
    expect(out).toContain("Run status: Completed");
    expect(out).toContain(`Patch hash: ${HASH}`);
    expect(out).toContain("modified  src/a.ts");
    expect(out).toContain("Patch (redacted");
    expect(out).toContain("+added line");
  });

  test("flagged paths come first and carry a marker; binary files are marked", () => {
    const run = record("run-1", {
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "assets/logo.png", status: "added", binary: true },
        { path: ".github/workflows/ci.yml", status: "modified" },
      ],
      flaggedPaths: [".github/workflows/ci.yml"],
    });
    expect(orderedFiles(run).map((entry) => entry.path)).toEqual([".github/workflows/ci.yml", "src/a.ts", "assets/logo.png"]);
    const out = text(createExternalDiffController({ deps: fake([run]).deps }));
    expect(out.indexOf(".github/workflows/ci.yml")).toBeLessThan(out.indexOf("src/a.ts"));
    expect(out).toContain("!! FLAGGED  modified  .github/workflows/ci.yml");
    expect(out).toContain("added  assets/logo.png (binary, content not shown)");
    expect(out).toContain("Apply is blocked until you press f");
  });

  test("a flagged path missing from the file list is still shown, first", () => {
    const run = record("run-1", { flaggedPaths: [".claude/settings.json"] });
    expect(orderedFiles(run)[0]).toMatchObject({ path: ".claude/settings.json", flagged: true });
  });

  test("control bytes in agent-controlled paths never reach the screen", () => {
    const run = record("run-1", { files: [{ path: "evil\u001b[2Jname", status: "added" }] });
    expect(text(createExternalDiffController({ deps: fake([run]).deps }))).not.toContain("\u001b");
  });

  test("up and down change the selected run", () => {
    const controller = createExternalDiffController({ deps: fake([record("run-1"), record("run-2")]).deps });
    expect(controller.selected()?.runId).toBe("run-1");
    press(controller, "down");
    expect(controller.selected()?.runId).toBe("run-2");
    press(controller, "down");
    expect(controller.selected()?.runId).toBe("run-2");
    press(controller, "up");
    expect(controller.selected()?.runId).toBe("run-1");
  });

  test("a run without a verified patch says it cannot be reviewed and offers only discard", () => {
    const f = fake([record("run-1")], { "run-1": undefined });
    const controller = createExternalDiffController({ deps: f.deps });
    expect(text(controller)).toContain("This run cannot be reviewed");
    expect(text(controller)).toContain("Only discard (d) is offered.");
    press(controller, "a");
    expect(text(controller)).toContain("cannot be applied");
    type(controller, PREFIX);
    press(controller, "enter");
    expect(f.lands).toEqual([]);
  });
});

describe("scrolling", () => {
  const longPatch = Array.from({ length: 60 }, (_, index) => `+line-${index}`).join("\n");

  test("j and k scroll one line, PageDown and PageUp a page", () => {
    const controller = createExternalDiffController({ deps: fake([record("run-1")], { "run-1": longPatch }).deps });
    const first = controller.render(80, 10);
    expect(first.join("\n")).not.toContain("+line-40");
    press(controller, "j");
    const one = controller.render(80, 10);
    expect(one).not.toEqual(first);
    press(controller, "k");
    expect(controller.render(80, 10)).toEqual(first);
    press(controller, "pagedown", "pagedown", "pagedown");
    const paged = controller.render(80, 10).join("\n");
    expect(paged).toContain("+line-");
    expect(paged).not.toContain("Write runs awaiting review");
    press(controller, "pageup", "pageup", "pageup", "pageup");
    expect(controller.render(80, 10)).toEqual(first);
  });

  test("scrolling never runs past the end", () => {
    const controller = createExternalDiffController({ deps: fake([record("run-1")], { "run-1": longPatch }).deps });
    for (let i = 0; i < 40; i += 1) press(controller, "pagedown");
    expect(controller.render(80, 10).join("\n")).toContain("+line-59");
  });
});

describe("apply", () => {
  test("a wrong string cancels and lands nothing", async () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    expect(text(controller)).toContain(`(${PREFIX})`);
    type(controller, "wrong-string!");
    press(controller, "enter");
    await controller.idle();
    expect(f.lands).toEqual([]);
    expect(text(controller)).toContain("Apply cancelled");
    expect(text(controller)).toContain("Nothing was applied to your current branch or working tree.");
  });

  test("a prefix that is too short or too long cancels", async () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    type(controller, PREFIX.slice(0, 11));
    press(controller, "enter");
    press(controller, "a");
    type(controller, `${PREFIX}0`);
    press(controller, "enter");
    await controller.idle();
    expect(f.lands).toEqual([]);
  });

  test("Enter with nothing typed cancels", async () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a", "enter");
    await controller.idle();
    expect(f.lands).toEqual([]);
  });

  test("any non-typing key cancels the prompt", async () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    type(controller, PREFIX);
    press(controller, "escape");
    press(controller, "enter");
    await controller.idle();
    expect(f.lands).toEqual([]);
    expect(text(controller)).toContain("Apply cancelled.");
  });

  test("the exact prefix lands, with the FULL hash, and the list refreshes", async () => {
    const f = fake([record("run-1")]);
    let acted = 0;
    const controller = createExternalDiffController({ deps: f.deps, onActed: () => (acted += 1) });
    press(controller, "a");
    type(controller, PREFIX);
    expect(f.lands).toEqual([]);
    press(controller, "enter");
    await controller.idle();
    expect(f.lands).toEqual([{ runId: "run-1", confirmedPatchHash: HASH, allowFlagged: false }]);
    const out = text(controller);
    expect(out).toContain(`Applied as branch external/run-1 at commit ${"c".repeat(40)}.`);
    expect(out).toContain("Nothing was applied to your current branch or working tree.");
    expect(out).toContain("No write runs are waiting for review.");
    expect(acted).toBe(1);
  });

  test("Backspace edits what was typed", async () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    type(controller, `${PREFIX}zz`);
    press(controller, "backspace", "backspace", "enter");
    await controller.idle();
    expect(f.lands).toHaveLength(1);
  });

  test("no other key lands anything without the typed prefix", async () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    for (const name of ["y", "enter", "f", "d", "return", "up", "down", "j", "k"]) press(controller, name);
    await controller.idle();
    expect(f.lands).toEqual([]);
  });

  test("a flagged run needs f before a is accepted, and then passes allowFlagged", async () => {
    const f = fake([record("run-1", { flaggedPaths: [".github/workflows/ci.yml"], files: [{ path: ".github/workflows/ci.yml", status: "modified" }] })]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    expect(text(controller)).toContain("Press f to allow applying them");
    type(controller, PREFIX);
    press(controller, "enter");
    await controller.idle();
    expect(f.lands).toEqual([]);

    press(controller, "f");
    expect(text(controller)).toContain("flagged paths are ALLOWED");
    press(controller, "a");
    expect(text(controller)).toContain("Flagged paths: ALLOWED.");
    type(controller, PREFIX);
    press(controller, "enter");
    await controller.idle();
    expect(f.lands).toEqual([{ runId: "run-1", confirmedPatchHash: HASH, allowFlagged: true }]);
  });

  test("f alone lands nothing, and pressing it again blocks flagged paths again", async () => {
    const f = fake([record("run-1", { flaggedPaths: ["x"] })]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "f");
    expect(text(controller)).toContain("Flagged paths allowed for this apply.");
    press(controller, "f");
    expect(text(controller)).toContain("Flagged paths are blocked again.");
    await controller.idle();
    expect(f.lands).toEqual([]);
  });

  test("allowing flagged paths does not carry over to the next apply", async () => {
    const f = fake([record("run-1", { flaggedPaths: ["x"] })]);
    f.state.land = { kind: "refused", reason: "apply-failed", detail: "boom" };
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "f", "a");
    type(controller, PREFIX);
    press(controller, "enter");
    await controller.idle();
    press(controller, "a");
    expect(text(controller)).toContain("Press f to allow applying them");
  });

  test("f on a run with no flagged paths says so", () => {
    const controller = createExternalDiffController({ deps: fake([record("run-1")]).deps });
    press(controller, "f");
    expect(text(controller)).toContain("This run has no flagged paths.");
  });
});

describe("discard", () => {
  test("d asks for confirmation and any other key cancels", () => {
    const f = fake([record("run-1")]);
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "d");
    expect(text(controller)).toContain("Press y to confirm");
    expect(f.discards).toEqual([]);
    press(controller, "n");
    expect(text(controller)).toContain("Discard cancelled.");
    expect(f.discards).toEqual([]);
  });

  test("y after d discards and refreshes the list", () => {
    const f = fake([record("run-1")]);
    let acted = 0;
    const controller = createExternalDiffController({ deps: f.deps, onActed: () => (acted += 1) });
    press(controller, "y");
    expect(f.discards).toEqual([]);
    press(controller, "d", "y");
    expect(f.discards).toEqual(["run-1"]);
    expect(text(controller)).toContain("Discarded run run-1.");
    expect(text(controller)).toContain("Its stored patch was deleted.");
    expect(text(controller)).toContain("No write runs are waiting for review.");
    expect(acted).toBe(1);
  });

  test("a run without a patch can still be discarded", () => {
    const f = fake([record("run-1")], { "run-1": undefined });
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "d", "y");
    expect(f.discards).toEqual(["run-1"]);
  });
});

describe("results and errors in plain English", () => {
  test("a refusal shows the reason and detail and says nothing was applied", async () => {
    const f = fake([record("run-1")]);
    f.state.land = { kind: "refused", reason: "hash-mismatch", detail: "the confirmed hash is not the hash of the stored patch" };
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    type(controller, PREFIX);
    press(controller, "enter");
    await controller.idle();
    const out = text(controller);
    expect(out).toContain("Not applied (hash-mismatch): the confirmed hash is not the hash of the stored patch");
    expect(out).toContain("Nothing was applied to your current branch or working tree.");
    expect(out).toContain("Write runs awaiting review (1):");
  });

  test("a thrown apply is reported and the modal survives", async () => {
    const f = fake([record("run-1")]);
    f.deps.land = async () => {
      throw new Error("not implemented");
    };
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "a");
    type(controller, PREFIX);
    press(controller, "enter");
    await controller.idle();
    expect(text(controller)).toContain("Apply failed: not implemented.");
    expect(text(controller)).toContain("Nothing was applied");
  });

  test("a refused discard and a thrown discard are reported", () => {
    const f = fake([record("run-1")]);
    f.state.discard = { kind: "refused", reason: "not-pending", detail: "the run was already decided" };
    const controller = createExternalDiffController({ deps: f.deps });
    press(controller, "d", "y");
    expect(text(controller)).toContain("Not discarded (not-pending): the run was already decided");
    f.deps.discard = () => {
      throw new Error("disk full");
    };
    press(controller, "d", "y");
    expect(text(controller)).toContain("Discard failed: disk full");
  });

  test("a list that throws shows why instead of crashing", () => {
    const f = fake([]);
    f.deps.list = () => {
      throw new Error("not implemented");
    };
    expect(text(createExternalDiffController({ deps: f.deps }))).toContain("Could not read the write runs: not implemented");
  });

  test("result texts", () => {
    expect(landResultText({ kind: "landed", branch: "external/x", commit: "abc" })).toBe(
      "Applied as branch external/x at commit abc. Nothing was applied to your current branch or working tree.",
    );
    expect(landResultText({ kind: "refused", reason: "flagged", detail: "flagged paths" })).toContain("Not applied (flagged): flagged paths");
    expect(discardResultText({ kind: "discarded" }, "12345678-rest")).toBe("Discarded run 12345678. Its stored patch was deleted.");
  });
});

describe("readline fallback", () => {
  test("lists pending runs, points at the CLI, and lands nothing", () => {
    const out = externalDiffSlashText(fake([record("run-1", { flaggedPaths: ["x"] })]).deps);
    expect(out).toContain("Write runs awaiting review (1):");
    expect(out).toContain("run-1  claude  1 file(s)  1 flagged");
    expect(out).toContain("Use keryx agents external review <run-id> and keryx agents external apply <run-id> in a terminal.");
  });

  test("survives a list that throws", () => {
    const out = externalDiffSlashText({
      list: () => {
        throw new Error("not implemented");
      },
    });
    expect(out).toContain("Could not read the write runs: not implemented");
    expect(out).toContain("Use keryx agents external review <run-id>");
  });
});

otuiTest("the mounted modal shows the list and its keys reach the controller", async () => {
  const h = await mountChrome(OTUI!);
  const f = fake([record("run-1")]);
  const modal = openExternalDiff(OTUI!.core, h.chrome, { deps: f.deps, onKeypress: keypressSource(h.renderer) });
  try {
    await settle(h);
    expect(modal?.visibleLines().join("\n")).toContain("run-1");
    await h.mockInput.pressKey("a");
    await h.mockInput.typeText("nope");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(f.lands).toEqual([]);
    await h.mockInput.pressKey("a");
    await h.mockInput.typeText(PREFIX);
    await h.mockInput.pressEnter();
    await modal?.idle();
    expect(f.lands).toEqual([{ runId: "run-1", confirmedPatchHash: HASH, allowFlagged: false }]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("PageDown reaches the mounted modal", async () => {
  const h = await mountChrome(OTUI!);
  const longPatch = Array.from({ length: 80 }, (_, index) => `+row-${index}`).join("\n");
  const modal = openExternalDiff(OTUI!.core, h.chrome, {
    deps: fake([record("run-1")], { "run-1": longPatch }).deps,
    onKeypress: keypressSource(h.renderer),
    visibleRows: 10,
  });
  try {
    await settle(h);
    const before = modal?.visibleLines().join("\n");
    await h.mockInput.pressKey("\u001b[6~");
    await settle(h);
    expect(modal?.visibleLines().join("\n")).not.toBe(before);
  } finally {
    modal?.close();
    h.destroy();
  }
});
