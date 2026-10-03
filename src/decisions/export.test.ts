// Flow 400 (AC14): the export carries structure and no words. The leak test plants distinctive
// strings in every free-text field a record can carry and asserts none of them reaches the output,
// not through the options and not through `order` (which holds ids, so it is turned into positions).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decisionsCommand } from "../commands/decisions";
import { EXPORT_FIELDS, buildExport, exportRef, loadExport, renderExport, type ExportRow } from "./export";
import { importBackfill } from "./import";
import { answerDecision, openDecision, recordReason } from "./journal";
import { rateBlindModel, rateDecision } from "./quality";
import { readRecords } from "./store";
import type { DecisionRecord, OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-export-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Every one of these must stay out of the export.
const SECRETS = [
  "QSECRET-question-text",
  "OPTLABEL-secret-alpha",
  "OPTLABEL-secret-beta",
  "OPTDESC-secret-description",
  "OPTID secret id with spaces!",
  "OPTID-secret-beta-id",
  "RECREASON-secret-why",
  "HUMANREASON-secret-because",
  "NOTE-secret-rating-note",
  "OTHERTEXT-secret-free-form",
  "FLOW-secret-name",
  "SOURCE-secret-origin",
  "STAGE secret stage name",
  "CHANNEL secret channel",
  "MODEL secret model name",
] as const;

async function plant(): Promise<string> {
  await openDecision({
    cwd: root,
    id: "ID-secret-decision-id",
    question: "QSECRET-question-text?",
    options: [
      { id: "OPTID secret id with spaces!", label: "OPTLABEL-secret-alpha", description: "OPTDESC-secret-description" },
      { id: "OPTID-secret-beta-id", label: "OPTLABEL-secret-beta" },
    ],
    recommendation: { optionId: "OPTID secret id with spaces!", reason: "RECREASON-secret-why" },
    arm: "D",
    salt: "s",
    seq: 1,
    flow: "FLOW-secret-name",
    stage: "STAGE secret stage name",
    channel: "CHANNEL secret channel",
  });
  await answerDecision({ cwd: root, id: "ID-secret-decision-id", choice: "OPTID-secret-beta-id" });
  await recordReason(root, "ID-secret-decision-id", "HUMANREASON-secret-because");
  await rateDecision({ cwd: root, id: "ID-secret-decision-id", quality: "good", note: "NOTE-secret-rating-note" });
  await rateBlindModel({ cwd: root, model: "MODEL secret model name", call: async () => ({ text: "1", historyMessages: 0 }) });
  return "ID-secret-decision-id";
}

function assertNoLeak(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  // the decision id is replaced by its hash too
  expect(text).not.toContain("ID-secret-decision-id");
  // and nothing that is a piece of one of them
  for (const piece of ["secret", "SECRET", "Secret"]) expect(text).not.toContain(piece);
}

describe("AC14: the export contains no question text and no option text", () => {
  test("planted question, option, reason, note, flow, source, stage, channel and model strings do not leak", async () => {
    await plant();
    const rows = await loadExport(root);
    expect(rows).toHaveLength(1);
    assertNoLeak(renderExport(rows, "jsonl"));
    assertNoLeak(renderExport(rows, "json"));
  });

  test("the command prints the same: no text in what a person pipes out", async () => {
    await plant();
    const cwd = process.cwd();
    process.chdir(root);
    const out: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
    try {
      await decisionsCommand(["export"]);
    } finally {
      console.log = original;
      process.chdir(cwd);
    }
    expect(out.join("\n").length).toBeGreaterThan(0);
    assertNoLeak(out.join("\n"));
  });

  test("the order is made of integers only, the positions of the options in the agent's order", async () => {
    await plant();
    const [row] = await loadExport(root);
    const open = (await readRecords(root)).find((r): r is OpenRecord => r.kind === "open");
    expect(open?.order).toContain("OPTID-secret-beta-id");
    expect(row?.order.every((n) => Number.isInteger(n) && n >= 0 && n < 2)).toBe(true);
    expect([...(row?.order ?? [])].sort()).toEqual([0, 1]);
    expect(row?.recommendedIndex).toBe(0);
    expect(row?.chosenIndex).toBe(1);
    expect(row?.deviation).toBe(true);
  });

  test("a row has no key outside the allowlist", async () => {
    await plant();
    const [row] = await loadExport(root);
    for (const key of Object.keys(row as ExportRow)) expect(EXPORT_FIELDS as readonly string[]).toContain(key);
    for (const rating of row?.ratings ?? []) {
      expect(Object.keys(rating).sort()).toEqual(["at", "cleanContext", "model", "modelAgree", "quality", "rater"].sort().filter((k) => k in rating));
      expect("note" in rating).toBe(false);
    }
  });

  test("a free-text answer is a flag, not the text", async () => {
    await openDecision({ cwd: root, id: "free-1", question: "QSECRET-question-text?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], arm: "A", salt: "s", seq: 1 });
    await answerDecision({ cwd: root, id: "free-1", choice: "OTHERTEXT-secret-free-form", other: true });
    const text = renderExport(await loadExport(root));
    expect(text).not.toContain("OTHERTEXT");
    expect(JSON.parse(text)).toMatchObject({ other: true, chosenIndex: null, answered: true });
  });

  test("an imported historical record leaks nothing either, and a hostile stage name becomes other", async () => {
    await importBackfill(
      root,
      `${JSON.stringify({ id: "bf-1", at: "2026-08-14T09:30:00.000Z", flow: "FLOW-secret-name", stage: "STAGE secret stage name", question: "QSECRET-question-text?", options: [{ id: "OPTID-secret-beta-id", label: "OPTLABEL-secret-beta" }, { id: "x", label: "X" }], recommendation: { optionId: "OPTID-secret-beta-id", reason: "RECREASON-secret-why" }, source: "SOURCE-secret-origin", answer: { choice: "x" } })}\n`,
    );
    const rows = await loadExport(root);
    expect(rows[0]).toMatchObject({ legacy: true, backfilled: true, stage: "other", timeToAnswerMs: null });
    assertNoLeak(renderExport(rows));
  });

  test("the test can fail: a row that does carry text is caught by the same check", () => {
    const leaky = { ...(buildExport([])[0] ?? {}), question: "QSECRET-question-text?" };
    expect(() => assertNoLeak(JSON.stringify(leaky))).toThrow();
  });

  test("the reference is a hash: stable for a decision and not the id", () => {
    expect(exportRef("ID-secret-decision-id")).toBe(exportRef("ID-secret-decision-id"));
    expect(exportRef("ID-secret-decision-id")).not.toBe(exportRef("other"));
    expect(exportRef("ID-secret-decision-id")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("AC14: what the export does carry", () => {
  /** `extra` keys set to undefined are removed, which is how a record from before the arms is built. */
  const open = (id: string, extra: { [K in keyof OpenRecord]?: OpenRecord[K] | undefined } = {}): OpenRecord => {
    const record: Record<string, unknown> = {
    kind: "open",
    id,
    at: "2026-10-03T10:00:00.000Z",
    flow: "400",
    stage: "design",
    question: "Q?",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    recommendation: { optionId: "a", reason: "r" },
    mode: "ordinary",
    order: ["a", "b"],
    showMark: true,
    irreversible: false,
    arm: "B",
    seed: 7,
    preselected: false,
    channel: "telegram",
    ...extra,
    };
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
    return record as unknown as OpenRecord;
  };

  test("arm, seed, preselected, channel, forced and legacy are in the row", () => {
    const records: DecisionRecord[] = [open("x"), open("y", { arm: "A", forced: true, channel: undefined }), open("z", { arm: undefined, legacy: undefined, seed: undefined, preselected: undefined, channel: undefined })];
    const rows = buildExport(records);
    expect(rows[0]).toMatchObject({ arm: "B", seed: 7, preselected: false, channel: "telegram", forced: false, legacy: false });
    expect(rows[1]).toMatchObject({ arm: "A", forced: true, channel: "tui" });
    expect(rows[2]).toMatchObject({ arm: "A", legacy: true, seed: null, preselected: null });
  });

  test("--since and --exclude-legacy narrow the rows", () => {
    const records: DecisionRecord[] = [open("old", { at: "2026-09-01T00:00:00.000Z" }), open("new"), open("legacy", { arm: undefined })];
    expect(buildExport(records, [], { since: new Date("2026-10-01T00:00:00Z") }).map((r) => r.ref)).toEqual([exportRef("new"), exportRef("legacy")]);
    expect(buildExport(records, [], { excludeLegacy: true }).map((r) => r.ref)).toEqual([exportRef("old"), exportRef("new")]);
  });

  test("the ratings are joined to the decision by the hash and keep only structure", () => {
    const rows = buildExport(
      [open("x")],
      [
        { seq: 1, decisionId: "x", rater: "human", quality: "good", note: "NOTE-secret-rating-note", at: "2026-10-03T11:00:00.000Z" },
        { seq: 1, decisionId: "x", rater: "model", quality: "bad", model: "m-1", cleanContext: true, modelAgree: false, at: "2026-10-03T12:00:00.000Z" },
      ],
    );
    expect(rows[0]?.ratings).toEqual([
      { rater: "human", quality: "good", at: "2026-10-03T11:00:00.000Z" },
      { rater: "model", quality: "bad", model: "m-1", cleanContext: true, modelAgree: false, at: "2026-10-03T12:00:00.000Z" },
    ]);
  });

  test("jsonl is one object per line and json is an array; an empty journal prints nothing", async () => {
    expect(renderExport(await loadExport(root))).toBe("");
    await plant();
    const rows = await loadExport(root);
    expect(renderExport(rows, "jsonl").split("\n")).toHaveLength(1);
    expect(JSON.parse(renderExport(rows, "json"))).toHaveLength(1);
  });
});
