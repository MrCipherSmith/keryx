// A question nobody can answer is answered by the safe default, and the answer is on record.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ENV_AUTONOMOUS_ANSWERS_FILE,
  autonomousAnswersEnabled,
  answerAutonomously,
  readAutoAnswers,
  setQuestionArbiter,
  type AutoAnswerRecord,
} from "./autonomous-answers";
import { CANCEL_ANSWER } from "../decisions/service";

const dirs: string[] = [];
afterEach(() => {
  setQuestionArbiter(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "autonomous-answers-"));
  dirs.push(dir);
  return dir;
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    question: "Which plan?",
    options: [
      { id: "a", label: "A", description: "first" },
      { id: "b", label: "B", description: "second", recommended: true },
    ],
    ...overrides,
  }) as Parameters<typeof answerAutonomously>[0];

describe("enabled", () => {
  test("only when the runner sets the file variable", () => {
    expect(autonomousAnswersEnabled({})).toBe(false);
    expect(autonomousAnswersEnabled({ [ENV_AUTONOMOUS_ANSWERS_FILE]: "/x" })).toBe(true);
  });
});

describe("safe default", () => {
  test("takes the recommended option, and records it", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    const answer = await answerAutonomously(request(), { file, now: () => new Date("2026-10-11T10:00:00Z") });
    expect(answer).toBe("b");
    const records = readAutoAnswers(file);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ question: "Which plan?", answer: "b", basis: "recommended", at: "2026-10-11T10:00:00.000Z" });
  });

  test("takes the first option when none is recommended", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    const req = request({ options: [{ id: "x", label: "X", description: "" }, { id: "y", label: "Y", description: "" }] });
    expect(await answerAutonomously(req, { file })).toBe("x");
    expect(readAutoAnswers(file)[0]?.basis).toBe("first");
  });

  test("refuses an irreversible question", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    const answer = await answerAutonomously(request({ irreversible: true }), { file });
    expect(answer).toBe(CANCEL_ANSWER);
    expect(readAutoAnswers(file)[0]?.basis).toBe("refused-irreversible");
  });

  test("never waits: with no options it refuses", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    const answer = await answerAutonomously(request({ options: [] }), { file });
    expect(answer).toBe(CANCEL_ANSWER);
    expect(readAutoAnswers(file)[0]?.basis).toBe("refused-no-option");
  });

  test("a journal that cannot be written does not stop the answer", async () => {
    const answer = await answerAutonomously(request(), { file: path.join(tmp(), "missing", "dir", "a.ndjson") });
    expect(answer).toBe("b");
  });
});

describe("arbiter hook", () => {
  test("an arbiter verdict of allow is used, with its rule", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    setQuestionArbiter(async () => ({ verdict: "allow", answer: "a", rule: "R-7" }));
    expect(await answerAutonomously(request(), { file })).toBe("a");
    expect(readAutoAnswers(file)[0]).toMatchObject({ basis: "arbiter", rule: "R-7", answer: "a" });
  });

  test("deny and escalate fall back to refusal, not to the recommendation", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    setQuestionArbiter(async () => ({ verdict: "deny", rule: "R-1" }));
    expect(await answerAutonomously(request(), { file })).toBe(CANCEL_ANSWER);
    setQuestionArbiter(async () => ({ verdict: "escalate", rule: "R-2" }));
    expect(await answerAutonomously(request(), { file })).toBe(CANCEL_ANSWER);
    const records: AutoAnswerRecord[] = readAutoAnswers(file);
    expect(records.map((r) => r.basis)).toEqual(["arbiter-deny", "arbiter-escalate"]);
  });

  test("an arbiter that throws is ignored and the safe default answers", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    setQuestionArbiter(async () => {
      throw new Error("down");
    });
    expect(await answerAutonomously(request(), { file })).toBe("b");
  });

  test("an allow naming an option that is not offered is ignored", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    setQuestionArbiter(async () => ({ verdict: "allow", answer: "zzz", rule: "R-9" }));
    expect(await answerAutonomously(request(), { file })).toBe("b");
  });
});

describe("irreversible", () => {
  test("is refused even when an arbiter would allow it", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    setQuestionArbiter(async () => ({ verdict: "allow", answer: "a", rule: "R-1" }));
    expect(await answerAutonomously(request({ irreversible: true }), { file })).toBe(CANCEL_ANSWER);
  });
});

describe("journal file", () => {
  test("is append-only NDJSON", async () => {
    const file = path.join(tmp(), "answers.ndjson");
    await answerAutonomously(request(), { file });
    await answerAutonomously(request(), { file });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a missing file reads as no answers", () => {
    expect(readAutoAnswers(path.join(tmp(), "none.ndjson"))).toEqual([]);
  });
});
