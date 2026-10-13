import { describe, expect, test } from "bun:test";
import { touchesChunkEstimateAnswer, touchesCoverageWaiver, touchesHumanConfirmation } from "./command-risk";

describe("coverage waiver floor is decided on parsed words (R2-05)", () => {
  const spellings: Array<[string, string]> = [
    ["plain", 'keryx review complete p --waive-coverage "a real operator quote"'],
    ["equals form", "keryx review complete p --waive-coverage=quote-here"],
    ["split double quote", 'keryx review complete p --waive-""coverage "a real operator quote"'],
    ["split single quote", "keryx review complete p --waive-cov''erage 'a real operator quote'"],
    ["quoted whole flag", "keryx review complete p '--waive-coverage' 'a real operator quote'"],
    ["backslash", 'keryx review complete p --waive\\-coverage "a real operator quote"'],
    ["ANSI-C hex", "keryx review complete p $'\\x2d\\x2dwaive-coverage' 'a real operator quote'"],
    ["ANSI-C octal", "keryx review complete p $'\\055\\055waive-coverage' 'a real operator quote'"],
    ["ANSI-C unicode", "keryx review complete p $'\\u002d\\u002dwaive-coverage' 'a real operator quote'"],
    ["env prefix", 'KERYX_X=1 FOO="a b" keryx review complete p --waive-""coverage "quote quote"'],
    ["env wrapper", "env -u X keryx review complete p --waive-''coverage 'quote quote'"],
    ["bash -c", `bash -c 'keryx review complete p --waive-""coverage "quote quote"'`],
    ["eval", `eval "keryx review complete p --waive-''coverage 'quote quote'"`],
    ["nested shell", `sh -c "bash -c 'keryx review complete p --waive-\\"\\"coverage x'"`],
    ["after a separator", "echo hi; keryx review complete p --waive-''coverage 'quote quote'"],
    ["variable in flag position", 'F=--waive-; keryx review complete p ${F}coverage "quote quote"'],
    ["variable holds whole flag", 'keryx review complete p $FLAG "quote quote"'],
    ["command substitution", 'keryx review complete p $(printf %s -- waive-coverage) "quote quote"'],
    ["backtick substitution", 'keryx review complete p `echo --waive-coverage` "quote quote"'],
    ["upper case", "KERYX REVIEW COMPLETE p --WAIVE-COVERAGE x"],
  ];
  for (const [name, command] of spellings) {
    test(`asks: ${name}`, () => {
      expect(touchesCoverageWaiver(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    });
  }

  test("an ordinary close and unrelated commands stay prompt-free", () => {
    for (const command of [
      "keryx review complete p",
      'keryx review complete p --finding F-001 --disposition acted-on --evidence "fixed in abc"',
      "keryx review chunks next --package p",
      "echo coverage waive",
      "git commit -m 'waive nothing'",
    ]) {
      expect(touchesCoverageWaiver(command)).toBe(false);
    }
  });
});

describe("chunk estimate answer floor (R2-16)", () => {
  test("asks for every spelling of --answer", () => {
    for (const command of [
      'keryx review chunks estimate --package p --answer yes --quote "operator said go"',
      "keryx review chunks estimate --package p --answer=yes --quote x",
      "keryx review chunks estimate --package p --ans''wer yes --quote x",
      "keryx review chunks estimate --package p --answ\\er yes --quote x",
      "bash -c 'keryx review chunks estimate --package p --answer yes --quote x'",
      "FOO=1 keryx review chunks estimate --answer yes",
    ]) {
      expect(touchesChunkEstimateAnswer(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    }
  });

  test("reading the estimate and the other chunk verbs stay prompt-free", () => {
    for (const command of [
      "keryx review chunks estimate --package p",
      "keryx review chunks next --package p",
      "keryx review chunks plan --package p",
      "echo --answer yes",
    ]) {
      expect(touchesChunkEstimateAnswer(command)).toBe(false);
    }
  });
});
