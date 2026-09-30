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
  catalogFingerprintResolver,
  catalogResolver,
  isApprovalYes,
  isDockApproval,
  mcpDockVerdict,
  mcpTrustOffered,
  promptUseToolApproval,
  renderUseToolApprovalLines,
  describeUseToolApproval,
  untrustedOriginNotices,
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
  test("trust requires a catalog-resolved tool and a fingerprinted trust-mode request", async () => {
    const resolve = catalogResolver({ entries: [{ fqn: "linear__create_issue", server: "linear", rawName: "create_issue" }] });
    const io = fakeIo("t");
    expect(await promptUseToolApproval(io, CALL, { fingerprint: "fp-1", mcpTrustAvailable: true }, resolve)).toEqual({
      approved: true, fingerprint: "fp-1", trustMcpTool: true,
    });
    expect(io.written()).toContain("T=trust this tool for session");
    expect(await promptUseToolApproval(fakeIo("t"), CALL, { fingerprint: "fp-1", mcpTrustAvailable: true }, () => undefined)).toBe(false);
    expect(await promptUseToolApproval(fakeIo("t"), CALL, { fingerprint: "fp-1" }, resolve)).toBe(false);
    expect(await promptUseToolApproval(fakeIo("t"), CALL, { mcpTrustAvailable: true }, resolve)).toBe(false);
  });
});

describe("the untrusted-content floor withholds the trust option", () => {
  const resolve = catalogResolver({ entries: [{ fqn: "linear__create_issue", server: "linear", rawName: "create_issue" }] });
  const tainted = { fingerprint: "fp-1", mcpTrustAvailable: true, untrustedOrigin: true, mcpTrustWithheld: true } as const;

  test("the readline prompt omits T, says why, and a typed T is a denial", async () => {
    const io = fakeIo("t");
    expect(await promptUseToolApproval(io, CALL, tainted, resolve)).toBe(false);
    const shown = io.written();
    expect(shown).toContain("[y/N] ");
    expect(shown).not.toContain("T=trust");
    expect(shown).toContain("follows untrusted external content");
    expect(shown).toContain("trust for this session is not offered");
  });

  test("a plain yes still approves, with no grant attached", async () => {
    expect(await promptUseToolApproval(fakeIo("y"), CALL, tainted, resolve)).toEqual({ approved: true, fingerprint: "fp-1" });
  });

  test("the option is offered only when the floor is off, and the dock verdict follows", () => {
    expect(mcpTrustOffered({ fingerprint: "fp-1", mcpTrustAvailable: true }, true)).toBe(true);
    expect(mcpTrustOffered(tainted, true)).toBe(false);
    expect(mcpTrustOffered({ fingerprint: "fp-1", mcpTrustAvailable: true, untrustedOrigin: true }, true)).toBe(false);
    expect(mcpTrustOffered({ fingerprint: "fp-1", mcpTrustAvailable: true }, false)).toBe(false);
    expect(mcpDockVerdict("trust-mcp", mcpTrustOffered(tainted, true), "fp-1")).toBe(false);
  });

  test("both surfaces draw the reason from the same notice lines", () => {
    expect(untrustedOriginNotices({ untrustedOrigin: true })).toHaveLength(1);
    expect(untrustedOriginNotices({ untrustedOrigin: true, mcpTrustWithheld: true })).toHaveLength(2);
    expect(untrustedOriginNotices({ mcpTrustWithheld: true })).toEqual([]);
    const lines = renderUseToolApprovalLines(describeUseToolApproval(CALL, resolve), tainted);
    expect(lines.join("\n")).toContain(untrustedOriginNotices(tainted)[1]!);
  });
});

describe("catalogFingerprintResolver binds a grant to the tool definition", () => {
  const entry = { fqn: "s__t", description: "does a thing", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } };
  const fingerprint = (e: typeof entry | Record<string, unknown>) => catalogFingerprintResolver({ entries: [e as typeof entry] })("s__t");

  test("is stable across key order and unrelated fields", () => {
    const reordered = { inputSchema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }, description: "does a thing", fqn: "s__t", annotations: { readOnlyHint: true } };
    expect(fingerprint(reordered)).toBe(fingerprint(entry));
    expect(fingerprint(entry)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes with the description and with the input schema", () => {
    expect(fingerprint({ ...entry, description: "does another thing" })).not.toBe(fingerprint(entry));
    expect(fingerprint({ ...entry, inputSchema: { type: "object", properties: { a: { type: "string" } } } })).not.toBe(fingerprint(entry));
  });

  test("is undefined for a tool the catalog does not hold", () => {
    expect(catalogFingerprintResolver({ entries: [entry] })("s__other")).toBeUndefined();
    expect(catalogFingerprintResolver(undefined)("s__t")).toBeUndefined();
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

describe("catalogResolver — the wiring both surfaces share", () => {
  // The sweep found all four decisions in the inline copies unkillable.
  // Inverting `catalog === undefined ? undefined : resolveFqn(...)` in
  // either file makes the resolver always return undefined, so the
  // prompt silently falls back to GUESSING the server by string split —
  // F7's misattribution, back with no test failing. The reviewer named
  // this risk in the same breath as the fix.
  const catalog = {
    entries: [
      { fqn: "github__notes__exfil", server: "github__notes", rawName: "exfil" },
      { fqn: "linear__search", server: "linear", rawName: "search" },
    ],
  };

  test("resolves a known FQN to its real server and wire name", () => {
    expect(catalogResolver(catalog)("github__notes__exfil")).toEqual({
      server: "github__notes",
      tool: "exfil",
    });
  });

  test("and does NOT guess for a name the catalog does not have", () => {
    // Returning a guess here would be worse than returning nothing: the
    // caller's fallback is at least labelled as a guess.
    expect(catalogResolver(catalog)("unknown__thing")).toBeUndefined();
  });

  test("BOUNDARY — an absent catalog resolves nothing rather than throwing", () => {
    // `--chat` sessions never build a runtime, so this is the normal
    // case, not an error case.
    expect(catalogResolver(undefined)("linear__search")).toBeUndefined();
  });

  test("BOUNDARY — an empty catalog is not an absent one, and also resolves nothing", () => {
    expect(catalogResolver({ entries: [] })("linear__search")).toBeUndefined();
  });

  test("end to end: a resolved call names the server the catalog says", async () => {
    // The wiring, not just the function: this is the shape both call
    // sites now use.
    const io = fakeIo("n");
    await promptUseToolApproval(
      io,
      JSON.stringify({ tool_name: "github__notes__exfil", tool_input: {} }),
      undefined,
      catalogResolver(catalog),
    );
    expect(io.written()).toContain("github__notes");
    expect(io.written()).toContain("exfil");
  });
});


test("MCP dock grants only the exact trust choice when offered and fingerprinted", () => {
  expect(mcpDockVerdict("allow", false, undefined)).toBe(true);
  expect(mcpDockVerdict("trust-mcp", true, "fp")).toEqual({ approved: true, fingerprint: "fp", trustMcpTool: true });
  expect(mcpDockVerdict("trust-mcp", false, "fp")).toBe(false);
  expect(mcpDockVerdict("trust-mcp", true, undefined)).toBe(false);
  expect(mcpDockVerdict("deny", true, "fp")).toBe(false);
  expect(mcpDockVerdict("__cancel__", true, "fp")).toBe(false);
});
