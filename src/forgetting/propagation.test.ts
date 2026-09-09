import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reportPropagation, type DeletionWindow, type KnowledgeLayer } from "./propagation";

/** The two identities the fixture's deletion removes. */
const REMOVED_REFS = [
  "keryx:page/architecture-billing-charges",
  "keryx:page/architecture-billing-charges#constraints",
];

/** A window that was genuinely computed. */
const windowOf = (...deleted: string[]): DeletionWindow => ({
  state: "determined",
  deleted,
  basis: "git, diffing the fixture's baseline,",
});

/** A window that could not be computed — the third state, T8. */
const NO_WINDOW: DeletionWindow = {
  state: "undetermined",
  cause: "the fixture supplied no baseline to diff against.",
};

/** A rebuilt graph judged against `window`. */
const rebuiltAgainst = (window: DeletionWindow) => ({ rebuiltInThisRun: true, window });

// The AC1 fixture: ONE piece of knowledge present in four layers at once — a
// wiki page (with a stable identity and a stable section), a memory entry that
// cites both, a graph node, and the identity registry that names it. The page
// and its source file are then removed with `rm`, which is how knowledge is
// deleted in this codebase today (there is no deletion command for it).

const PAGE = [
  '<!-- keryx:page id="architecture-billing-charges" v=1 -->',
  "# Billing Charges",
  "",
  "Version: 1.0.0",
  "Type: architecture",
  "Status: accepted",
  "",
  "## Summary",
  "",
  "How a placed order becomes a charge.",
  "",
  '<!-- keryx:section id="constraints" v=1 -->',
  "## Constraints",
  "",
  "A charge is issued once per order and never retried automatically.",
  "<!-- /keryx:section -->",
  "",
].join("\n");

const ENTRY = [
  "# Charge once per order",
  "",
  "Version: 1.0.0",
  "Type: decision",
  "Status: accepted",
  "Confidence: high",
  "",
  "## Summary",
  "",
  "We charge exactly once per order.",
  "",
  "## Details",
  "",
  "The rationale lives in [billing charges](../../wiki/architecture/billing-charges.md),",
  "section `keryx:page/architecture-billing-charges#constraints`.",
  "",
  "## Provenance",
  "",
  "- Created: 2026-09-01",
  "",
].join("\n");

const jsonl = (rows: object[]): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** The registry as it stands after the page was registered and then removed. */
function tombstonedRegistry(): string {
  const entry = (kind: string, ref: string, title: string) => ({
    kind,
    ref,
    page: "architecture/billing-charges.md",
    title,
    digest: "0".repeat(64),
    registeredAt: "2026-09-01T00:00:00.000Z",
    removedAt: "2026-09-05T10:00:00.000Z",
    reason: "billing moved to the payments service",
  });
  return `${JSON.stringify(
    {
      version: 2,
      entries: [],
      tombstones: [
        entry("page", "keryx:page/architecture-billing-charges", "Billing Charges"),
        entry("section", "keryx:page/architecture-billing-charges#constraints", "Constraints"),
      ],
      lifted: [],
    },
    null,
    2,
  )}\n`;
}

type Fixture = { cwd: string; registryPath: string };

async function fourLayerProject(options: { deleted: boolean }): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-forget-prop-"));
  const wiki = path.join(cwd, ".metaproject", "wiki", "architecture");
  const memory = path.join(cwd, ".metaproject", "memory", "decisions");
  const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(wiki, { recursive: true });
  await mkdir(memory, { recursive: true });
  await mkdir(storage, { recursive: true });
  await writeFile(path.join(memory, "charge-once.md"), ENTRY, "utf8");

  const registryPath = path.join(cwd, ".metaproject", "wiki", ".sections.json");

  if (options.deleted) {
    // Page gone, its identity tombstoned, `src/billing.ts` gone and the import
    // of it left as an unresolved edge — exactly what `keryx gdgraph build`
    // writes after the deletion.
    await writeFile(registryPath, tombstonedRegistry(), "utf8");
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      jsonl([{ id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" }]),
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      jsonl([
        {
          id: "edge:1",
          from: "src/orders.ts",
          to: "./billing",
          kind: "unresolved",
          specifier: "./billing",
          importKind: "import-statement",
        },
      ]),
      "utf8",
    );
  } else {
    await writeFile(path.join(wiki, "billing-charges.md"), PAGE, "utf8");
    await writeFile(
      registryPath,
      `${JSON.stringify({ version: 2, entries: [], tombstones: [], lifted: [] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      jsonl([
        { id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" },
        { id: "src/billing.ts", kind: "file", path: "src/billing.ts", language: "typescript" },
      ]),
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      jsonl([
        { id: "edge:1", from: "src/orders.ts", to: "src/billing.ts", kind: "imports", specifier: "./billing" },
      ]),
      "utf8",
    );
  }

  return { cwd, registryPath };
}

const ALL_LAYERS: KnowledgeLayer[] = [
  "wiki-identity",
  "wiki-index",
  "wiki-freshness",
  "memory",
  "graph",
  "sac-evidence",
];

describe("propagation across the layers a deletion touches (flow 242 lane E, AC1)", () => {
  test("every layer appears, each with a cause, and no reference is left unnamed", async () => {
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });

      // Completeness is the property that makes "report" a real answer rather
      // than the silence with a heading on it: a layer missing from the report
      // is a dangling reference nobody was told about.
      expect(report.layers.map((layer) => layer.layer).sort()).toEqual([...ALL_LAYERS].sort());
      for (const layer of report.layers) {
        expect(layer.cause.length).toBeGreaterThan(0);
      }

      expect(report.status).toBe("dangling");

      const memory = report.layers.find((layer) => layer.layer === "memory");
      expect(memory?.propagated).toBe(false);
      expect(memory?.dangling.map((reference) => reference.verdict)).toEqual(["removed", "removed"]);

      const graph = report.layers.find((layer) => layer.layer === "graph");
      expect(graph?.dangling.some((reference) => reference.verdict === "unresolved-import")).toBe(true);
      expect(graph?.dangling.some((reference) => reference.verdict === "orphaned-by-dangling")).toBe(true);
      // Everything the window explains is explained: nothing is left over to be
      // reported as an unattributable count.
      expect(graph?.unclassified).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("an UNDETERMINED window is never reported as a window that was checked and found empty", async () => {
    // T8. The graph cannot tell an import whose target was removed from one that
    // never resolved — so with no window it must attribute nothing. What it must
    // ALSO not do is deny: the report used to answer "The deletion window was
    // checked and is EMPTY — git reports no code file deleted since the graph
    // was built — so none of these can be a reference into knowledge removed in
    // this window", for a run that never computed a window at all, and then
    // close the reconcile `clean`.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(NO_WINDOW),
      });
      const graph = report.layers.find((layer) => layer.layer === "graph");
      expect(graph?.dangling).toEqual([]);
      expect(graph?.unclassified?.count).toBe(1);
      expect(graph?.unclassified?.cause).toContain("THE DELETION WINDOW COULD NOT BE DETERMINED");
      // The denial, in the exact words it used to be made in.
      expect(graph?.unclassified?.cause).not.toContain("checked and is EMPTY");

      // …and an undecided layer is a FAILED inspection, so the run cannot come
      // back clean over it. This is the half that made the defect a blocker
      // rather than a wording problem.
      expect(graph?.inspection).toBe("failed");
      expect(report.status).toBe("undecidable");
      expect(report.status).not.toBe("clean");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a window that WAS computed and found nothing still says so — the empty case stays reachable", async () => {
    // The negative control for the test above. Without it, "never say the window
    // was empty" is satisfiable by deleting the sentence, and the report loses a
    // true thing it is entitled to say.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(windowOf()),
      });
      const graph = report.layers.find((layer) => layer.layer === "graph");
      expect(graph?.unclassified?.cause).toContain("checked and is EMPTY");
      expect(graph?.inspection).toBe("examined");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a graph this run did not rebuild is not reported as propagated", async () => {
    // The graph layer hardcoded `propagated: true` on its success path, so a
    // report-only run claimed the removal had propagated into a graph that had
    // not been rebuilt and still answered `gdgraph affected` with the deleted
    // file.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: { rebuiltInThisRun: false, window: windowOf("src/billing.ts") },
      });
      const graph = report.layers.find((layer) => layer.layer === "graph");
      expect(graph?.propagated).toBe(false);
      expect(graph?.cause).toContain("did not rebuild the code graph");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("the removed identity is reported with what the system ANSWERS for it", async () => {
    // AC7: a confirmation has to carry an observed response to a reference into
    // deleted knowledge. A list of what was deleted would be exactly the
    // retention-shaped evidence AC7 rejects, so the report runs the resolver.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });
      expect(report.removed.map((identity) => identity.ref)).toEqual([
        "keryx:page/architecture-billing-charges",
        "keryx:page/architecture-billing-charges#constraints",
      ]);
      for (const identity of report.removed) {
        expect(identity.observedResponse).toContain("resolves to a tombstone");
        expect(identity.observedResponse).toContain("billing moved to the payments service");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a layer this reconcile does not inspect is named, not omitted", async () => {
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });
      // Without this the report would claim a completeness it does not have:
      // "not checked" reading as "checked and clean" is the collapse this whole
      // flow exists to remove, and it would be committed by the report itself.
      expect(report.notExamined).toContain("sac-evidence");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("control: with nothing removed the report is clean and names no dangling reference", async () => {
    // A report that always says "dangling" proves nothing. This is the negative
    // control for every assertion above.
    const { cwd } = await fourLayerProject({ deleted: false });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: [] },
        graphLayer: rebuiltAgainst(windowOf()),
      });
      expect(report.status).toBe("clean");
      expect(report.removed).toEqual([]);
      expect(report.removedInThisRun).toEqual([]);
      expect(report.layers.flatMap((layer) => layer.dangling)).toEqual([]);
      // …and the not-examined disclosure is still made, on a clean report too.
      expect(report.notExamined).toContain("sac-evidence");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("the layer list is complete, and the two that were missing are in it (flow 242 lane E, AC1)", () => {
  test("the generated index is examined, and a link to a deleted page is reported", async () => {
    // `.metaproject/wiki/index.md` is rewritten only by `keryx sync --apply`, so
    // a report-only run reads an index generated BEFORE the deletion and still
    // offering the reader a link into the page that is gone. The four-layer list
    // did not include it, and a layer absent from a completeness report reads
    // exactly like a layer that was checked and found clean.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      await writeFile(
        path.join(cwd, ".metaproject", "wiki", "index.md"),
        [
          "# Wiki",
          "",
          "- [Billing Charges](architecture/billing-charges.md)",
          "- [Orders](architecture/orders.md)",
          "- [Upstream](https://example.invalid/x.md)",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(cwd, ".metaproject", "wiki", "architecture", "orders.md"),
        "# Orders\n",
        "utf8",
      );

      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });
      const index = report.layers.find((layer) => layer.layer === "wiki-index");
      expect(index?.inspection).toBe("examined");
      // The deleted page is named; the page that is still there and the external
      // link are not — a check that flagged everything would prove nothing.
      expect(index?.dangling.map((reference) => reference.reference)).toEqual([
        "architecture/billing-charges.md",
      ]);
      expect(report.status).toBe("dangling");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("control: an index whose links all resolve reports no dangling reference", async () => {
    const { cwd } = await fourLayerProject({ deleted: false });
    try {
      await writeFile(
        path.join(cwd, ".metaproject", "wiki", "index.md"),
        "# Wiki\n\n- [Billing Charges](architecture/billing-charges.md)\n",
        "utf8",
      );
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: [] },
        graphLayer: rebuiltAgainst(windowOf()),
      });
      const index = report.layers.find((layer) => layer.layer === "wiki-index");
      expect(index?.dangling).toEqual([]);
      expect(index?.inspection).toBe("examined");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("the freshness queue is named with a cause, and named as NOT examined", async () => {
    // The layer this flow's own description lists and the report omitted. It is
    // under-claimed on purpose: its rows say "these paths changed at this
    // revision", which stays true after a deletion. What must not happen is its
    // absence, which reads as a clean bill.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: REMOVED_REFS },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });
      expect(report.notExamined).toContain("wiki-freshness");
      const freshness = report.layers.find((layer) => layer.layer === "wiki-freshness");
      expect(freshness?.cause).toContain("freshness-queue.jsonl");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("a removal on record belongs to the run that made it (flow 242 lane E, AC6)", () => {
  test("a run that tombstoned ONE identity claims one, not the whole registry", async () => {
    // T7, at its source. The fixture's registry holds two tombstones — the state
    // an earlier run left. This run's write produced exactly one of them; the
    // other was already on disk when it started. Reading `registry.tombstones`
    // as "what I removed" is what put Alice's deletions into Bob's append-only
    // record under Bob's stated reason.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const mine = "keryx:page/architecture-billing-charges#constraints";
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: [mine] },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });

      expect(report.removedInThisRun.map((identity) => identity.ref)).toEqual([mine]);
      // The other removal is still REPORTED — a reference into it still resolves
      // to a tombstone, which is AC7's evidence — and is attributed elsewhere.
      expect(report.removed).toHaveLength(2);
      expect(
        report.removed.find((identity) => identity.ref !== mine)?.recordedBy,
      ).toBe("an-earlier-run");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a run that tombstoned nothing claims nothing, however much is on record", async () => {
    // The no-op. Every `--apply` run appended a record naming every removal in
    // the registry, so a sync that changed nothing filed a permanent
    // `outcome: "propagated"` entry for six deletions it did not make.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true, tombstonedNow: [] },
        graphLayer: rebuiltAgainst(windowOf()),
      });
      expect(report.removed).toHaveLength(2);
      expect(report.removedInThisRun).toEqual([]);
      expect(report.removed.every((identity) => identity.recordedBy === "an-earlier-run")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("a layer that could not be read never reports clean (flow 242 lane E, AC1/AC3)", () => {
  test("an unreadable registry makes the whole report undecidable", async () => {
    const { cwd, registryPath } = await fourLayerProject({ deleted: true });
    try {
      // A REAL unreadable store, not an injected error: the file is there and
      // holds history, and the process cannot read it.
      await chmod(registryPath, 0o000);

      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: false, cause: "not applied in this run" },
        graphLayer: rebuiltAgainst(windowOf("src/billing.ts")),
      });

      expect(report.status).toBe("undecidable");
      expect(report.status).not.toBe("clean");
      const identity = report.layers.find((layer) => layer.layer === "wiki-identity");
      expect(identity?.inspection).toBe("failed");
      expect(identity?.cause).toContain("could not be read");
      // An empty dangling list on a failed inspection must not read as "nothing
      // is broken" — the status carries that, which is why it is checked here.
      expect(identity?.dangling).toEqual([]);
    } finally {
      await chmod(registryPath, 0o600).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
