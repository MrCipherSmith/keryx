import { describe, expect, test } from "bun:test";
import { approveMcpCall, type McpApprovalDeps } from "./approval";

type Asked = { name: string; fingerprint: string; destructive: boolean };

function deps(over: Partial<McpApprovalDeps> = {}, asked: Asked[] = []): McpApprovalDeps {
  return {
    mode: "ask",
    fingerprint: (name, input) => `fp:${name}:${JSON.stringify(input)}`,
    isApprovalFor: (response, fingerprint) => response === fingerprint,
    requestApproval: async (name, _input, meta) => {
      asked.push({ name, fingerprint: meta.fingerprint, destructive: meta.destructive });
      return meta.fingerprint;
    },
    ...over,
  };
}

describe("the headless arm fails CLOSED", () => {
  test("a destructive call with no approver is denied, not auto-approved", async () => {
    // The arm that turns a prompt into a bypass. A call that proceeds because
    // nobody was present to object has not been approved.
    const outcome = await approveMcpCall("srv__write", {}, "destructive", {
      ...deps(),
      requestApproval: undefined,
    });

    expect(outcome.allowed).toBe(false);
    expect(outcome.allowed === false && outcome.reason).toContain("no one to ask");
  });

  test("headless still allows a read tool, because nothing was being gated", async () => {
    // Fail-closed is about the gate, not about refusing everything: a `read`
    // tool never reaches the prompt in the first place.
    const outcome = await approveMcpCall("srv__list", {}, "read", {
      ...deps(),
      requestApproval: undefined,
    });
    expect(outcome.allowed).toBe(true);
  });
});

describe("ask mode", () => {
  test("a destructive call reaches the prompt", async () => {
    const asked: Asked[] = [];
    const outcome = await approveMcpCall("srv__write", { a: 1 }, "destructive", deps({}, asked));

    expect(outcome.allowed).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.name).toBe("srv__write");
    expect(asked[0]?.destructive).toBe(true);
  });

  test("a read call does not", async () => {
    const asked: Asked[] = [];
    const outcome = await approveMcpCall("srv__list", {}, "read", deps({}, asked));

    expect(outcome.allowed).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe("trust mode still asks for destructive", () => {
  test("trust does not auto-approve a destructive MCP call", async () => {
    // The specification is explicit: under trust, a classifier-marked
    // destructive call still asks.
    const asked: Asked[] = [];
    const outcome = await approveMcpCall("srv__delete", {}, "destructive", deps({ mode: "trust" }, asked));

    expect(asked).toHaveLength(1);
    expect(outcome.allowed).toBe(true);
  });

  test("trust auto-approves a read call without asking", async () => {
    const asked: Asked[] = [];
    await approveMcpCall("srv__list", {}, "read", deps({ mode: "trust" }, asked));
    expect(asked).toEqual([]);
  });
});

describe("the fingerprint is checked, not just the answer", () => {
  test("an approval for a DIFFERENT call does not authorize this one", async () => {
    // A yes is consent to the thing it was asked about. Accepting any
    // affirmative would let one approval carry an unrelated call.
    const outcome = await approveMcpCall("srv__write", { a: 1 }, "destructive", {
      ...deps(),
      requestApproval: async () => "fp:something:else",
    });

    expect(outcome.allowed).toBe(false);
    expect(outcome.allowed === false && outcome.reason).toContain("not approved");
  });

  test("a refusal is a refusal", async () => {
    const outcome = await approveMcpCall("srv__write", {}, "destructive", {
      ...deps(),
      requestApproval: async () => false,
    });
    expect(outcome.allowed).toBe(false);
  });

  test("the fingerprint covers the ARGUMENTS, not only the tool name", async () => {
    // Otherwise one approval of `write {path: "a"}` would carry
    // `write {path: "/etc/passwd"}`.
    const seen: string[] = [];
    const d = deps({
      requestApproval: async (_n, _i, meta) => {
        seen.push(meta.fingerprint);
        return meta.fingerprint;
      },
    });

    await approveMcpCall("srv__write", { path: "a" }, "destructive", d);
    await approveMcpCall("srv__write", { path: "b" }, "destructive", d);

    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("it routes into keryx's own gate rather than reimplementing one", () => {
  test("the decision comes from resolveApprovalDecision, mode included", async () => {
    // `auto` mode is a keryx-wide policy this module must obey without
    // knowing about it. If this file had its own policy, it would not.
    const asked: Asked[] = [];
    const outcome = await approveMcpCall("srv__write", {}, "destructive", deps({ mode: "auto" }, asked));

    expect(outcome.allowed).toBe(true);
    expect(asked).toEqual([]);
  });
});
