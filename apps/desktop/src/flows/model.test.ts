import { describe, expect, test } from "bun:test";
import type { FlowCard } from "../platform/commands";
import { flowRef, terminalCommands, workPrompt } from "./model";

function card(over: Partial<FlowCard> = {}): FlowCard {
  return {
    id: "487",
    idValid: true,
    dir: "487-2026-11-10-shell-product-review-p1",
    commandRef: "487-2026-11-10-shell-product-review-p1",
    title: "Shell review",
    status: "in-progress",
    previousStatus: null,
    blocked: false,
    owner: null,
    prUrl: null,
    baseBranch: null,
    tasksDone: 0,
    tasksTotal: 0,
    acTotal: 0,
    acConfirmed: 0,
    updatedAt: null,
    completionExceptions: false,
    error: null,
    ...over,
  };
}

describe("flowRef", () => {
  test("the core's commandRef is the reference", () => {
    expect(flowRef(card())).toBe("487-2026-11-10-shell-product-review-p1");
    for (const dir of ["012-Write-Docs", "012-a.b", "012-a_b", "012-a+b"]) {
      expect(flowRef(card({ dir, commandRef: dir }))).toBe(dir);
    }
  });

  test("no reference when the core withheld it (names unsafe for a shell)", () => {
    for (const dir of ["012-a b", "012-a$b", "012-a;b", "012-a'b", '012-a"b']) {
      expect(flowRef(card({ dir, commandRef: null }))).toBeNull();
    }
  });

  test("the client does not second-guess the core: the dir and the id play no part", () => {
    expect(flowRef(card({ id: "abc", idValid: false }))).toBe("487-2026-11-10-shell-product-review-p1");
    expect(flowRef(card({ dir: "weird;dir", commandRef: null }))).toBeNull();
  });
});

describe("terminalCommands", () => {
  test("nothing is offered without a safe reference", () => {
    expect(terminalCommands(card({ dir: "012-x;y", commandRef: null }))).toEqual([]);
  });

  test("every command names the package directory as its flow argument", () => {
    const ref = "487-2026-11-10-shell-product-review-p1";
    for (const c of terminalCommands(card())) expect(c.command.split(" ")).toContain(ref);
  });

  /** The flags src/commands/flow.ts refuses to run without. */
  const REQUIRED: Array<[RegExp, RegExp]> = [
    [/^keryx flow implemented /, / --pr <[^>"]+>/],
    [/^keryx flow recover /, / --reason <[^>"]+>/],
    [/^keryx flow ac update /, / --reason <[^>"]+>/],
    [/^keryx flow ac reseal /, / --reason <[^>"]+>/],
    [/^keryx flow ac confirm /, / <ACn> --note <[^>"]+>/],
  ];

  test("required flags are present, as unquoted placeholders the shell refuses", () => {
    const cmds = terminalCommands(card()).map((c) => c.command);
    for (const [which, flag] of REQUIRED) {
      const cmd = cmds.find((c) => which.test(c));
      expect(cmd).not.toBeUndefined();
      expect(cmd).toMatch(flag);
    }
  });

  test("a criterion is never confirmed by a fixed AC number", () => {
    const cmds = terminalCommands(card()).map((c) => c.command);
    expect(cmds.some((c) => / AC\d/.test(c))).toBeFalse();
  });

  test("the spec's `keryx flow confirm` is offered", () => {
    expect(terminalCommands(card()).map((c) => c.command)).toContain("keryx flow confirm 487-2026-11-10-shell-product-review-p1");
  });
});

describe("workPrompt", () => {
  test("names the package, not only the shared id", () => {
    expect(workPrompt(card())).toBe('Continue flow #487 "Shell review" (package 487-2026-11-10-shell-product-review-p1): take the next task.');
  });

  test("without a safe reference it names no package", () => {
    expect(workPrompt(card({ dir: "012-x;y", commandRef: null }))).toBe('Continue flow #487 "Shell review": take the next task.');
  });
});
