// Does the approval prompt actually approve, and actually deny?
//
// Nothing asked that until now. A reviewer measured it: with
// `if (!approved)` inverted in `shell.ts` — so typing `y` DENIES and
// typing anything else APPROVES and runs a third party's tool — the full
// suite of 9 158 tests passed. So did `return id === "allow"` inverted in
// the TUI, so did replacing the description with a constant, and so did
// commenting the whole branch out and restoring F-032.
//
// What stood in for this was `approval-wiring.test.ts` comparing the
// character offsets of two string literals in the file's SOURCE TEXT.
// That is the fourth time this repository has caught itself asserting
// that a sentence appears rather than that a property holds, and it was
// guarding the security fix the phase exists for.
//
// The earlier extraction moved the LINE BUILDING behind a harness and
// left the decision where it was. This file exists because the decision
// is the part that matters: everything above it is presentation, and
// everything below it runs somebody else's code.

import { describe, expect, test } from "bun:test";
import {
  APPROVAL_ALLOW_ID,
  isApprovalYes,
  isDockApproval,
  promptUseToolApproval,
  type ApprovalIo,
} from "./approval-render";

function fakeIo(answer: string | undefined): ApprovalIo & { written: () => string } {
  const chunks: string[] = [];
  return {
    out: (text) => chunks.push(text),
    readLine: async () => answer,
    written: () => chunks.join(""),
  };
}

const CALL = JSON.stringify({
  tool_name: "linear__create_issue",
  tool_input: { title: "ship it" },
});

describe("the readline prompt returns what the operator actually said", () => {
  test.each([["y"], ["Y"], ["yes"], ["YES"], ["  y  "]])("%s approves", async (answer) => {
    expect(await promptUseToolApproval(fakeIo(answer), CALL, undefined)).toBe(true);
  });

  test.each([["n"], ["N"], ["no"], [""], ["  "], ["yolo"], ["always"], ["a"], ["Y E S"]])(
    "%s denies",
    async (answer) => {
      expect(await promptUseToolApproval(fakeIo(answer), CALL, undefined)).toBe(false);
    },
  );

  test("'always' is a DENIAL here, not a grant", async () => {
    // The shell branch offers `A=always` for a non-destructive command.
    // An MCP call must not, because the pattern would be a name the
    // model chose. Typing it anyway must be refused, not honoured.
    expect(await promptUseToolApproval(fakeIo("always"), CALL, undefined)).toBe(false);
    expect(await promptUseToolApproval(fakeIo("A"), CALL, undefined)).toBe(false);
  });

  test("end of input — the operator pressed Ctrl-D — denies", async () => {
    // Fail closed. `readLine()` resolving undefined must never approve.
    expect(await promptUseToolApproval(fakeIo(undefined), CALL, undefined)).toBe(false);
  });

  test("an approval carries the fingerprint back when there is one", async () => {
    const verdict = await promptUseToolApproval(fakeIo("y"), CALL, { fingerprint: "fp-1" });
    expect(verdict).toEqual({ approved: true, fingerprint: "fp-1" });
  });

  test("and a DENIAL never carries one", async () => {
    expect(await promptUseToolApproval(fakeIo("n"), CALL, { fingerprint: "fp-1" })).toBe(false);
  });
});

describe("what the operator was shown before answering", () => {
  test("the prompt names the tool, the server and the arguments", async () => {
    const io = fakeIo("n");
    await promptUseToolApproval(io, CALL, undefined);
    const shown = io.written();
    expect(shown).toContain("Approve MCP tool call?");
    expect(shown).toContain("linear");
    expect(shown).toContain("create_issue");
    expect(shown).toContain("ship it");
    expect(shown).toContain("[y/N]");
  });

  test("it never offers an always option", async () => {
    const io = fakeIo("n");
    await promptUseToolApproval(io, CALL, undefined);
    expect(io.written()).not.toContain("always");
    expect(io.written()).not.toContain("A=");
  });

  test("the verdict is echoed, so the operator sees what was recorded", async () => {
    const yes = fakeIo("y");
    await promptUseToolApproval(yes, CALL, undefined);
    expect(yes.written()).toContain("approved");

    const no = fakeIo("n");
    await promptUseToolApproval(no, CALL, undefined);
    expect(no.written()).toContain("denied");
  });

  test("the resolver it is given is the one that names the server", async () => {
    // Guards the wiring, not just the function: a call site that forgot
    // to pass the resolver would silently fall back to guessing.
    const io = fakeIo("n");
    await promptUseToolApproval(io, JSON.stringify({ tool_name: "github__notes__exfil" }), undefined, () => ({
      server: "github__notes",
      tool: "exfil",
    }));
    expect(io.written()).toContain("github__notes");
  });
});

describe("the TUI dock's answer", () => {
  test("only the allow id approves", () => {
    expect(isDockApproval(APPROVAL_ALLOW_ID)).toBe(true);
  });

  test.each([["deny"], [undefined], [""], ["Allow"], ["allow "]])("%s denies", (id) => {
    // `undefined` is the dismissed / re-entered case, and it must fail
    // closed. `"Allow"` and `"allow "` matter because an id is compared,
    // not parsed.
    expect(isDockApproval(id)).toBe(false);
  });
});

describe("isApprovalYes on its own", () => {
  test("accepts exactly the two spellings, trimmed", () => {
    for (const yes of ["y", "yes", " Y ", "YES"]) expect({ yes, ok: isApprovalYes(yes) }).toEqual({ yes, ok: true });
  });

  test("BOUNDARY — and nothing that merely starts with them", () => {
    for (const no of ["yep", "yest", "ya", "y!", "n", ""]) {
      expect({ no, ok: isApprovalYes(no) }).toEqual({ no, ok: false });
    }
  });
});
