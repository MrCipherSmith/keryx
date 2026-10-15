import { expect, test } from "bun:test";
import { unattendedShellRefusal } from "./unattended";

test("R2-40: an unattended run cannot state the coverage waiver or the over-ceiling answer, in any spelling", () => {
  for (const command of [
    'keryx review complete p --waive-coverage "operator said skip"',
    'keryx review complete p --waive-""coverage "x y z"',
    "keryx review complete p $'--waive\\x2dcoverage' x",
    'keryx review chunks estimate --package p --answer yes --quote "operator said go"',
    'keryx review chunks estimate --package p --ans""wer yes --quote x',
  ]) {
    expect(unattendedShellRefusal(command)).toContain("operator's own statement");
  }
});

test("R2-40: the routine chunk verbs stay open to an unattended run", () => {
  expect(unattendedShellRefusal("keryx review chunks next --package p")).toBeUndefined();
  expect(unattendedShellRefusal("keryx review coverage --package p")).toBeUndefined();
});
