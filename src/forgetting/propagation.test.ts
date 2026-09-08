import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reportPropagation, type KnowledgeLayer } from "./propagation";

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

const ALL_LAYERS: KnowledgeLayer[] = ["wiki-identity", "memory", "graph", "sac-evidence"];

describe("propagation across the layers a deletion touches (flow 242 lane E, AC1)", () => {
  test("every layer appears, each with a cause, and no reference is left unnamed", async () => {
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({
        cwd,
        identityLayer: { propagated: true },
        deletedFiles: ["src/billing.ts"],
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

  test("without a deletion window, no import is ATTRIBUTED to a deletion — it is counted and said so", async () => {
    // The graph cannot tell an import whose target was removed from one that
    // never resolved. Measured on this repository's own graph: dozens of
    // in-project unresolved specifiers, nearly all of them import statements
    // written inside test FIXTURE strings (`src/gdgraph/build-integrity.test.ts`
    // contains `import "./dep"` as fixture content). Reporting those as
    // references into removed knowledge would be a fabrication at scale; hiding
    // them would be the silence. Counted, with the reason, is the third answer.
    const { cwd } = await fourLayerProject({ deleted: true });
    try {
      const report = await reportPropagation({ cwd, identityLayer: { propagated: true } });
      const graph = report.layers.find((layer) => layer.layer === "graph");
      expect(graph?.dangling).toEqual([]);
      expect(graph?.unclassified?.count).toBe(1);
      expect(graph?.unclassified?.cause).toContain("NO deletion window was supplied");
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
        identityLayer: { propagated: true },
        deletedFiles: ["src/billing.ts"],
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
      const report = await reportPropagation({ cwd, identityLayer: { propagated: true } });
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
      const report = await reportPropagation({ cwd, identityLayer: { propagated: true } });
      expect(report.status).toBe("clean");
      expect(report.removed).toEqual([]);
      expect(report.layers.flatMap((layer) => layer.dangling)).toEqual([]);
      // …and the not-examined disclosure is still made, on a clean report too.
      expect(report.notExamined).toContain("sac-evidence");
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
