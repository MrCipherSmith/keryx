import { expect, test } from "bun:test";
import { escalateForBlastRadius, metaprojectBlastRadius } from "./metaproject-escalation";
import type { PolicyDecision, PolicyOutcome } from "./types";
import type { MetaprojectPort } from "../tool/metaproject-port";

function decision(outcome: PolicyOutcome): PolicyDecision {
  return {
    schemaVersion: 1,
    decisionId: "d1",
    toolCallId: "c1",
    decision: outcome,
    policyProfile: "test",
    timestamp: "fixed",
    matchedRules: [`profile:test`],
    reason: "base",
  };
}

function fakePort(overrides: Partial<MetaprojectPort> = {}): MetaprojectPort {
  return {
    searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
    graphAffected: async ({ target }) => ({ target, affected: [] }),
    graphQuery: async ({ query }) => (query === "orphans" ? { query, orphans: [] } : { query, cycles: [] }),
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path }) => ({ path, content: "", isError: false }),
    describeContext: async () => ({ root: "/x", graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
    ...overrides,
  };
}

test("allow escalates to ask when blast radius meets the threshold", () => {
  const result = escalateForBlastRadius(decision("allow"), { blastRadius: 50 }, 20);
  expect(result.decision).toBe("ask");
  expect(result.matchedRules).toContain("metaproject:blast-radius>=20");
  expect(result.reason).toMatch(/blast radius 50/);
});

test("allow stays allow when blast radius is below the threshold", () => {
  expect(escalateForBlastRadius(decision("allow"), { blastRadius: 5 }, 20).decision).toBe("allow");
});

test("no-op when threshold <= 0 or blastRadius is absent", () => {
  expect(escalateForBlastRadius(decision("allow"), { blastRadius: 999 }, 0).decision).toBe("allow");
  expect(escalateForBlastRadius(decision("allow"), {}, 20).decision).toBe("allow");
});

test("NEVER weakens: ask and deny are returned unchanged for any blast radius/threshold", () => {
  for (const outcome of ["ask", "deny"] as const) {
    for (const blastRadius of [0, 1, 1000]) {
      for (const threshold of [0, 1, 20]) {
        const input = decision(outcome);
        const result = escalateForBlastRadius(input, { blastRadius }, threshold);
        expect(result.decision).toBe(outcome); // never becomes allow, never changes
      }
    }
  }
});

test("allow only ever becomes allow or ask, never anything more permissive", () => {
  for (const blastRadius of [0, 5, 50, 1000]) {
    for (const threshold of [0, 20]) {
      const result = escalateForBlastRadius(decision("allow"), { blastRadius }, threshold);
      expect(["allow", "ask"]).toContain(result.decision);
    }
  }
});

test("metaprojectBlastRadius returns the affected count", async () => {
  const port = fakePort({
    graphAffected: async ({ target }) => ({
      target,
      affected: [
        { id: "a", path: "a.ts", hop: 1 },
        { id: "b", path: "b.ts", hop: 1 },
        { id: "c", path: "c.ts", hop: 2 },
      ],
    }),
  });
  expect(await metaprojectBlastRadius(port, "src/x.ts")).toBe(3);
});

test("metaprojectBlastRadius returns 0 on a structured error or a thrown error", async () => {
  const errPort = fakePort({ graphAffected: async ({ target }) => ({ target, affected: [], error: "no graph" }) });
  expect(await metaprojectBlastRadius(errPort, "x")).toBe(0);
  const throwPort = fakePort({
    graphAffected: async () => {
      throw new Error("boom");
    },
  });
  expect(await metaprojectBlastRadius(throwPort, "x")).toBe(0);
});
