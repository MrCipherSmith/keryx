import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkMemoryCrossLayer, extractWikiReferences, loadWikiKnowledgeView } from "./cross-layer";
import { checkMemory } from "./check";
import { collectEntries } from "./store";
import { DEFAULT_MEMORY_CONFIG } from "./config";

// A project where one piece of knowledge lives in the wiki and is cited by a
// memory entry — the two-layer core of the AC1 fixture, built on disk so the
// resolver runs against real files and a real registry rather than a stub.

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
  "See also [the spec](https://example.invalid/spec) and [a sibling](./other.md).",
  "",
  "## Provenance",
  "",
  "- Created: 2026-09-01",
  "",
].join("\n");

async function project(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-cross-layer-"));
  await mkdir(path.join(cwd, ".metaproject", "wiki", "architecture"), { recursive: true });
  await mkdir(path.join(cwd, ".metaproject", "memory", "decisions"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"), PAGE, "utf8");
  await writeFile(path.join(cwd, ".metaproject", "memory", "decisions", "charge-once.md"), ENTRY, "utf8");
  return cwd;
}

const REGISTRY_PATH = (cwd: string) => path.join(cwd, ".metaproject", "wiki", ".sections.json");

/** The registry as `keryx wiki sections sync` writes it before the deletion. */
async function registerPage(cwd: string, digest: { page: string; section: string }): Promise<void> {
  await writeFile(
    REGISTRY_PATH(cwd),
    `${JSON.stringify(
      {
        version: 2,
        entries: [
          {
            kind: "page",
            ref: "keryx:page/architecture-billing-charges",
            page: "architecture/billing-charges.md",
            title: "Billing Charges",
            digest: digest.page,
            registeredAt: "2026-09-01T00:00:00.000Z",
          },
          {
            kind: "section",
            ref: "keryx:page/architecture-billing-charges#constraints",
            page: "architecture/billing-charges.md",
            title: "Constraints",
            digest: digest.section,
            registeredAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        tombstones: [],
        lifted: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** The registry after the removal was recorded. */
async function tombstonePage(cwd: string): Promise<void> {
  const tombstone = (kind: string, ref: string, title: string) => ({
    kind,
    ref,
    page: "architecture/billing-charges.md",
    title,
    digest: "deadbeef",
    registeredAt: "2026-09-01T00:00:00.000Z",
    removedAt: "2026-09-05T10:00:00.000Z",
    reason: "billing moved to the payments service",
  });
  await writeFile(
    REGISTRY_PATH(cwd),
    `${JSON.stringify(
      {
        version: 2,
        entries: [],
        tombstones: [
          tombstone("page", "keryx:page/architecture-billing-charges", "Billing Charges"),
          tombstone("section", "keryx:page/architecture-billing-charges#constraints", "Constraints"),
        ],
        lifted: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("extracting the references a memory entry actually holds (flow 242 lane E)", () => {
  test("finds the wiki page link and the section identity, and only those", () => {
    const cwd = "/p";
    const references = extractWikiReferences(
      "decisions/charge-once.md",
      path.join(cwd, ".metaproject", "memory", "decisions", "charge-once.md"),
      ENTRY,
      path.join(cwd, ".metaproject", "wiki"),
    );
    expect(references.map((reference) => [reference.kind, reference.target])).toEqual([
      ["page-path", "architecture/billing-charges.md"],
      ["section-ref", "keryx:page/architecture-billing-charges#constraints"],
    ]);
    // An https link and a sibling link that lands outside the wiki are not
    // cross-layer references and must not be reported as broken ones.
    expect(references.some((reference) => reference.raw.startsWith("http"))).toBe(false);
    expect(references.some((reference) => reference.raw === "./other.md")).toBe(false);
  });

  test("references are found anywhere in the file, not only in Summary/Details", () => {
    // `parseEntry` exposes only those two sections. A reference in Provenance
    // would be invisible to a check built on the parsed entry, so extraction
    // reads the raw bytes.
    const content = ["# X", "", "## Provenance", "", "- Source: `keryx:page/architecture-billing-charges`", ""].join(
      "\n",
    );
    const references = extractWikiReferences("decisions/x.md", "/p/.metaproject/memory/decisions/x.md", content, "/p/.metaproject/wiki");
    expect(references).toHaveLength(1);
    expect(references[0]?.line).toBe(5);
  });
});

describe("what memory is told about a reference into removed knowledge (flow 242 lane E, AC1)", () => {
  test("a live page resolves intact — the check can pass", async () => {
    const cwd = await project();
    try {
      const view = await loadWikiKnowledgeView(cwd);
      const findings = await checkMemoryCrossLayer(cwd, await collectEntries(cwd), view);
      expect(findings).toHaveLength(2);
      expect(findings.every((finding) => finding.state === "intact")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a deleted-and-recorded page answers REMOVED, with when and why", async () => {
    const cwd = await project();
    try {
      await tombstonePage(cwd);
      await rm(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"));

      const findings = await checkMemoryCrossLayer(cwd, await collectEntries(cwd));
      expect(findings.map((finding) => finding.state)).toEqual(["removed", "removed"]);
      expect(findings[0]?.removedAt).toBe("2026-09-05T10:00:00.000Z");
      expect(findings[0]?.detail).toContain("billing moved to the payments service");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("deleted but not yet recorded is PENDING-REMOVAL, never never-existed", async () => {
    const cwd = await project();
    try {
      const view = await loadWikiKnowledgeView(cwd);
      const page = view.index.pages.get("architecture/billing-charges.md");
      await registerPage(cwd, {
        page: page?.contentDigest ?? "",
        section: page?.sections[1]?.digest ?? "",
      });
      await rm(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"));

      const findings = await checkMemoryCrossLayer(cwd, await collectEntries(cwd));
      expect(findings.map((finding) => finding.state)).toEqual(["pending-removal", "pending-removal"]);
      for (const finding of findings) {
        expect(finding.detail).toContain('not "never existed"');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("nothing on record is NO-RECORD, and does not claim the knowledge never existed", async () => {
    const cwd = await project();
    try {
      await rm(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"));

      const findings = await checkMemoryCrossLayer(cwd, await collectEntries(cwd));
      expect(findings.map((finding) => finding.state)).toEqual(["no-record", "no-record"]);
      for (const finding of findings) {
        // The honest boundary: the registry only records marker-carrying pages,
        // so silence from it is not evidence of non-existence. Both answers say
        // NO RECORD and both explicitly decline the stronger claim.
        expect(finding.detail).toContain("NO RECORD");
        expect(finding.detail).toContain("never existed");
        expect(finding.detail).toMatch(/not (proof|evidence)/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("an unreadable registry is UNDECIDABLE even while the page is still on disk", async () => {
    // The page IS present here, deliberately. A resolver that checks the
    // filesystem first answers `intact` and never consults the history — and a
    // reoccupation is recorded only in that history, so `intact` would be a
    // claim it has no basis for. This is the same ordering `resolveSectionIdentity`
    // adopted in lane B, asserted here on the page path too.
    const cwd = await project();
    try {
      await writeFile(REGISTRY_PATH(cwd), "{ broken\n", "utf8");
      await chmod(REGISTRY_PATH(cwd), 0o000);

      const findings = await checkMemoryCrossLayer(cwd, await collectEntries(cwd));
      expect(findings.map((finding) => finding.state)).toEqual(["undecidable", "undecidable"]);
      expect(findings[0]?.detail).toContain("CANNOT BE DETERMINED");
    } finally {
      await chmod(REGISTRY_PATH(cwd), 0o600).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("substitution: a different page at the same address is REOCCUPIED, not intact", async () => {
    // The measured failure this whole identity mechanism exists for: delete a
    // page, write a different one carrying the same marker id, and the citation
    // resolves to content that contradicts what was removed. A memory entry
    // whose reference silently starts pointing at a stranger is worse than one
    // whose reference is broken — it still reads as correct.
    const cwd = await project();
    try {
      await tombstonePage(cwd);
      await writeFile(
        path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"),
        [
          '<!-- keryx:page id="architecture-billing-charges" v=1 -->',
          "# Billing Charges",
          "",
          "Version: 2.0.0",
          "Type: architecture",
          "Status: accepted",
          "",
          "## Summary",
          "",
          "Charges are retried three times with exponential backoff.",
          "",
          '<!-- keryx:section id="constraints" v=1 -->',
          "## Constraints",
          "",
          "A charge is retried automatically on a transient failure.",
          "<!-- /keryx:section -->",
          "",
        ].join("\n"),
        "utf8",
      );

      const findings = await checkMemoryCrossLayer(cwd, await collectEntries(cwd));
      const sectionFinding = findings.find((finding) => finding.reference.kind === "section-ref");
      expect(sectionFinding?.state).toBe("reoccupied");
      // …and the PAGE PATH answers the same way. Measured live before this was
      // fixed: the section identity said `reoccupied` while the link one level
      // up said `intact`, because a file existed at the path. A path is an
      // address, and an address can be reoccupied exactly as an id can.
      const pageFinding = findings.find((finding) => finding.reference.kind === "page-path");
      expect(pageFinding?.state).toBe("reoccupied");
      expect(pageFinding?.detail).toContain("NOT the content that was removed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("keryx memory check reports cross-layer references (flow 242 lane E, AC1)", () => {
  test("the deleted page now produces issues — it produced `All checks passed` before", async () => {
    const cwd = await project();
    try {
      await tombstonePage(cwd);
      await rm(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"));

      const result = await checkMemory(cwd, DEFAULT_MEMORY_CONFIG);
      expect(result.ok).toBe(false);
      const crossLayer = result.issues.filter((issue) => issue.kind === "cross-layer");
      expect(crossLayer).toHaveLength(2);
      expect(crossLayer[0]?.path).toBe("decisions/charge-once.md");
      expect(crossLayer[0]?.message).toContain("REMOVED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("control: with the page present the check reports no cross-layer issue", async () => {
    // Without this, the check above could be satisfied by a rule that flags
    // every reference — a guard that always fires is not a guard.
    const cwd = await project();
    try {
      const result = await checkMemory(cwd, DEFAULT_MEMORY_CONFIG);
      expect(result.issues.filter((issue) => issue.kind === "cross-layer")).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("an entry that cannot be READ is undecidable, not silently clean", async () => {
    // The defect this pins was in the first version of `checkMemoryCrossLayer`:
    // `readFile(...).catch(() => null)` followed by a bare `continue`. An entry
    // the pass could not open contributed ZERO findings, which is
    // byte-identical to an entry that WAS read and cites nothing — the same
    // collapse of "I could not tell" into "nothing is wrong" that this lane
    // exists to remove, sitting inside the module that removes it.
    //
    // The window is real rather than hypothetical: `collectEntries` reads the
    // corpus first and this pass reads each entry again, so anything that makes
    // a file unreadable between the two lands here, as does any caller that
    // supplies entries it collected earlier — which is exactly what
    // `../forgetting/propagation.ts` does.
    //
    // Reverting the fix to `continue` makes every assertion below fail: the
    // finding list goes empty.
    const cwd = await project();
    const entry = path.join(cwd, ".metaproject", "memory", "decisions", "charge-once.md");
    try {
      const entries = await collectEntries(cwd);
      // Genuinely unreadable, not a substituted error — the same discipline
      // AC3 demands of the refusal path.
      await chmod(entry, 0o000);

      const findings = await checkMemoryCrossLayer(cwd, entries);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.state).toBe("undecidable");
      expect(findings[0]?.detail).toContain("CANNOT BE DETERMINED");
      // Line 0 says "about the entry", not "about line 0 of the entry", and
      // `checkMemory` renders it without a line prefix for that reason.
      expect(findings[0]?.reference.line).toBe(0);
    } finally {
      await chmod(entry, 0o600).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
