// Flow 400 (AC17): the optional "why" on a deterministic one-third of the eligible questions, whatever the
// answer. The subsample is a hash of (seed, seq), decided and written on the open record BEFORE the question is
// shown, and the prompt is the same one a deviation gets (the flow-401 free-text row), not a second prompt.
//
// The test preload turns the subsample off for the rest of the suite (the salt is random per fixture, so a test
// that expects "no prompt on agreement" would fail one run in three); this file turns it back on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assignArm, REASON_SUBSAMPLE_SHARE, reasonSubsample, saltFile } from "./arms";
import { journalAsk, type AskRequest } from "./ask";
import { answerDecision, openDecision, REASON_SUBSAMPLE_ENV } from "./journal";
import { readRecords } from "./store";
import type { AnswerRecord, OpenRecord, ReasonRecord } from "./types";

let root: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-reasons-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  savedEnv = process.env[REASON_SUBSAMPLE_ENV];
  delete process.env[REASON_SUBSAMPLE_ENV];
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[REASON_SUBSAMPLE_ENV];
  else process.env[REASON_SUBSAMPLE_ENV] = savedEnv;
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
];
const REC = { optionId: "a", reason: "least risk" };
const SALT = "reasons-test-salt";

/** The first position at which the salt puts a decision in (or out of) the reason subsample. */
function firstSeq(salt: string, inSample: boolean): number {
  for (let seq = 1; seq < 1000; seq += 1) {
    if (reasonSubsample(assignArm(salt, seq).seed, seq) === inSample) return seq;
  }
  throw new Error("no such position");
}

const opens = async (): Promise<OpenRecord[]> => (await readRecords(root)).filter((r): r is OpenRecord => r.kind === "open");
const reasonsOf = async (): Promise<ReasonRecord[]> => (await readRecords(root)).filter((r): r is ReasonRecord => r.kind === "reason");

/** Make the next question the `seq`-th of this repository, with the repository salt fixed to SALT. */
async function placeAt(seq: number): Promise<void> {
  const file = await saltFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${SALT}-${SALT}\n`, "utf8");
  for (let i = 1; i < seq; i += 1) {
    await openDecision({ cwd: root, id: `filler-${i}`, question: `Filler ${i}?`, options: OPTIONS, arm: "A", salt: SALT, seq: i });
  }
}

describe("AC17: the subsample is a deterministic third, chosen from the seed and the position", () => {
  test("the same (seed, seq) is in or out on every call, and golden pairs stay put", () => {
    const golden: Array<[number, number, boolean]> = [
      [assignArm("golden-salt", 1).seed, 1, false],
      [assignArm("golden-salt", 2).seed, 2, true],
      [assignArm("golden-salt", 3).seed, 3, true],
      [assignArm("golden-salt", 4).seed, 4, false],
      [assignArm("golden-salt", 9).seed, 9, true],
    ];
    for (const [seed, seq, expected] of golden) {
      for (let i = 0; i < 3; i += 1) expect(reasonSubsample(seed, seq)).toBe(expected);
    }
    // a different position of the same seed is a different draw
    const outcomes = new Set(Array.from({ length: 30 }, (_, seq) => reasonSubsample(12345, seq + 1)));
    expect(outcomes).toEqual(new Set([true, false]));
  });

  test("about one in three is in, and the draw does not follow the arm", () => {
    const runs = 3000;
    const byArm: Record<string, { in: number; all: number }> = { A: { in: 0, all: 0 }, B: { in: 0, all: 0 }, C: { in: 0, all: 0 }, D: { in: 0, all: 0 } };
    let inSample = 0;
    for (let seq = 1; seq <= runs; seq += 1) {
      const { arm, seed } = assignArm("share-check", seq);
      const chosen = reasonSubsample(seed, seq);
      if (chosen) inSample += 1;
      const cell = byArm[arm] as { in: number; all: number };
      cell.all += 1;
      if (chosen) cell.in += 1;
    }
    expect(REASON_SUBSAMPLE_SHARE).toBeCloseTo(1 / 3, 10);
    expect(inSample / runs).toBeGreaterThan(0.3);
    expect(inSample / runs).toBeLessThan(0.37);
    for (const cell of Object.values(byArm)) {
      expect(cell.in / cell.all).toBeGreaterThan(0.26);
      expect(cell.in / cell.all).toBeLessThan(0.41);
    }
  });
});

describe("AC17: reasonRequested is recorded on the open record, before the question is shown", () => {
  test("a position in the subsample is recorded as reasonRequested: true with eligible: true", async () => {
    const seq = firstSeq(SALT, true);
    const opened = await openDecision({ cwd: root, id: "in", question: "Which?", options: OPTIONS, recommendation: REC, arm: "B", salt: SALT, seq });
    expect(opened).toMatchObject({ reasonRequested: true, eligible: true });
    const [record] = await opens();
    expect(record).toMatchObject({ id: "in", reasonRequested: true, eligible: true, seq });
    // nothing has been answered yet: the record was written ahead of the display
    expect((await readRecords(root)).map((r) => r.kind)).toEqual(["open"]);
  });

  test("a position outside the subsample is recorded as reasonRequested: false", async () => {
    const seq = firstSeq(SALT, false);
    const opened = await openDecision({ cwd: root, id: "out", question: "Which?", options: OPTIONS, recommendation: REC, arm: "B", salt: SALT, seq });
    expect(opened.reasonRequested).toBe(false);
    expect((await opens())[0]).toMatchObject({ reasonRequested: false, eligible: true });
  });

  test("opening the same question again does not redraw it", async () => {
    const seq = firstSeq(SALT, true);
    const first = await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq });
    const again = await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq: seq + 1 });
    expect(again.id).toBe(first.id);
    expect(again.reasonRequested).toBe(true);
    expect(await opens()).toHaveLength(1);
  });

  test("an irreversible question is not eligible and never in the subsample, even at a position that would be", async () => {
    const seq = firstSeq(SALT, true);
    const opened = await openDecision({ cwd: root, question: "Delete it?", options: OPTIONS, recommendation: REC, irreversible: true, salt: SALT, seq });
    expect(opened).toMatchObject({ forced: true, eligible: false, reasonRequested: false });
    expect((await opens())[0]).toMatchObject({ forced: true, eligible: false, reasonRequested: false });
  });

  test("a surface that cannot take free text (reasonPrompt: false) is left out of the subsample", async () => {
    const seq = firstSeq(SALT, true);
    const opened = await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq, reasonPrompt: false });
    expect(opened).toMatchObject({ eligible: true, reasonRequested: false });
  });

  test("the environment switch turns the subsample off and is recorded as false", async () => {
    process.env[REASON_SUBSAMPLE_ENV] = "off";
    const seq = firstSeq(SALT, true);
    const opened = await openDecision({ cwd: root, question: "Which?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq });
    expect(opened.reasonRequested).toBe(false);
  });
});

describe("AC17: the prompt after the answer, matched or not", () => {
  test("answer says to ask once when the decision is in the subsample, even though the choice matched", async () => {
    const seq = firstSeq(SALT, true);
    await openDecision({ cwd: root, id: "d", question: "Which?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq });
    const answered = await answerDecision({ cwd: root, id: "d", choice: "a" });
    expect(answered).toMatchObject({ matched: true, deviation: false, askReason: true });
    // offered once: a changed answer does not ask again
    expect((await answerDecision({ cwd: root, id: "d", choice: "b" })).askReason).toBe(false);
  });

  test("a matched decision outside the subsample is not asked; a deviation outside it still is", async () => {
    const seq = firstSeq(SALT, false);
    await openDecision({ cwd: root, id: "m", question: "Matched?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq });
    expect((await answerDecision({ cwd: root, id: "m", choice: "a" })).askReason).toBe(false);
    await openDecision({ cwd: root, id: "x", question: "Deviated?", options: OPTIONS, recommendation: REC, arm: "A", salt: SALT, seq });
    expect((await answerDecision({ cwd: root, id: "x", choice: "b" })).askReason).toBe(true);
  });

  async function ask(inSample: boolean, answers: (request: AskRequest, n: number) => Awaited<ReturnType<Parameters<typeof journalAsk>[0]>>): Promise<AskRequest[]> {
    await placeAt(firstSeq(`${SALT}-${SALT}`, inSample));
    const seen: AskRequest[] = [];
    const run = journalAsk(async (request) => answers(request, seen.push(request)), { cwd: root, arm: "A" });
    await run({ question: "Pick", options: [{ ...OPTIONS[0]!, recommended: true }, OPTIONS[1]!] });
    return seen;
  }

  test("in the subsample, an agreement gets the same free-text prompt a deviation gets, and the text is the reason", async () => {
    const seen = await ask(true, (_request, n) => (n === 1 ? "a" : { kind: "own", text: "least surprise" }));
    expect(seen).toHaveLength(2);
    expect(seen[1]?.question).toContain("Why this choice?");
    // the flow-401 row: a free-form prompt with the two skip options, as after a deviation
    expect(seen[1]?.allowFreeform).toBe(true);
    expect(seen[1]?.options.map((option) => option.id)).toEqual(["skip", "later"]);
    expect(await reasonsOf()).toMatchObject([{ reason: "least surprise" }]);
    expect((await opens()).at(-1)).toMatchObject({ reasonRequested: true });
  });

  test("in the subsample, an empty answer is recorded as no reason and counts as the one ask", async () => {
    const seen = await ask(true, (_request, n) => (n === 1 ? "a" : "skip"));
    expect(seen).toHaveLength(2);
    const reasons = await reasonsOf();
    expect(reasons).toHaveLength(1);
    expect(reasons[0] && "reason" in reasons[0]).toBe(false);
  });

  test("outside the subsample, an agreement asks nothing more", async () => {
    const seen = await ask(false, () => "a");
    expect(seen).toHaveLength(1);
    expect(await reasonsOf()).toEqual([]);
    expect((await opens()).at(-1)).toMatchObject({ reasonRequested: false });
  });

  test("outside the subsample, a deviation still gets the prompt with its own wording", async () => {
    const seen = await ask(false, (_request, n) => (n === 1 ? "b" : { kind: "own", text: "too slow" }));
    expect(seen).toHaveLength(2);
    expect(seen[1]?.question).toContain("You chose differently");
    expect(await reasonsOf()).toMatchObject([{ reason: "too slow" }]);
  });

  test("a reason typed with the pick (flow 401) is the reason: no second prompt", async () => {
    const seen = await ask(true, () => ({ kind: "option", choice: "a", reason: "typed with the pick" }));
    expect(seen).toHaveLength(1);
    expect(await reasonsOf()).toMatchObject([{ reason: "typed with the pick" }]);
  });

  test("a picker that cannot take free text is never asked, and is left out of the subsample", async () => {
    await placeAt(firstSeq(`${SALT}-${SALT}`, true));
    const seen: AskRequest[] = [];
    const run = journalAsk(async (request) => (seen.push(request), "a"), { cwd: root, arm: "A", askReason: false });
    await run({ question: "Pick", options: [{ ...OPTIONS[0]!, recommended: true }, OPTIONS[1]!] });
    expect(seen).toHaveLength(1);
    expect((await opens()).at(-1)).toMatchObject({ reasonRequested: false });
    const answers = (await readRecords(root)).filter((r): r is AnswerRecord => r.kind === "answer");
    expect(answers.at(-1)).toMatchObject({ choice: "a" });
  });
});
