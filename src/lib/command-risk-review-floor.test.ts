import { describe, expect, test } from "bun:test";
import { touchesChunkEstimateAnswer, touchesCoverageWaiver, touchesHumanConfirmation } from "./command-risk";

function deepBashC(command: string, levels: number): string {
  let out = command;
  for (let i = 0; i < levels; i++) out = `bash -c ${JSON.stringify(out)}`;
  return out;
}

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
    ["ANSI-C inside a double-quoted bash -c", `bash -c "keryx review complete p $'\\\\x2d\\\\x2dwaive-coverage' x"`],
    ["ANSI-C word split by quote dance", `bash -c 'keryx review complete p $'"'"'\\x2d\\x2dwaive-coverage'"'"''`],
    ["ANSI-C inside nested eval", `sh -c "eval \\"keryx review complete p \\$'\\\\x2d\\\\x2dwaive-coverage'\\""`],
    ["line continuation inside the flag", "keryx review complete p --waive-c\\\noverage x"],
    ["line continuation, CRLF", "keryx review complete p --waive-c\\\r\noverage x"],
    ["nested seven bash -c deep", deepBashC(`keryx review complete p --waive-""coverage "quote quote"`, 7)],
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
      `bash -c "keryx review chunks estimate $'\\\\x2d\\\\x2danswer' 5"`,
      "keryx review chunks estimate --ans\\\nwer 5",
      deepBashC("keryx review chunks estimate --ans''wer yes", 7),
    ]) {
      expect(touchesChunkEstimateAnswer(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    }
  });

  test("reading the estimate and the other chunk verbs stay prompt-free", () => {
    for (const command of [
      "keryx review chunks estimate --package p",
      "keryx review chunks next --package p",
      "keryx review chunks next --package p --answer yes",
      "keryx review chunks plan --package p",
      "echo --answer yes",
    ]) {
      expect(touchesChunkEstimateAnswer(command)).toBe(false);
    }
  });
});
