import { expect, test } from "bun:test";
import type { RewindListing } from "../rewind/recorder";
import { formatModalFooter } from "./modal-host";
import { keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";
import {
  availableRewindModes,
  formatRewindConfirmLines,
  formatRewindListLines,
  formatRewindModeLines,
  isRewindCommand,
  openRewind,
  REWIND_COMMAND,
  REWIND_FOOTER,
  type RewindApplyResult,
  type RewindMode,
} from "./rewind-inspector";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function listing(input: Partial<RewindListing> & { seq: number }): RewindListing {
  return {
    kind: "turn",
    at: "2026-09-29T10:15:30.000Z",
    prompt: "fix the build",
    archiveIndex: 0,
    files: 2,
    changed: ["a.txt", "src/b.ts"],
    skipped: [],
    ...input,
  };
}

test("isRewindCommand matches only the /rewind token", () => {
  expect(isRewindCommand("/rewind")).toBe(true);
  expect(isRewindCommand("  /rewind 3 both ")).toBe(true);
  expect(isRewindCommand("/rewinder")).toBe(false);
  expect(isRewindCommand("/guard")).toBe(false);
  expect(REWIND_COMMAND).toBe("/rewind");
});

test("formatRewindListLines: an empty list explains when a snapshot is taken", () => {
  const [line] = formatRewindListLines([], 0);
  expect(line).toContain("No snapshots yet");
  expect(line).toContain("file-changing");
});

test("formatRewindListLines: time, prompt excerpt and file count per turn; the selected row is marked", () => {
  const lines = formatRewindListLines(
    [listing({ seq: 2, prompt: "second", files: 1 }), listing({ seq: 1, prompt: "x".repeat(100), files: 3 })],
    1,
  );
  expect(lines[0]?.startsWith(">")).toBe(false);
  expect(lines[0]).toContain("second");
  expect(lines[0]).toContain("1 file");
  expect(lines[0]).not.toContain("1 files");
  expect(lines[1]?.startsWith(">")).toBe(true);
  expect(lines[1]).toContain("3 files");
  expect(lines[1]).toContain("…");
});

test("formatRewindListLines: a pre-rewind entry is labelled as an undo point", () => {
  const lines = formatRewindListLines([listing({ seq: 3, kind: "pre-rewind", archiveIndex: null, prompt: "Before rewind to snapshot 1" })], 0);
  expect(lines[0]).toContain("undo point");
});

test("availableRewindModes: a pre-rewind entry can only restore files", () => {
  expect(availableRewindModes(listing({ seq: 1 }))).toEqual(["files", "history", "both"]);
  expect(availableRewindModes(listing({ seq: 1, archiveIndex: null }))).toEqual(["files"]);
});

test("formatRewindModeLines and formatRewindConfirmLines describe what will change", () => {
  const entry = listing({ seq: 1, skipped: ["big.bin"] });
  const modes = formatRewindModeLines(entry, 1).join("\n");
  expect(modes).toContain("f  files only");
  expect(modes).toContain("> h  history only");
  expect(modes).toContain("b  files and history");

  const both = formatRewindConfirmLines(entry, "both").join("\n");
  expect(both).toContain("a.txt");
  expect(both).toContain("undo point");
  expect(both).toContain("cannot be undone");
  expect(both).toContain("big.bin");
  expect(both).toContain("y");

  const filesOnly = formatRewindConfirmLines(entry, "files").join("\n");
  expect(filesOnly).not.toContain("cannot be undone");
  const historyOnly = formatRewindConfirmLines(entry, "history").join("\n");
  expect(historyOnly).not.toContain("undo point");
});

test("REWIND_FOOTER names the keys", () => {
  expect(formatModalFooter(REWIND_FOOTER)).toContain("esc");
});

otuiTest("picking a turn, a mode and confirming applies the rewind and shows the result", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const applied: Array<{ seq: number; mode: RewindMode }> = [];
  const entries = [listing({ seq: 2, prompt: "second turn", archiveIndex: 2 }), listing({ seq: 1, prompt: "first turn" })];
  const modal = openRewind(otui.core, h.chrome, {
    listings: async () => entries,
    apply: async (input): Promise<RewindApplyResult> => {
      applied.push(input);
      return { ok: true, lines: ["Restored 2 files."] };
    },
    onKeypress: keypressSource(h.renderer),
    visibleRows: 24,
  });
  try {
    expect(modal).toBeDefined();
    await settle(h);
    const list = modal!.visibleLines().join("\n");
    expect(list).toContain("first turn");
    expect(list).toContain("second turn");
    expect(h.captureCharFrame()).toContain(formatModalFooter(REWIND_FOOTER));

    await h.mockInput.pressArrow("down");
    await h.mockInput.pressEnter();
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("files only");

    await h.mockInput.pressKey("f");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("Apply this rewind?");
    expect(applied).toEqual([]);

    await h.mockInput.pressKey("y");
    await settle(h);
    expect(applied).toEqual([{ seq: 1, mode: "files" }]);
    expect(modal!.visibleLines().join("\n")).toContain("Restored 2 files.");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("declining at the confirmation applies nothing", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  let calls = 0;
  const modal = openRewind(otui.core, h.chrome, {
    listings: async () => [listing({ seq: 1 })],
    apply: async () => {
      calls += 1;
      return { ok: true, lines: [] };
    },
    onKeypress: keypressSource(h.renderer),
    visibleRows: 24,
  });
  try {
    await settle(h);
    await h.mockInput.pressEnter();
    await h.mockInput.pressKey("b");
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("Apply this rewind?");
    await h.mockInput.pressKey("n");
    await settle(h);
    expect(calls).toBe(0);
    expect(modal!.visibleLines().join("\n")).toContain("files only");
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("an empty session shows the empty message", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui);
  const modal = openRewind(otui.core, h.chrome, {
    listings: async () => [],
    apply: async () => ({ ok: true, lines: [] }),
    onKeypress: keypressSource(h.renderer),
    visibleRows: 24,
  });
  try {
    await settle(h);
    expect(modal!.visibleLines().join("\n")).toContain("No snapshots yet");
  } finally {
    modal?.close();
    h.destroy();
  }
});
