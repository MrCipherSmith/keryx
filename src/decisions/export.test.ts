// Flow 400 (AC14): the export carries structure and no words. The leak test plants distinctive
// strings in every free-text field a record can carry and asserts none of them reaches the output,
// not through the options and not through `order` (which holds ids, so it is turned into positions).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decisionsCommand } from "../commands/decisions";
import { EXPORT_CHANNELS, EXPORT_FIELDS, EXPORT_STAGES, MODEL_ID, buildExport, buildExportWithSummary, exportRef, exportSummaryLine, loadExport, loadExportWithSummary, renderExport, type ExportRow } from "./export";
import { importBackfill } from "./import";
import { answerDecision, openDecision, recordReason } from "./journal";
import { rateBlindModel, rateDecision, type QualityRecord } from "./quality";
import { decisionsDir, journalFile, readRecords } from "./store";
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
        { seq: 1, decisionId: "x", rater: "model", quality: "bad", model: "claude-sonnet-5", cleanContext: true, modelAgree: false, at: "2026-10-03T12:00:00.000Z" },
      ],
    );
    expect(rows[0]?.ratings).toEqual([
      { rater: "human", quality: "good", at: "2026-10-03T11:00:00.000Z" },
      { rater: "model", quality: "bad", model: "claude-sonnet-5", cleanContext: true, modelAgree: false, at: "2026-10-03T12:00:00.000Z" },
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

// --- review S-2 and T-7: the allow-list is enforced at run time, and a closed vocabulary is not "identifier-shaped" ---

const SECRET_ID = "sk_live_abc123XYZ";

function openLine(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "open",
    id,
    at: "2026-10-03T10:00:00.000Z",
    flow: "400",
    stage: "review",
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
    channel: "tui",
    ...extra,
  };
}

const answerLine = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "answer",
  id,
  at: "2026-10-03T10:00:04.000Z",
  seq: 1,
  choice: "a",
  timeToAnswerMs: 4000,
  changed: false,
  ...extra,
});

describe("T-7: stage, channel and model are exported only from a closed vocabulary", () => {
  test("an identifier-shaped secret in stage, channel and model is exported as other", () => {
    const rows = buildExport(
      [openLine(SECRET_ID, { stage: SECRET_ID, channel: SECRET_ID }) as unknown as OpenRecord],
      [{ seq: 1, decisionId: SECRET_ID, rater: "model", quality: "good", model: SECRET_ID, at: "2026-10-03T12:00:00.000Z" }],
    );
    expect(rows[0]).toMatchObject({ stage: "other", channel: "other" });
    expect(rows[0]?.ratings[0]?.model).toBe("other");
    expect(renderExport(rows)).not.toContain(SECRET_ID);
    expect(renderExport(rows).toLowerCase()).not.toContain(SECRET_ID.toLowerCase());
  });

  test("the known vocabulary passes through and a model id of the conservative shape is kept", () => {
    const rows = buildExport(
      [openLine("v1", { stage: "implement", channel: "Telegram" }) as unknown as OpenRecord, openLine("v2", { stage: "ask_user", channel: undefined }) as unknown as OpenRecord],
      [{ seq: 1, decisionId: "v1", rater: "model", quality: "bad", model: "claude-opus-5.5", at: "2026-10-03T12:00:00.000Z" }],
    );
    expect(rows.map((r) => [r.stage, r.channel])).toEqual([
      ["implement", "telegram"],
      ["ask_user", "tui"],
    ]);
    expect(rows[0]?.ratings[0]?.model).toBe("claude-opus-5.5");
  });

  test("a model label that is too long, upper-case or has other characters is other", () => {
    for (const model of ["Claude-Opus", "m_1", "x".repeat(41), "has space", ""]) {
      expect(MODEL_ID.test(model)).toBe(false);
    }
  });

  test("a lowercase, dashed or hex secret in the model field is other: only a known model family passes", () => {
    const secrets = [
      "sk-live-secretleak0123456789",
      "ghp-abcdef0123456789abcdef0123456789abcd",
      "hunter2",
      "password-is-hunter2",
      "0123456789abcdef0123456789abcdef",
      "claude-0123456789abcdef0123456789",
      "gpt-4123456789012",
    ];
    const rows = buildExport(
      [openLine("s1", {}) as unknown as OpenRecord],
      secrets.map((model, i) => ({ seq: i + 1, decisionId: "s1", rater: "model" as const, quality: "good" as const, model, at: "2026-10-03T12:00:00.000Z" })),
    );
    expect(rows[0]?.ratings.map((r) => r.model)).toEqual(secrets.map(() => "other"));
    for (const secret of secrets) expect(renderExport(rows)).not.toContain(secret);
    for (const model of ["claude-haiku-4-5-20251001", "gpt-4o-mini", "gemini-2.5-pro", "deepseek-r1-distill-llama-70b"]) {
      const kept = buildExport([openLine("k1", {}) as unknown as OpenRecord], [{ seq: 1, decisionId: "k1", rater: "model", quality: "good", model, at: "2026-10-03T12:00:00.000Z" }]);
      expect(kept[0]?.ratings[0]?.model).toBe(model);
    }
  });

  test("every source the journal writes itself is a stage the export keeps", () => {
    for (const source of ["round-limit", "tui-wiki-enrich", "tui-queue-route", "tui-session-lease", "ask_user"]) {
      const rows = buildExport([openLine("src-1", { stage: source }) as unknown as OpenRecord], []);
      expect(rows[0]?.stage).toBe(source);
    }
  });

  test("87 records with hostile free text in every string field leak none of it", () => {
    const records: DecisionRecord[] = [];
    const ratings: QualityRecord[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < 87; i += 1) {
      const t = (field: string): string => {
        const token = `HOSTILE-${field}-${i}-sk_live_abc123XYZ`;
        tokens.push(token);
        return token;
      };
      const id = t("id");
      records.push(
        openLine(id, {
          flow: t("flow"),
          stage: t("stage"),
          question: t("question"),
          options: [{ id: t("optid-a"), label: t("label-a"), description: t("desc-a") }, { id: t("optid-b"), label: t("label-b") }],
          recommendation: { optionId: t("recommended"), reason: t("reason") },
          order: [t("order-a"), t("order-b")],
          channel: t("channel"),
          source: t("source"),
          session: t("session"),
          action: t("action"),
          arm: (["A", "B", "C", "D"] as const)[i % 4],
        }) as unknown as OpenRecord,
        answerLine(id, { choice: t("choice"), other: i % 2 === 0 }) as unknown as DecisionRecord,
        { kind: "reason", id, at: "2026-10-03T10:01:00.000Z", reason: t("human-reason") },
      );
      ratings.push({ seq: 1, decisionId: id, rater: i % 2 === 0 ? "human" : "model", quality: "good", note: t("note"), model: t("model"), at: "2026-10-03T12:00:00.000Z" });
    }
    const { rows, summary } = buildExportWithSummary(records, ratings);
    expect(rows).toHaveLength(87);
    expect(summary).toEqual({ rows: 87, skipped: 0, blanked: 0 });
    for (const text of [renderExport(rows, "jsonl"), renderExport(rows, "json")]) {
      for (const token of tokens) expect(text).not.toContain(token);
      for (const piece of ["HOSTILE", "sk_live", "abc123", "XYZ"]) expect(text).not.toContain(piece);
    }
    // every string left in a row is one of the closed values, a timestamp or a hash
    const allowed = (key: string, value: string): boolean =>
      key === "ref" ? /^[0-9a-f]{12}$/.test(value) : key === "stage" ? EXPORT_STAGES.includes(value) : key === "channel" ? EXPORT_CHANNELS.includes(value) : key === "model" ? value === "other" || MODEL_ID.test(value) : key === "arm" ? /^[ABCD]$/.test(value) : key === "rater" ? /^(human|model)$/.test(value) : key === "quality" ? /^(good|bad|unclear)$/.test(value) : /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value);
    const walk = (key: string, value: unknown): void => {
      if (typeof value === "string") expect([key, allowed(key, value)]).toEqual([key, true]);
      else if (Array.isArray(value)) for (const item of value) walk(key, item);
      else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(k, v);
    };
    for (const row of rows) walk("row", row);
  });
});

describe("S-2: every exported field is validated at run time", () => {
  test("a hand-edited journal line with prose in at, seed, timeToAnswerMs and arm exports no prose", async () => {
    await mkdir(decisionsDir(root), { recursive: true });
    const lines = [
      openLine("edited-1", { at: "PROSE-in-the-timestamp, call me", seed: "PROSE-seed", preselected: "PROSE-flag", forced: "PROSE-forced" }),
      answerLine("edited-1", { at: "PROSE-answered-at", timeToAnswerMs: "PROSE-time" }),
      openLine("edited-2", { arm: "PROSE-arm" }),
      answerLine("edited-2"),
      openLine("fine-1"),
      answerLine("fine-1"),
    ];
    await appendFile(journalFile(root), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const { rows, summary } = await loadExportWithSummary(root);
    const text = renderExport(rows, "jsonl");
    expect(text).not.toContain("PROSE");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ref: exportRef("edited-1"), openedAt: null, seed: null, preselected: null, answeredAt: null, timeToAnswerMs: null, forced: false, answered: true });
    expect(rows[1]).toMatchObject({ ref: exportRef("fine-1"), openedAt: "2026-10-03T10:00:00.000Z", seed: 7, timeToAnswerMs: 4000 });
    // edited-1: openedAt, seed, preselected, answeredAt, timeToAnswerMs blanked; edited-2: skipped for its arm
    expect(summary).toEqual({ rows: 2, skipped: 1, blanked: 5 });
    expect(exportSummaryLine(summary)).toBe("Export: 2 decisions, 1 skipped, 5 invalid fields blanked.");
  });

  test("numbers must be finite and non-negative integers where they count; timestamps ISO-8601 UTC; enums closed", () => {
    const rows = buildExport(
      [
        openLine("n1", { seed: -3 }) as unknown as OpenRecord,
        openLine("n2", { seed: 1.5 }) as unknown as OpenRecord,
        openLine("n3", { seed: Number.POSITIVE_INFINITY }) as unknown as OpenRecord,
        openLine("n4", { at: "2026-10-03 10:00:00" }) as unknown as OpenRecord,
        openLine("n5", { at: "2026-10-03T10:00:00+02:00" }) as unknown as OpenRecord,
        answerLine("n1", { timeToAnswerMs: -1 }) as unknown as DecisionRecord,
        answerLine("n2", { timeToAnswerMs: Number.NaN }) as unknown as DecisionRecord,
        openLine("n6", { seed: 0 }) as unknown as OpenRecord,
        answerLine("n6", { timeToAnswerMs: 0 }) as unknown as DecisionRecord,
      ],
      [
        { seq: 1, decisionId: "n6", rater: "model", quality: "good", cleanContext: "yes" as unknown as boolean, modelAgree: true, at: "yesterday" },
        { seq: 2, decisionId: "n6", rater: "robot" as unknown as "human", quality: "good", at: "2026-10-03T12:00:00.000Z" },
        { seq: 3, decisionId: "n6", rater: "human", quality: "great" as unknown as "good", at: "2026-10-03T12:00:00.000Z" },
      ],
    );
    expect(rows.map((r) => r.seed)).toEqual([null, null, null, 7, 7, 0]);
    expect(rows.map((r) => r.openedAt)).toEqual(["2026-10-03T10:00:00.000Z", "2026-10-03T10:00:00.000Z", "2026-10-03T10:00:00.000Z", null, null, "2026-10-03T10:00:00.000Z"]);
    expect(rows.map((r) => r.timeToAnswerMs)).toEqual([null, null, null, null, null, 0]);
    expect(rows[5]?.ratings).toEqual([{ rater: "model", quality: "good", modelAgree: true, at: null }]);
  });

  test("--since leaves out a record whose time cannot be read", () => {
    const rows = buildExport([openLine("s1", { at: "PROSE" }) as unknown as OpenRecord, openLine("s2") as unknown as OpenRecord], [], { since: new Date("2026-10-01T00:00:00Z") });
    expect(rows.map((r) => r.ref)).toEqual([exportRef("s2")]);
  });
});

describe("AC18: the export carries reasonRequested and whether a reason was named, never the reason text", () => {
  async function open(id: string, seq: number, extra: { irreversible?: boolean } = {}): Promise<void> {
    await openDecision({ cwd: root, id, question: `Question ${id}?`, options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], recommendation: { optionId: "x", reason: "why" }, arm: "B", salt: "export-salt", seq, ...extra });
  }

  test("eligible, reasonRequested and reasonNamed are structure, and the reason text itself is not in the output", async () => {
    // find one position in and one out of the reason subsample, for this salt
    const { assignArm, reasonSubsample } = await import("./arms");
    const find = (inSample: boolean): number => {
      for (let seq = 1; seq < 1000; seq += 1) if (reasonSubsample(assignArm("export-salt", seq).seed, seq) === inSample) return seq;
      throw new Error("no such position");
    };
    const saved = process.env["KERYX_DECISIONS_REASON_SUBSAMPLE"];
    delete process.env["KERYX_DECISIONS_REASON_SUBSAMPLE"];
    try {
      await open("asked-named", find(true));
      await answerDecision({ cwd: root, id: "asked-named", choice: "x" });
      await recordReason(root, "asked-named", "REASONTEXT-unique-words-here");
      await open("asked-silent", find(true));
      await answerDecision({ cwd: root, id: "asked-silent", choice: "y" });
      await recordReason(root, "asked-silent", undefined);
      await open("not-asked", find(false));
      await answerDecision({ cwd: root, id: "not-asked", choice: "x" });
      await open("forced", find(true), { irreversible: true });
      await answerDecision({ cwd: root, id: "forced", choice: "y" });
    } finally {
      if (saved === undefined) delete process.env["KERYX_DECISIONS_REASON_SUBSAMPLE"];
      else process.env["KERYX_DECISIONS_REASON_SUBSAMPLE"] = saved;
    }
    expect(EXPORT_FIELDS).toContain("eligible");
    expect(EXPORT_FIELDS).toContain("reasonRequested");
    expect(EXPORT_FIELDS).toContain("reasonNamed");

    const rows = await loadExport(root);
    expect(rows).toHaveLength(4);
    const flags = rows.map((row) => [row.eligible, row.reasonRequested, row.reasonNamed]);
    // the rows are in journal order: named, silent, not asked, forced
    expect(flags).toEqual([
      [true, true, true],
      [true, true, false],
      [true, false, false],
      [false, false, false],
    ]);
    for (const format of ["jsonl", "json"] as const) {
      const text = renderExport(rows, format);
      expect(text).not.toContain("REASONTEXT");
      expect(text).not.toContain("unique-words");
      expect(text).toContain('"reasonRequested"');
      expect(text).toContain('"reasonNamed"');
    }
  });
});
