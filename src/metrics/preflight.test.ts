import { describe, expect, test } from "bun:test";
import type { CapabilityInclusion, GraphInventory, WikiInventory } from "./inventory";
import { summarizeWikiInventory } from "./inventory";
import type { AnswerReachabilityReport } from "./leakage";
import { PREFLIGHT_CODES, runPreflight, type PreflightCode, type PreflightEvidence } from "./preflight";
import type { IsolationReport } from "./provenance";

const PARENT = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const ARMS = ["with-keryx", "without-keryx"] as const;
const TASKS = ["t1", "t2", "t3"] as const;

const readyGraph = (): GraphInventory => ({
  status: "ready",
  dir: "/run/data/gdgraph",
  nodeCount: 120,
  edgeCount: 340,
  schemaVersion: 1,
  buildCommit: PARENT,
  builtAt: "2026-09-07T00:00:00.000Z",
  controlQuery: { probe: "src/alpha.ts", found: true, shapeOk: true, problem: null },
  problems: [],
});

const readyWiki = (): WikiInventory =>
  summarizeWikiInventory([
    { id: "w1", pageClass: "substantive", accepted: true, sections: ["a", "b"], retrievableSections: ["a", "b"] },
    { id: "w2", pageClass: "reference", accepted: true, sections: ["c"], retrievableSections: ["c"] },
  ]);

const readyIsolation = (): IsolationReport => ({
  status: "verified",
  remotes: [],
  parentSnapshotCommit: PARENT,
  headCommit: PARENT,
  checkoutMatchesParent: true,
  answerCommitReachable: false,
  problems: [],
});

const readyReachability = (): AnswerReachabilityReport => ({
  status: "clean",
  reachable: [],
  scannedFiles: 42,
  problems: [],
});

const readyCapabilities = (): CapabilityInclusion => ({ sac: "included", orient: "included" });

/**
 * The one fixture that is allowed through. Every blocking fixture below is this
 * object with exactly one thing wrong with it, so a block can only come from the
 * condition under test.
 */
function readyEvidence(): PreflightEvidence {
  const budget = { maxUsd: 5, maxTokens: 200_000 };
  const toolRoster = ["read_file", "search_code", "graph_affected"];
  return {
    protocol: {
      runId: "run-1",
      protocolDigest: "digest-1",
      parentSnapshotCommit: PARENT,
      taskIds: [...TASKS],
      arms: [...ARMS],
      requestedModel: "model-x",
      toolRoster,
      budget,
    },
    manifest: {
      protocolDigest: "digest-1",
      taskIds: [...TASKS],
      arms: [...ARMS],
      model: "model-x",
    },
    armPlans: ARMS.map((arm) => ({ arm, resolvedModel: "model-x", toolRoster, budget })),
    graph: readyGraph(),
    wiki: readyWiki(),
    capabilities: readyCapabilities(),
    isolation: readyIsolation(),
    answerReachability: readyReachability(),
    operatorMemory: { status: "absent", paths: [] },
  };
}

type BlockingFixture = {
  readonly code: PreflightCode;
  readonly name: string;
  readonly build: () => PreflightEvidence;
};

/**
 * One row per refusal. `PREFLIGHT_CODES` is cross-checked against this table
 * below, so a check added without a fixture that catches it fails the suite —
 * the point being that a guard nobody has ever seen fire is not a guard.
 */
const BLOCKING: readonly BlockingFixture[] = [
  {
    code: "graph-empty",
    name: "an unbuilt graph directory",
    build: () => ({
      ...readyEvidence(),
      graph: { ...readyGraph(), status: "empty", nodeCount: null, edgeCount: null, problems: ["no node store"] },
    }),
  },
  {
    code: "graph-corrupt",
    name: "a graph whose node store will not parse",
    build: () => ({
      ...readyEvidence(),
      graph: { ...readyGraph(), status: "corrupt", problems: ["nodes.jsonl line 2 is not valid JSON"] },
    }),
  },
  {
    code: "graph-corrupt",
    name: "a graph the filesystem refused",
    build: () => ({
      ...readyEvidence(),
      graph: { ...readyGraph(), status: "unreadable", problems: ["graph directory is unreadable"] },
    }),
  },
  {
    code: "graph-control-query-failed",
    name: "a populated graph that cannot answer a query with a known answer",
    build: () => ({
      ...readyEvidence(),
      graph: {
        ...readyGraph(),
        controlQuery: { probe: "src/alpha.ts", found: false, shapeOk: false, problem: "no node" },
      },
    }),
  },
  {
    code: "graph-control-query-failed",
    name: "a control query whose answer has the wrong shape",
    build: () => ({
      ...readyEvidence(),
      graph: {
        ...readyGraph(),
        controlQuery: { probe: "src/alpha.ts", found: true, shapeOk: false, problem: "missing kind" },
      },
    }),
  },
  {
    code: "graph-control-query-failed",
    name: "a graph that ran no control query at all",
    build: () => ({ ...readyEvidence(), graph: { ...readyGraph(), controlQuery: null } }),
  },
  {
    code: "graph-stale",
    name: "a graph built against a different revision than the parent snapshot",
    build: () => ({ ...readyEvidence(), graph: { ...readyGraph(), buildCommit: "deadbeef" } }),
  },
  {
    code: "graph-stale",
    name: "a graph that cannot be dated",
    build: () => ({ ...readyEvidence(), graph: { ...readyGraph(), builtAt: null } }),
  },
  {
    code: "wiki-coverage-unmeasurable",
    name: "a wiki with no retrievable sections to measure",
    build: () => ({ ...readyEvidence(), wiki: summarizeWikiInventory([]) }),
  },
  {
    code: "capability-inclusion-unrecorded",
    name: "SAC inclusion nobody wrote down",
    build: () => ({ ...readyEvidence(), capabilities: { sac: "unrecorded", orient: "included" } }),
  },
  {
    code: "manifest-digest-mismatch",
    name: "a manifest built for a different protocol",
    build: () => {
      const evidence = readyEvidence();
      return { ...evidence, manifest: { ...evidence.manifest, protocolDigest: "digest-2" } };
    },
  },
  {
    code: "manifest-task-mismatch",
    name: "a manifest carrying a task the protocol does not have",
    build: () => {
      const evidence = readyEvidence();
      return { ...evidence, manifest: { ...evidence.manifest, taskIds: ["t1", "t2", "t9"] } };
    },
  },
  {
    code: "manifest-task-mismatch",
    name: "a manifest missing a task the protocol requires",
    build: () => {
      const evidence = readyEvidence();
      return { ...evidence, manifest: { ...evidence.manifest, taskIds: ["t1", "t2"] } };
    },
  },
  {
    code: "manifest-arm-mismatch",
    name: "a manifest naming an arm outside the protocol roster",
    build: () => {
      const evidence = readyEvidence();
      return { ...evidence, manifest: { ...evidence.manifest, arms: ["with-keryx", "context-off"] } };
    },
  },
  {
    code: "manifest-arm-mismatch",
    name: "an arm plan for an arm the protocol does not define",
    build: () => {
      const evidence = readyEvidence();
      const rogue = evidence.armPlans[0]!;
      return { ...evidence, armPlans: [...evidence.armPlans, { ...rogue, arm: "context-off" }] };
    },
  },
  {
    code: "manifest-arm-mismatch",
    name: "a protocol arm with no plan at all",
    build: () => {
      const evidence = readyEvidence();
      return { ...evidence, armPlans: [evidence.armPlans[0]!] };
    },
  },
  {
    code: "model-mismatch",
    name: "an arm served by a different model than the one requested",
    build: () => {
      const evidence = readyEvidence();
      return {
        ...evidence,
        armPlans: [evidence.armPlans[0]!, { ...evidence.armPlans[1]!, resolvedModel: "model-x-fallback" }],
      };
    },
  },
  {
    code: "model-mismatch",
    name: "a manifest recording a different model than the protocol",
    build: () => {
      const evidence = readyEvidence();
      return { ...evidence, manifest: { ...evidence.manifest, model: "model-y" } };
    },
  },
  {
    code: "arm-config-mismatch",
    name: "one arm handed a larger tool roster than the other",
    build: () => {
      const evidence = readyEvidence();
      return {
        ...evidence,
        armPlans: [
          evidence.armPlans[0]!,
          { ...evidence.armPlans[1]!, toolRoster: ["read_file", "search_code"] },
        ],
      };
    },
  },
  {
    code: "arm-config-mismatch",
    name: "one arm handed a larger budget than the other",
    build: () => {
      const evidence = readyEvidence();
      return {
        ...evidence,
        armPlans: [
          evidence.armPlans[0]!,
          { ...evidence.armPlans[1]!, budget: { maxUsd: 50, maxTokens: 200_000 } },
        ],
      };
    },
  },
  {
    code: "answer-reachable",
    name: "the answer already present in what the agent can see",
    build: () => ({
      ...readyEvidence(),
      answerReachability: {
        status: "reachable",
        reachable: [{ kind: "content", where: "src/notes.ts", needle: "resolveGammaOffset" }],
        scannedFiles: 42,
        problems: [],
      },
    }),
  },
  {
    code: "answer-reachability-unverified",
    name: "a reachability scan that never looked at anything",
    build: () => ({
      ...readyEvidence(),
      answerReachability: { status: "unverified", reachable: [], scannedFiles: 0, problems: ["scan matched no files"] },
    }),
  },
  {
    code: "isolation-violated",
    name: "a checkout that can still reach the answer commit",
    build: () => ({
      ...readyEvidence(),
      isolation: { ...readyIsolation(), status: "violated", answerCommitReachable: true, problems: ["answer commit reachable"] },
    }),
  },
  {
    code: "isolation-unverified",
    name: "an isolation check that could not run",
    build: () => ({
      ...readyEvidence(),
      isolation: {
        ...readyIsolation(),
        status: "unverified",
        headCommit: null,
        checkoutMatchesParent: null,
        answerCommitReachable: null,
        problems: ["not a git checkout"],
      },
    }),
  },
  {
    code: "operator-memory-present",
    name: "an operator's notes left in the worktree",
    build: () => ({
      ...readyEvidence(),
      operatorMemory: { status: "present", paths: [".metaproject/memory/hint.md"] },
    }),
  },
  {
    code: "operator-memory-unverified",
    name: "an operator-memory check with nothing to look for",
    build: () => ({ ...readyEvidence(), operatorMemory: { status: "unverified", paths: [] } }),
  },
];

describe("runPreflight", () => {
  test("the fully prepared fixture is the only thing that gets through", () => {
    const result = runPreflight(readyEvidence());
    expect(result.status).toBe("ready");
    expect(result.blocks).toEqual([]);
  });

  test("every registered check actually ran", () => {
    const result = runPreflight(readyEvidence());
    expect([...result.checks].sort()).toEqual([...PREFLIGHT_CODES].sort());
  });

  for (const fixture of BLOCKING) {
    test(`blocks ${fixture.name} with ${fixture.code}`, () => {
      const result = runPreflight(fixture.build());
      expect(result.status).toBe("blocked");
      expect(result.blocks.map((block) => block.code)).toContain(fixture.code);
      // Exactly one thing is wrong with each fixture, so exactly one refusal.
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]!.detail.length).toBeGreaterThan(0);
    });
  }

  // A guard nobody has ever watched fire is not a guard.
  test("every blocking condition the gate can emit has a fixture that provokes it", () => {
    const covered = new Set(BLOCKING.map((fixture) => fixture.code));
    const uncovered = PREFLIGHT_CODES.filter((code) => !covered.has(code));
    expect(uncovered).toEqual([]);
  });

  test("a blocked preflight is INCOMPLETE, never a zero result", () => {
    const result = runPreflight(BLOCKING[0]!.build());
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("unreachable");
    expect(result.incomplete).toBe("preflight-blocked");
  });

  test("independent faults are all reported, not just the first", () => {
    const evidence = readyEvidence();
    const result = runPreflight({
      ...evidence,
      graph: { ...readyGraph(), status: "empty", problems: ["no node store"] },
      operatorMemory: { status: "present", paths: [".metaproject/memory/hint.md"] },
      answerReachability: {
        status: "reachable",
        reachable: [{ kind: "path", where: "gold.json", needle: null }],
        scannedFiles: 3,
        problems: [],
      },
    });
    expect(result.blocks.map((block) => block.code).sort()).toEqual(
      ["answer-reachable", "graph-empty", "operator-memory-present"],
    );
  });
});
