import { expect, test } from "bun:test";
import { OPERATOR_COMMANDS } from "../commands/review-operator";
import { HOST_QUESTION_VERBS } from "../review/host-question-verbs";
import { isUnattendedExcludedTool, unattendedRefusal, unattendedShellRefusal } from "./unattended";

test("flow completion exceptions are never offered or confirmed unattended", () => {
  expect(isUnattendedExcludedTool("flow_complete_exceptions")).toBe(true);
  expect(unattendedRefusal("flow_complete_exceptions", {})).toContain("not offered");
  expect(unattendedShellRefusal('keryx flow complete 469 --accept-gate review:head-commit --reason known'))
    .toContain("only an operator");
  expect(unattendedShellRefusal('keryx flow base set 469 --base main --reason retargeted'))
    .toContain("only an operator");
  expect(unattendedShellRefusal("keryx flow check-complete 469 --json")).toBeUndefined();
});

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

test("flow 467: the floor refuses a keryx review invocation that carries --answered-by, in every spelling it can see", () => {
  for (const command of [
    "keryx review waive-mutation --package P --answered-by claude-code:q",
    "keryx review waive-mutation --package P --answered\\\n-by claude-code:q",
    "keryx review $'waive-mutation' --package P --answered-by claude-code:q",
    "keryx review waive-mutation --package P --answered-by=claude-code:q",
    'keryx review decide-premise --package P --answered"-by" x',
    "bunx keryx --json review confirm-plan --package P --answered-by x",
    "bun src/cli.ts review override-reviewers --answered-by=x",
    "sh -c 'keryx review waive-mutation --package P --answered-by x'",
    "echo ok && /usr/local/bin/keryx review waive-mutation --answered-by x",
    "printf 'keryx review waive-mutation --answered-by x' | sh",
    // U05: eval is a shell wrapper; U04: wrappers nest.
    "eval 'keryx review waive-mutation --package P --answered-by x'",
    `sh -c "sh -c 'keryx review waive-mutation --package P --answered-by x'"`,
  ]) {
    expect(unattendedShellRefusal(command), command).toContain("--answered-by");
  }
});

test("flow 467: a mention of a verb and the flag that is not one keryx invocation is not the floor's business", () => {
  for (const command of [
    "echo 'review waive-mutation' | grep -e --answered-by",
    "rg --answered-by src && keryx review waive-mutation --package P",
    "keryx review waive-mutation --package P; echo --answered-by",
    "grep -n answered-by src/commands/review-operator.ts",
    "echo keryx review waive-mutation --answered-by x",
    // U03: quoted text that only reaches a printing command is a mention unless it is piped into a shell.
    "echo 'keryx review waive-mutation --answered-by x'",
    "printf 'keryx review waive-mutation --answered-by x'",
    "echo 'keryx review waive-mutation --answered-by x' | tee out.txt",
    // U09: cat only prints.
    "cat keryx review waive-mutation --answered-by x",
    "keryx review estimate --package p --answered-by x",
    "keryx review confirm-plan --package p",
  ]) {
    expect(unattendedShellRefusal(command), command).toBeUndefined();
  }
  // Not detectable: a flag held in a variable (`keryx review waive-mutation $FLAG`); the run's environment refuses it.
});

test("flow 467: the floor's verb list is the operator commands that record a decision", () => {
  expect([...HOST_QUESTION_VERBS, "verify-run"].sort()).toEqual([...OPERATOR_COMMANDS].sort());
});
