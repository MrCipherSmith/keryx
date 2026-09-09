// AFC (flow 240) — `graph_find` at the agent/MCP boundary, and the one property
// that boundary exists to preserve: the retrieval CODE.
//
// MEASURED BEFORE THIS LANE. `METAPROJECT_OPERATIONS` held sixteen operations
// and none of them was `graph_find`; the MCP registry projected the same sixteen
// plus the bespoke `gdgraph.affected`/`cycles`/`orphans`. So `findCandidates`
// (`src/gdgraph/find.ts`) — which distinguishes a genuine `no-match` from an
// `index-incomplete` from an `insufficient-evidence` ranking, each with a reason
// and at most three next actions — was reachable ONLY from `keryx gdgraph find`.
// An agent asking "which files are this about" had `search_code`, which cannot
// tell those four situations apart.
//
// Everything below drives the REAL descriptor from `METAPROJECT_OPERATIONS`
// through the REAL adapter. Nothing calls `formatFind` on a hand-built literal
// and calls that a boundary test.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "./metaproject-operations";
import { buildGraph } from "../../gdgraph/build";
import type { FindOutcome } from "../../gdgraph/find";
import { RETRIEVAL_CODES, type RetrievalCode } from "../../lib/retrieval-codes";
import type { InteractiveToolResult } from "./builtin/interactive-tools";

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");

/**
 * A tiny project this test owns, with a real graph built over it — used ONLY
 * by the REAL SEAM test below, which must load an actual built graph rather
 * than an injected `graphFind`. This repository's own
 * `.metaproject/data/gdgraph/storage` is `.gitignore`d
 * (`.metaproject/data/**\/storage/`) and exists only on a machine where
 * `keryx gdgraph build` happened to run — a CI checkout has none, so a test
 * that reads `REPO_ROOT`'s live graph measures ambient developer-machine
 * state, not this test's own property. `gdgraph.find` matches file PATHS, so
 * the fixture path carries the query terms; none of the fixture paths carries
 * "kubernetes"/"helm"/"chart"/"ingress" — the no-match probe relies on that
 * absence, not on anything about the real repository's contents.
 */
async function graphFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-graph-find-projection-"));
  const files: Record<string, string> = {
    "src/wiki/evidence-envelope.ts": "export const envelope = 'wiki evidence envelope';\n",
    "src/wiki/evidence-index.ts": "export const index = 'wiki evidence';\n",
    "src/other/unrelated-module.ts": "export const noop = true;\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await buildGraph(root);
  return root;
}

function operation(name: string) {
  const found = METAPROJECT_OPERATIONS.find((op) => op.name === name);
  if (found === undefined) {
    throw new Error(`operation "${name}" is not registered`);
  }
  return found;
}

/** Deterministic: never shells out to git, so `staleness` spawns nothing. */
const FROZEN_STALENESS = {
  checkGraphStaleness: async () => ({ status: "fresh" as const, reasons: [] }),
};

function outcome(code: RetrievalCode, overrides: Partial<FindOutcome> = {}): FindOutcome {
  return {
    code,
    reason: "a reason the transport must not rewrite",
    nextActions: ["do exactly one bounded thing"],
    files: [],
    symbols: [],
    queryTerms: ["alpha"],
    ubiquitousTerms: [],
    ...overrides,
  };
}

async function invokeFind(
  find: (cwd: string, query: string) => Promise<FindOutcome>,
  input: Record<string, unknown> = { query: "alpha" },
): Promise<InteractiveToolResult> {
  const port = createMetaprojectAdapter(REPO_ROOT, {
    ...FROZEN_STALENESS,
    graphFind: (cwd, query) => find(cwd, query),
  });
  return operation("graph_find").invoke(port, input);
}

test("graph_find is registered on the agent boundary, and therefore on the MCP projection", () => {
  const names = METAPROJECT_OPERATIONS.map((op) => op.name);
  expect(names).toContain("graph_find");
  const op = operation("graph_find");
  expect(op.risk).toBe("read");
  expect(op.module).toBe("gdgraph");
  // The descriptor is the single source `toMcpTools` and `toToolDefinitions`
  // both project, so registering it here IS the MCP registration.
  expect(op.inputSchema).toMatchObject({ required: ["query"] });
});

test("every code in the shared vocabulary survives the transport hop verbatim", async () => {
  // Not a spot-check of one code: the whole closed vocabulary, so a transport
  // that flattens any member fails here rather than in the one case nobody
  // happened to test.
  for (const code of RETRIEVAL_CODES) {
    const result = await invokeFind(async () => outcome(code));
    expect(result.output).toContain(`code: ${code}`);
    expect(result.output).toContain("a reason the transport must not rewrite");
    expect(result.output).toContain("do exactly one bounded thing");
  }
});

test("a completed search with no results is NOT an error; an index that could not answer IS", async () => {
  // The distinction `retrievalStatus` encodes, at the boundary. Before this,
  // an agent had no field to branch on at all.
  const noMatch = await invokeFind(async () => outcome("no-match"));
  expect(noMatch.isError).toBe(false);
  const insufficient = await invokeFind(async () => outcome("insufficient-evidence"));
  expect(insufficient.isError).toBe(false);
  const incomplete = await invokeFind(async () => outcome("index-incomplete"));
  expect(incomplete.isError).toBe(true);
  const notIndexed = await invokeFind(async () => outcome("target-not-indexed"));
  expect(notIndexed.isError).toBe(true);
});

test("PLANTED VIOLATION — a private spelling outside the vocabulary is collapsed, not forwarded", async () => {
  // `unknown-graph-target` is the real historical spelling `gdgraph affected`
  // used to put in its JSON (see `src/lib/retrieval-codes.ts`'s own header): a
  // code that appears nowhere in the norm and that no caller can branch on.
  // This plants exactly that through the real seam and asserts the normaliser
  // catches it. Without `normalizeRetrievalCode` in the path this test fails,
  // which is what makes the assertion load-bearing rather than decorative.
  const result = await invokeFind(async () =>
    outcome("unknown-graph-target" as unknown as RetrievalCode),
  );
  expect(result.output).not.toContain("unknown-graph-target");
  expect(result.output).toContain("code: capability-unavailable");
});

test("the explainability the CLI prints reaches the model: matched, discriminating, and the corpus-wide terms", async () => {
  const result = await invokeFind(async () =>
    outcome("insufficient-evidence", {
      ubiquitousTerms: ["service"],
      files: [
        {
          path: "src/example/thing.ts",
          score: 12.5,
          matched: ["service", "thing"],
          discriminating: [],
          dependents: 41,
          reason: "matched service, thing; no narrowing term — every hit is corpus-wide",
        },
      ],
      symbols: [
        {
          id: "src/example/thing.ts#Thing.run",
          name: "run",
          kind: "method",
          path: "src/example/thing.ts",
          startLine: 88,
          score: 3,
          matched: ["service"],
          discriminating: [],
          reason: "matched service; no narrowing term — every hit is corpus-wide",
        },
      ],
    }),
  );
  expect(result.output).toContain("code: insufficient-evidence");
  expect(result.output).toContain("corpus-wide terms (these narrow nothing): service");
  expect(result.output).toContain("src/example/thing.ts");
  expect(result.output).toContain("no narrowing term");
  expect(result.output).toContain("run (method) at src/example/thing.ts:88");
  // A ranking score, labelled as one — never a percentage or a probability.
  expect(result.output).toContain("ranking score 12.50");
  expect(result.output).not.toContain("%");
});

test("a graph that cannot be loaded is index-incomplete, never a no-match", async () => {
  // "the index could not answer" and "the corpus contains nothing" are the two
  // answers this whole operation exists to keep apart. A thrown backing must
  // land on the first.
  const result = await invokeFind(async () => {
    throw new Error("nodes.jsonl is unreadable");
  });
  expect(result.output).toContain("code: index-incomplete");
  expect(result.output).toContain("nodes.jsonl is unreadable");
  expect(result.output).not.toContain("code: no-match");
  expect(result.isError).toBe(true);
});

test("an empty query is refused by the descriptor before the port is touched", async () => {
  let called = false;
  const result = await invokeFind(
    async () => {
      called = true;
      return outcome("ok");
    },
    { query: "" },
  );
  expect(called).toBe(false);
  expect(result.isError).toBe(true);
});

test("REAL SEAM — the adapter answers through a real built graph and the real classifier, no injected fake", async () => {
  // No injected `graphFind`: this loads an actual built graph (over a fixture
  // project this test owns and tears down — see `graphFixture` above) and
  // runs the actual classifier, so the boundary is proven end to end and not
  // only against fakes. It does NOT read `REPO_ROOT`'s own graph: that
  // storage is `.gitignore`d and absent on a clean CI checkout, so measuring
  // it here would be measuring ambient developer-machine state rather than a
  // property this test owns.
  const root = await graphFixture();
  try {
    const port = createMetaprojectAdapter(root, FROZEN_STALENESS);
    const found = await operation("graph_find").invoke(port, {
      query: "wiki evidence envelope",
      fileLimit: 3,
    });
    expect(found.output).toContain("code: ok");
    expect(found.output).toContain("src/wiki/evidence-envelope.ts");
    expect(found.isError).toBe(false);

    const nothing = await operation("graph_find").invoke(port, {
      query: "kubernetes helm chart ingress",
    });
    expect(nothing.output).toContain("code: no-match");
    // A completed search that found nothing is an ANSWER, at exit-code parity
    // with the CLI's own `retrievalStatus` mapping.
    expect(nothing.isError).toBe(false);
    expect(nothing.output).toContain("keryx ctx rg");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
