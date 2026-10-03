// Flow 400 (AC12): `rate` and `rate --blind-model`. The model call is the injectable seam, so no
// test here reaches a real model; `cleanContext` is checked against what the fake call reports.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerDecision, openDecision } from "./journal";
import {
  MODEL_LABEL,
  buildBlindPrompt,
  buildQualityMatrix,
  commandModelCall,
  parseModelChoice,
  rateBlindModel,
  rateDecision,
  readQuality,
  renderQualityMatrix,
  stripRecommendationMark,
  type ModelCallFn,
  type ModelCallRequest,
} from "./quality";
import { buildReport, renderReport } from "./report";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-quality-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "keep", label: "Keep it (recommended)", description: "No change" },
  { id: "move", label: "Move it", description: "Recommended: a new home" },
  { id: "drop", label: "Drop it" },
];

async function decide(id: string, choice: string, arm: "A" | "D" = "A"): Promise<void> {
  await openDecision({
    cwd: root,
    id,
    question: `Where does ${id} go? (recommended: keep)`,
    options: OPTIONS,
    recommendation: { optionId: "keep", reason: "SECRET-REASON keeps the diff small" },
    arm,
    salt: "s",
    seq: 1,
  });
  await answerDecision({ cwd: root, id, choice });
}

/** A fake model: answers with a fixed number and records every request it was given. */
function fakeModel(reply: string, historyMessages = 0): { call: ModelCallFn; requests: ModelCallRequest[] } {
  const requests: ModelCallRequest[] = [];
  return {
    requests,
    call: async (request) => {
      requests.push(request);
      return { text: reply, historyMessages };
    },
  };
}

describe("AC12: the human's rating", () => {
  test("rate writes a QualityRecord with rater human and no model fields", async () => {
    await decide("d-1", "move");
    const record = await rateDecision({ cwd: root, id: "d-1", quality: "bad", note: "the  list\nwas wrong", now: () => new Date("2026-10-03T12:00:00Z") });
    expect(record).toMatchObject({ seq: 1, decisionId: "d-1", rater: "human", quality: "bad", note: "the list was wrong", at: "2026-10-03T12:00:00.000Z" });
    expect(record.model).toBeUndefined();
    expect(record.cleanContext).toBeUndefined();
    expect(await readQuality(root)).toEqual([record]);
  });

  test("a second rating is a new line with the next seq, and the earlier one stays", async () => {
    await decide("d-1", "keep");
    await rateDecision({ cwd: root, id: "d-1", quality: "unclear" });
    const second = await rateDecision({ cwd: root, id: "d-1", quality: "good" });
    expect(second.seq).toBe(2);
    expect((await readQuality(root)).map((r) => r.quality)).toEqual(["unclear", "good"]);
  });

  test("an unknown decision and an unanswered one are refused", async () => {
    await expect(rateDecision({ cwd: root, id: "nope", quality: "good" })).rejects.toThrow(/no decision with id nope/);
    await openDecision({ cwd: root, id: "open-1", question: "Q?", options: OPTIONS, recommendation: { optionId: "keep", reason: "r" }, arm: "A", salt: "s", seq: 2 });
    await expect(rateDecision({ cwd: root, id: "open-1", quality: "good" })).rejects.toThrow(/not answered yet/);
  });

  test("the rating never touches the decision journal", async () => {
    await decide("d-1", "keep");
    const before = (await readRecords(root)).length;
    await rateDecision({ cwd: root, id: "d-1", quality: "good" });
    expect((await readRecords(root)).length).toBe(before);
  });
});

describe("AC12: rate --blind-model", () => {
  test("a model rating carries rater model, the model label and cleanContext true for a fresh call", async () => {
    await decide("d-1", "move");
    const model = fakeModel("1");
    const result = await rateBlindModel({ cwd: root, model: "test-model", call: model.call });
    expect(result.rated).toHaveLength(1);
    expect(result.rated[0]).toMatchObject({ decisionId: "d-1", rater: "model", model: "test-model", cleanContext: true, modelAgree: true, quality: "good" });
    expect(await readQuality(root)).toEqual(result.rated);
  });

  test("cleanContext is true only when the call really got no history", async () => {
    await decide("d-1", "keep");
    await decide("d-2", "keep");
    const clean = await rateBlindModel({ cwd: root, model: "fresh", call: fakeModel("1", 0).call, id: "d-1" });
    const dirty = await rateBlindModel({ cwd: root, model: "chatty", call: fakeModel("1", 3).call, id: "d-2" });
    expect(clean.rated[0]?.cleanContext).toBe(true);
    expect(dirty.rated[0]?.cleanContext).toBe(false);
  });

  test("the request is always built with an empty history", async () => {
    await decide("d-1", "keep");
    const model = fakeModel("1");
    await rateBlindModel({ cwd: root, model: "m", call: model.call });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.history).toEqual([]);
  });

  test("the prompt has no mark, no reason, no choice and no recommendation, and uses numbers not ids", async () => {
    await decide("d-1", "move");
    const model = fakeModel("2");
    await rateBlindModel({ cwd: root, model: "m", call: model.call });
    const text = `${model.requests[0]?.system}\n${model.requests[0]?.user}`;
    expect(text).not.toMatch(/recommend/i);
    expect(text).not.toContain("SECRET-REASON");
    expect(text).not.toMatch(/\b(keep|move|drop)\b(?!\s+it)/);
    expect(text).toContain("1. Keep it - No change");
    expect(text).toContain("2. Move it - a new home");
    expect(text).toContain("3. Drop it");
  });

  test("the model sees the options in the order the human saw them", () => {
    const prompt = buildBlindPrompt({ question: "Q?", options: OPTIONS, order: ["drop", "keep", "move"] });
    expect(prompt.ids).toEqual(["drop", "keep", "move"]);
    expect(prompt.user.indexOf("Drop it")).toBeLessThan(prompt.user.indexOf("Keep it"));
  });

  test("the answer is mapped through the shown order: agreement is with the recommended option, not position 1", async () => {
    // `random` drives the shuffle: 0 puts the recommended option last ("move", "skip", "keep"), 0.999 leaves the given order.
    // The options carry no weak irreversible word (OPTIONS' "Drop it" would force arm A and skip the shuffle altogether).
    const options = [
      { id: "keep", label: "Keep it", description: "No change" },
      { id: "move", label: "Move it", description: "A new home" },
      { id: "skip", label: "Skip it" },
    ];
    for (const [id, random, order, agree] of [
      ["d-last", () => 0, ["move", "skip", "keep"], false],
      ["d-first", () => 0.999, ["keep", "move", "skip"], true],
    ] as const) {
      await openDecision({ cwd: root, id, question: "Q?", options, recommendation: { optionId: "keep", reason: "r" }, arm: "D", salt: "s", seq: 1, random });
      await answerDecision({ cwd: root, id, choice: "keep" });
      const open = (await readRecords(root)).find((r) => r.kind === "open" && r.id === id);
      expect(open).toMatchObject({ arm: "D", forced: false });
      expect(open?.kind === "open" ? open.order : undefined).toEqual([...order]);
      // the model answers "1": the first option it was shown
      const result = await rateBlindModel({ cwd: root, model: "m", call: fakeModel("1").call, id });
      expect(result.rated[0]?.modelAgree).toBe(agree);
    }
  });

  test("a disagreeing pick is bad and an unreadable or 0 answer is unclear", async () => {
    await decide("d-1", "keep");
    await decide("d-2", "keep");
    await decide("d-3", "keep");
    const bad = await rateBlindModel({ cwd: root, model: "m", call: fakeModel("3").call, id: "d-1" });
    const zero = await rateBlindModel({ cwd: root, model: "m", call: fakeModel("0").call, id: "d-2" });
    const text = await rateBlindModel({ cwd: root, model: "m", call: fakeModel("I cannot tell").call, id: "d-3" });
    expect([bad.rated[0], zero.rated[0], text.rated[0]].map((r) => [r?.quality, r?.modelAgree])).toEqual([
      ["bad", false],
      ["unclear", false],
      ["unclear", false],
    ]);
  });

  test("a decision the model already rated is skipped; backfilled, unanswered and recommendation-free ones are not rated", async () => {
    await decide("d-1", "keep");
    await openDecision({ cwd: root, id: "open-1", question: "Q?", options: OPTIONS, recommendation: { optionId: "keep", reason: "r" }, arm: "A", salt: "s", seq: 2 });
    await openDecision({ cwd: root, id: "norec", question: "Q?", options: OPTIONS, arm: "A", salt: "s", seq: 3 });
    await answerDecision({ cwd: root, id: "norec", choice: "keep" });
    const model = fakeModel("1");
    const first = await rateBlindModel({ cwd: root, model: "m", call: model.call });
    const again = await rateBlindModel({ cwd: root, model: "m", call: model.call });
    expect(first.rated.map((r) => r.decisionId)).toEqual(["d-1"]);
    expect(again.rated).toEqual([]);
    expect(model.requests).toHaveLength(1);
    // another model label is a separate rating
    expect((await rateBlindModel({ cwd: root, model: "other", call: model.call })).rated).toHaveLength(1);
  });

  test("a failing call skips that decision with a reason and goes on", async () => {
    await decide("d-1", "keep");
    await decide("d-2", "keep");
    let n = 0;
    const flaky: ModelCallFn = async () => {
      n += 1;
      if (n === 1) throw new Error("the model command exited with 1: boom");
      return { text: "1", historyMessages: 0 };
    };
    const result = await rateBlindModel({ cwd: root, model: "m", call: flaky });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("boom");
    expect(result.rated).toHaveLength(1);
  });

  test("the command call is a fresh process fed the prompt on stdin, with no history", async () => {
    const call = commandModelCall("cat >/dev/null; echo 2");
    const reply = await call({ system: "sys", user: "usr", history: [] });
    expect(reply).toEqual({ text: "2\n", historyMessages: 0 });
    await expect(commandModelCall("exit 3")({ system: "s", user: "u", history: [] })).rejects.toThrow(/exited with 3/);
  });
});

describe("AC12: the prompt helpers", () => {
  test("stripRecommendationMark removes the textual marks and nothing else", () => {
    expect(stripRecommendationMark("Keep it (recommended)")).toBe("Keep it");
    expect(stripRecommendationMark("★ Keep it")).toBe("Keep it");
    expect(stripRecommendationMark("Recommended: Keep it")).toBe("Keep it");
    expect(stripRecommendationMark("Keep it [рекомендуется]")).toBe("Keep it");
    expect(stripRecommendationMark("Keep it")).toBe("Keep it");
  });

  test("the blind prompt carries none of the forms the blind human was not shown (labels, descriptions, question)", () => {
    const forms = ["Use X (preferred)", "Recommended - use Y", "Рекомендуется: V", "the recommended way, suggested by docs"];
    for (const form of forms) expect(stripRecommendationMark(form)).not.toMatch(/recommend|preferred|suggested|рекоменд/iu);
    expect(stripRecommendationMark("Use X (preferred)")).toBe("Use X");
    expect(stripRecommendationMark("Recommended - use Y")).toBe("use Y");
    expect(stripRecommendationMark("Рекомендуется: V")).toBe("V");
    expect(stripRecommendationMark("the recommended way, suggested by docs")).toBe("the way, by docs");

    const prompt = buildBlindPrompt({
      question: forms[3] as string,
      options: forms.map((form, i) => ({ id: `o${i}`, label: form, description: form })),
      order: ["o0", "o1", "o2", "o3"],
    });
    expect(`${prompt.system}\n${prompt.user}`).not.toMatch(/recommend|preferred|suggested|рекоменд/iu);
  });

  test("parseModelChoice maps a number to an id and anything else to unclear", () => {
    expect(parseModelChoice("2", ["a", "b"])).toBe("b");
    expect(parseModelChoice("Answer: 1.", ["a", "b"])).toBe("a");
    expect(parseModelChoice("0", ["a", "b"])).toBe("unclear");
    expect(parseModelChoice("3", ["a", "b"])).toBe("unclear");
    expect(parseModelChoice("none", ["a", "b"])).toBe("unclear");
  });
});

describe("AC12: the matrix and its label", () => {
  test("human rating (rows) against model self-assessment (columns); the latest rating wins", async () => {
    await decide("d-1", "keep");
    await decide("d-2", "move");
    await rateDecision({ cwd: root, id: "d-1", quality: "good", now: () => new Date("2026-10-03T10:00:00Z") });
    await rateDecision({ cwd: root, id: "d-2", quality: "bad", now: () => new Date("2026-10-03T10:00:00Z") });
    await rateBlindModel({ cwd: root, model: "m", call: fakeModel("1").call, now: () => new Date("2026-10-03T11:00:00Z") });
    const matrix = buildQualityMatrix(await readQuality(root), new Map([["d-1", true], ["d-2", false]]));
    expect(matrix.humanRated).toBe(2);
    expect(matrix.modelRated).toBe(2);
    expect(matrix.modelClean).toBe(2);
    expect(matrix.humanVsModel.good.good).toBe(1);
    expect(matrix.humanVsModel.bad.good).toBe(1);
    expect(matrix.byChoice.followed.good).toBe(1);
    expect(matrix.byChoice.deviated.bad).toBe(1);
  });

  test("a human rating without a model rating lands in the not-rated column", async () => {
    await decide("d-1", "keep");
    await rateDecision({ cwd: root, id: "d-1", quality: "unclear" });
    const matrix = buildQualityMatrix(await readQuality(root), new Map([["d-1", true]]));
    expect(matrix.humanVsModel.unclear.notRated).toBe(1);
    expect(matrix.modelRated).toBe(0);
  });

  test("a rating of a decision the report does not know is left out", async () => {
    await decide("d-1", "keep");
    await rateDecision({ cwd: root, id: "d-1", quality: "good" });
    const matrix = buildQualityMatrix(await readQuality(root), new Map());
    expect(matrix.humanRated).toBe(0);
  });

  test("the rendered matrix labels the model ratings 'model self-assessment' and says why", async () => {
    await decide("d-1", "keep");
    await rateDecision({ cwd: root, id: "d-1", quality: "good" });
    await rateBlindModel({ cwd: root, model: "m", call: fakeModel("1").call });
    const lines = renderQualityMatrix(buildQualityMatrix(await readQuality(root), new Map([["d-1", true]]))).join("\n");
    expect(MODEL_LABEL).toBe("model self-assessment");
    expect(lines).toContain("model self-assessment: 1 rated, 1 in a clean context");
    expect(lines).toContain("columns");
    expect(lines).toMatch(/may be the one that wrote the recommendation/);
  });

  test("the report carries the matrix and prints the label", async () => {
    await decide("d-1", "keep");
    await rateDecision({ cwd: root, id: "d-1", quality: "good" });
    await rateBlindModel({ cwd: root, model: "m", call: fakeModel("1").call });
    const report = buildReport(await readRecords(root), 0, { quality: await readQuality(root) });
    expect(report.quality.humanRated).toBe(1);
    expect(report.quality.modelRated).toBe(1);
    expect(renderReport(report)).toContain("model self-assessment");
  });

  test("with no ratings the report says so instead of printing an empty matrix", async () => {
    await decide("d-1", "keep");
    const report = buildReport(await readRecords(root));
    expect(renderReport(report)).toContain("Recommendation quality: no ratings yet");
  });
});
