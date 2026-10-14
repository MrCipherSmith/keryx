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
    ["backtick substitution that holds no flag text", "keryx review complete p `printf %s zzz` x"],
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
      "keryx review chunks --answer yes $'est\\x69mate'",
      "keryx review chunks $'estimate' $'\\x2d\\x2danswer' 5",
      "bash -c 'keryx review chunks --answer yes estimate'",
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
      "keryx review chunks estimate --package p; echo --answer yes",
      "keryx review chunks estimate --package p && echo --answer yes",
    ]) {
      expect(touchesChunkEstimateAnswer(command)).toBe(false);
    }
  });
});

describe("the floor asks for a keryx command, not for prose that names it (R3-04)", () => {
  const notAsked: Array<[string, string]> = [
    ["a search for the flag", 'keryx ctx rg -n -- "--waive-coverage" src'],
    ["a commit message about the flag", 'git commit -m "docs: explain --waive-coverage"'],
    ["a PR body naming the command and a variable", 'gh pr create --body "see keryx review complete then $VAR"'],
    ["a plain complete", "keryx review complete --package p"],
    ["a complete whose package is a variable", 'keryx review complete --package "$PKG"'],
    ["an echo of the flag", 'echo "pass --waive-coverage to keryx"'],
    ["a layers refresh with a variable", 'keryx review layers refresh --package "$PKG"'],
    ["a chunks next with a variable", 'keryx review chunks next --package "$PKG"'],
  ];
  for (const [name, command] of notAsked) {
    test(`does not ask: ${name}`, () => {
      expect(touchesCoverageWaiver(command)).toBe(false);
      expect(touchesChunkEstimateAnswer(command)).toBe(false);
      expect(touchesHumanConfirmation(command)).toBe(false);
    });
  }

  test("a keryx command behind a program the parser does not unwrap still asks", () => {
    expect(touchesCoverageWaiver('find . -exec keryx review complete p --waive-coverage "a real operator quote" \;')).toBe(true);
  });
});

describe("a verb or flag the shell assembles asks too (R3-01)", () => {
  const assembled: Array<[string, string]> = [
    ["answer from an assignment", "A=--answer; keryx review chunks estimate --package p $A yes --quote x"],
    ["answer split by an expansion", "keryx review chunks estimate --package p --ans${X}wer yes --quote x"],
    ["answer behind brace expansion", "keryx review chunks estimate --package p --{answer,x} yes --quote x"],
    ["opaque chunks verb", "keryx review $V estimate --package p --answer yes --quote x"],
    ["opaque subcommand slot", "keryx review chunks $S --package p --quote x"],
    ["opaque group and verb beside the flag", "keryx review $G $V --answer yes --quote x"],
  ];
  for (const [name, command] of assembled) {
    test(`chunk answer: ${name}`, () => {
      expect(touchesChunkEstimateAnswer(command)).toBe(true);
    });
  }
  const waiver: Array<[string, string]> = [
    ["opaque complete", "keryx review $C p ${F}coverage q"],
    ["brace-expanded flag", 'keryx review complete p --waive-{coverage,x} "a real operator quote"'],
    ["opaque complete, literal flag", 'keryx review $C p --waive-coverage "a real operator quote"'],
    ["opaque head", 'KERYX=keryx; $KERYX review complete p ${F}coverage "a real operator quote"'],
  ];
  for (const [name, command] of waiver) {
    test(`waiver: ${name}`, () => {
      expect(touchesCoverageWaiver(command)).toBe(true);
    });
  }
});
