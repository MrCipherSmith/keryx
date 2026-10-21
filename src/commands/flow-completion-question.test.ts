import { expect, test } from "bun:test";
import { completionHostAnswer } from "./review-operator";

const selected = [{ gate: "health" as const, detail: "released regression", reason: "already shipped" }];
const args = (question = "Complete flow 469 with exceptions? health: released regression; reason: already shipped", answer = "да") => [
  "--answered-by", "codex:q469", "--answer-text", answer, "--question-text", question,
];

test("completion records the host's question and operator's words", () => {
  expect(completionHostAnswer(args(), selected, "469", "/tmp", {})).toMatchObject({
    operatorWords: "да", confirmedVia: "host-question",
    hostQuestion: { source: "codex", ref: "q469", answerText: "да" },
  });
});

test("completion refuses a question without the current refusal, reason or flow", () => {
  for (const question of ["Close it?", "flow 469 health already shipped", "health released regression already shipped", "flow 469 health released regression"]) {
    expect(() => completionHostAnswer(args(question), selected, "469", "/tmp", {})).toThrow();
  }
});

test("completion refuses approval of the opposite action", () => {
  expect(() => completionHostAnswer(args("Keep flow 469 open rather than complete it? health: released regression; reason: already shipped"), selected, "469", "/tmp", {})).toThrow();
});

test("completion requires a plain yes, not agent-authored qualified words", () => {
  for (const answer of ["no", "yes but not now", "maybe", "yes run it", "нет"]) {
    expect(() => completionHostAnswer(args(undefined, answer), selected, "469", "/tmp", {})).toThrow();
  }
});

test("completion refuses a nested agent shell or unattended run", () => {
  for (const env of [{ KERYX_TOOL_CALL: "1" }, { KERYX_UNATTENDED: "1" }]) {
    expect(() => completionHostAnswer(args(), selected, "469", "/tmp", env)).toThrow();
  }
});

test("completion refuses malformed and missing host references", () => {
  expect(() => completionHostAnswer(args().slice(2), selected, "469", "/tmp", {})).toThrow();
  expect(() => completionHostAnswer(["--answered-by", "telegram:q", ...args().slice(2)], selected, "469", "/tmp", {})).toThrow();
});


test("a long canonical completion question is preserved without truncation", () => {
  const long = [{ ...selected[0]!, detail: "x".repeat(5000) }];
  const question = `Complete flow 469 with exceptions? health: ${long[0]!.detail}; reason: already shipped`;
  expect(completionHostAnswer(args(question), long, "469", "/tmp", {}).hostQuestion.questionText).toBe(question);
});

for (const length of [100000, 100001]) {
  test(`flow question supported length boundary ${length}`, () => {
    const prefix = "Complete flow 469 with exceptions? health: ";
    const suffix = "; reason: already shipped";
    const long = [{ ...selected[0]!, detail: "x".repeat(length - prefix.length - suffix.length) }];
    const question = `${prefix}${long[0]!.detail}${suffix}`;
    expect(question.length).toBe(length);
    if (length === 100000) expect(completionHostAnswer(args(question), long, "469", "/tmp", {}).hostQuestion.questionText).toBe(question);
    else expect(() => completionHostAnswer(args(question), long, "469", "/tmp", {})).toThrow();
  });
}
