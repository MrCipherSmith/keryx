import { describe, expect, test } from "bun:test";
import type { FlowCard } from "../platform/commands";
import { flowRef, terminalCommands, workPrompt } from "./model";

function card(over: Partial<FlowCard> = {}): FlowCard {
  return {
    id: "487",
    idValid: true,
    dir: "487-2026-11-10-shell-product-review-p1",
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
  test("a keryx package directory with a command-safe id is the reference", () => {
    expect(flowRef(card())).toBe("487-2026-11-10-shell-product-review-p1");
  });

  test("the backend's idValid verdict is honoured", () => {
    expect(flowRef(card({ id: "abc", idValid: false }))).toBeNull();
  });

  test("only package directory names: three digits, a dash, the slug charset", () => {
    for (const dir of ["487;rm -rf ~", "-487-x", "1-x", "12-x", "abc", "487", "487-a/b", "487-a b", "487-$(id)", "../487-x", ""]) {
      expect(flowRef(card({ dir }))).toBeNull();
    }
    // Same rule as the Rust core's is_flow_dir_name: keryx slugs are [a-z0-9-] only.
    expect(flowRef(card({ dir: "042-x_y.z" }))).toBeNull();
    expect(flowRef(card({ dir: "042-2026-01-01-x-y" }))).toBe("042-2026-01-01-x-y");
  });

  test("no bare-id fallback when the directory is unsafe", () => {
    expect(flowRef(card({ dir: "weird;dir", id: "487", idValid: true }))).toBeNull();
  });
});

describe("terminalCommands", () => {
  test("nothing is offered without a safe reference", () => {
    expect(terminalCommands(card({ dir: "x;y" }))).toEqual([]);
    expect(terminalCommands(card({ idValid: false }))).toEqual([]);
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
    expect(workPrompt(card({ dir: "x;y" }))).toBe('Continue flow #487 "Shell review": take the next task.');
  });
});
