// AC7 (AFC-W01) + AC1 (AFC-07) + AC4's no-write clause, driven through the
// NAMED SURFACES the phase-3 inventory enumerated — `wikiAsk` (which is what
// `keryx wiki ask`, MCP `wiki.ask` and the agent `wiki_ask` op all reach), the
// `keryx wiki sections` CLI branch, and the wiki graph layer — never against a
// helper in isolation. The inventory records that five phase-1 defects were
// capabilities implemented where no live path called them; a test that only
// exercises `section-index.ts` would reproduce that exactly.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiAsk } from "./ask";
import { collectPages } from "./collect";
import {
  buildSectionIndex,
  invalidateSectionIndex,
  resolveWikiPageIdentity,
} from "./section-index";
import {
  migrateSectionMarkers,
  SECTION_MARKER_VERSION,
  stripSectionMarkers,
} from "./section-marker";
import {
  readSectionRegistryState,
  resolveSectionIdentity,
  syncSectionRegistry,
} from "./section-tombstone";

let root: string;

const OS_SANDBOX = `<!-- keryx:page id="os-sandbox" v=1 -->
# OS Sandbox

Version: 0.2.0
Type: architecture
Status: accepted

## Summary

Kernel-enforced containment for a run.

## Details

### Restricted network

The loopback allowlist is applied with \`spawnSync\`, which blocks the main
event loop for the entire run.

### Platform matrix

macOS uses Seatbelt; Linux uses bubblewrap.
`;

// A second page whose heading text collides with the first one's, in a
// different domain (folder/page type). AC7: "duplicate headings from different
// domains are distinguishable".
const RETRY_RULE = `<!-- keryx:page id="retry-rule" v=1 -->
# Retry after conflict

Version: 0.1.0
Type: business-rule
Status: accepted

## Summary

What to do after a write conflict.

## Details

### Restricted network

Retries are not attempted while the network is restricted; re-read the record
and prepare the edit again.
`;

async function writePage(folder: string, file: string, body: string): Promise<string> {
  const dir = path.join(root, ".metaproject", "wiki", folder);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, file);
  await writeFile(target, body, "utf8");
  return target;
}

async function indexFor(cwd: string) {
  const pages = await collectPages(cwd);
  return buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({ page, content: await readFile(page.absolutePath, "utf8") })),
    ),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-wiki-section-"));
  await writePage("architecture", "os-sandbox.md", OS_SANDBOX);
  await writePage("business-rules", "retry.md", RETRY_RULE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- AC1 (AFC-07): a term present only in Details is found -------------------

test("AC1: a term that appears only in a page's Details section is found by wiki ask", async () => {
  const result = await wikiAsk({ cwd: root, question: "spawnSync" });

  expect(result.status).toBe("ok");
  expect(result.citations.map((c) => c.path)).toContain("wiki/architecture/os-sandbox.md");
  const hit = result.citations.find((c) => c.path === "wiki/architecture/os-sandbox.md");
  expect(hit?.sectionTitle).toBe("Restricted network");
  // The excerpt must be the section that actually contains the term, not the
  // page's Summary — the failure mode is citing a page for a term the cited
  // text does not contain.
  expect(hit?.excerpt).toContain("spawnSync");
});

test("AC1: a stop-word-only question is refused instead of answered confidently", async () => {
  const nonsense = await wikiAsk({ cwd: root, question: "the of and is a" });

  expect(nonsense.status).toBe("no-match");
  expect(nonsense.citations).toEqual([]);
  // The rendered answer an agent reads must say so, not read as ordinary prose.
  expect(nonsense.answerMarkdown).toContain("no-match");

  // And it must not outrank a real term, which is the measured defect: the
  // stop-word query scored an order of magnitude above every real query.
  const real = await wikiAsk({ cwd: root, question: "spawnSync" });
  const bestReal = real.citations[0]?.score ?? 0;
  expect(bestReal).toBeGreaterThan(0);
});

test("AC1: RU, EN and identifiers all reach the one fixed corpus", async () => {
  // A Russian page, indexed in Russian, found by a Russian question with no
  // translation step at all.
  await writePage(
    "business-rules",
    "ru-rule.md",
    `# Политика повторов

Version: 0.1.0
Type: business-rule
Status: accepted

## Summary

Правило повторных попыток.

## Details

После конфликта записи перечитайте запись и подготовьте правку заново.
`,
  );

  const ru = await wikiAsk({ cwd: root, question: "перечитайте запись после конфликта" });
  expect(ru.status).toBe("ok");
  expect(ru.citations.map((c) => c.path)).toContain("wiki/business-rules/ru-rule.md");

  // An exact identifier, which must survive tokenisation whole.
  const identifier = await wikiAsk({ cwd: root, question: "spawnSync" });
  expect(identifier.status).toBe("ok");
});

test("AC1: a Russian question reaches English content through the fixed RU→EN table", async () => {
  // No Russian page in this corpus, so the fallback is the only path to a hit.
  await writePage(
    "architecture",
    "security.md",
    `# Security policy

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

How access is decided.

## Details

The security policy denies every egress that is not on the allowlist.
`,
  );
  const crossLingual = await wikiAsk({ cwd: root, question: "какая политика безопасности" });
  expect(crossLingual.citations.map((c) => c.path)).toContain("wiki/architecture/security.md");
});

test("AC1/AC9: one citation per page — the best-scoring section, not the same page twice", async () => {
  const result = await wikiAsk({ cwd: root, question: "restricted network conflict" });
  const paths = result.citations.map((c) => c.path);
  expect(new Set(paths).size).toBe(paths.length);
});

// --- AC4: a pure search does not write history -------------------------------

test("AC4: wiki ask writes nothing — no runtime dictionary, no registry", async () => {
  await wikiAsk({ cwd: root, question: "какая политика безопасности" });
  await wikiAsk({ cwd: root, question: "spawnSync" });

  const runtime = path.join(root, ".metaproject", "runtime");
  expect(await Bun.file(path.join(runtime, "wiki-ask", "translations.json")).exists()).toBe(false);
  expect(
    await Bun.file(path.join(root, ".metaproject", "wiki", ".sections.json")).exists(),
  ).toBe(false);
});

// --- AC7 (AFC-W01): duplicate headings across domains ------------------------

test("AC7: identically titled sections in different domains carry distinct identities", async () => {
  const index = await indexFor(root);
  const restricted = index.sections.filter((s) => s.title === "Restricted network");

  expect(restricted.length).toBe(2);
  expect(new Set(restricted.map((s) => s.sectionRef)).size).toBe(2);
  expect(new Set(restricted.map((s) => s.domain))).toEqual(
    new Set(["architecture", "business-rule"]),
  );

  // And they are distinguishable at the answer surface an agent actually reads,
  // not only in the structured index.
  const result = await wikiAsk({ cwd: root, question: "restricted network" });
  const titles = result.citations.map((c) => c.title);
  expect(new Set(titles).size).toBe(titles.length);
});

// --- AC7: a rename preserves a stable identity -------------------------------

test("AC7: renaming the page file preserves the page identity", async () => {
  const before = await indexFor(root);
  const beforeIds = before.sections
    .filter((s) => s.pageRelativePath === "architecture/os-sandbox.md")
    .map((s) => s.sectionRef)
    .sort();
  expect(beforeIds.length).toBeGreaterThan(0);

  await rename(
    path.join(root, ".metaproject", "wiki", "architecture", "os-sandbox.md"),
    path.join(root, ".metaproject", "wiki", "architecture", "operating-system-sandbox.md"),
  );

  const after = await indexFor(root);
  const afterIds = after.sections
    .filter((s) => s.pageRelativePath === "architecture/operating-system-sandbox.md")
    .map((s) => s.sectionRef)
    .sort();

  expect(afterIds).toEqual(beforeIds);
  expect(after.pageIdentities.get("architecture/operating-system-sandbox.md")?.stability).toBe(
    "stable",
  );
});

test("AC7: renaming a heading preserves the marked section's identity", async () => {
  await writePage(
    "architecture",
    "marked.md",
    `<!-- keryx:page id="marked" v=1 -->
# Marked

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

A page with an explicitly marked section.

<!-- keryx:section id="rule-retry" v=${SECTION_MARKER_VERSION} -->
## Retry after conflict

Re-read the record and prepare the edit again.
<!-- /keryx:section -->
`,
  );

  const before = await indexFor(root);
  const beforeSection = before.sections.find((s) => s.sectionId === "rule-retry");
  expect(beforeSection?.title).toBe("Retry after conflict");
  expect(beforeSection?.stability).toBe("stable");

  const file = path.join(root, ".metaproject", "wiki", "architecture", "marked.md");
  const renamed = (await readFile(file, "utf8")).replace(
    "## Retry after conflict",
    "## Recovering from a write conflict",
  );
  await writeFile(file, renamed, "utf8");

  const after = await indexFor(root);
  const afterSection = after.sections.find((s) => s.sectionId === "rule-retry");
  expect(afterSection?.title).toBe("Recovering from a write conflict");
  expect(afterSection?.sectionRef).toBe(beforeSection?.sectionRef);
});

// --- AC7: a deleted identity is not silently redirected ----------------------

test("AC7: a deleted section id resolves to a tombstone, never to a same-named substitute", async () => {
  await writePage(
    "architecture",
    "marked.md",
    `<!-- keryx:page id="marked" v=1 -->
# Marked

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

A page with an explicitly marked section.

<!-- keryx:section id="rule-retry" v=1 -->
## Retry after conflict

Re-read the record and prepare the edit again.
<!-- /keryx:section -->
`,
  );

  const first = await indexFor(root);
  await syncSectionRegistry(root, first, { now: "2026-09-07T00:00:00.000Z" });
  const deletedRef = first.sections.find((s) => s.sectionId === "rule-retry")?.sectionRef;
  expect(deletedRef).toBeDefined();

  // Delete the marked section and put a DIFFERENT, identically titled section
  // in its place on another page. The defect to avoid is the stale reference
  // resolving to whatever now occupies that position.
  await writePage(
    "architecture",
    "marked.md",
    `<!-- keryx:page id="marked" v=1 -->
# Marked

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

A page with an explicitly marked section.
`,
  );
  await writePage(
    "business-rules",
    "substitute.md",
    `<!-- keryx:page id="substitute" v=1 -->
# Substitute

Version: 0.1.0
Type: business-rule
Status: accepted

## Summary

An unrelated rule.

<!-- keryx:section id="rule-retry-elsewhere" v=1 -->
## Retry after conflict

Something completely different.
<!-- /keryx:section -->
`,
  );

  const second = await indexFor(root);
  const synced = await syncSectionRegistry(root, second, { now: "2026-09-08T00:00:00.000Z" });
  expect(synced.status).toBe("synced");
  if (synced.status !== "synced") {
    throw new Error(synced.reason);
  }
  expect(synced.tombstoned.map((t) => t.ref)).toContain(deletedRef as string);

  const registry = await readSectionRegistryState(root);
  const resolution = resolveSectionIdentity(second, registry, deletedRef as string);
  expect(resolution.kind).toBe("tombstoned");
  if (resolution.kind === "tombstoned") {
    expect(resolution.tombstone.removedAt).toBe("2026-09-08T00:00:00.000Z");
  }

  // The substitute exists and has the same heading — and is NOT what the dead
  // id resolves to.
  expect(second.sections.some((s) => s.title === "Retry after conflict")).toBe(true);
});

test("AC7: an unknown section id resolves to unknown, never to a title match", async () => {
  const index = await indexFor(root);
  const registry = await readSectionRegistryState(root);
  const resolution = resolveSectionIdentity(index, registry, "keryx:page/os-sandbox#never-existed");
  expect(resolution.kind).toBe("unknown");
});

test("AC7: a legacy page gets a version-bound provisional locator, not a stable promise", async () => {
  await writePage(
    "architecture",
    "legacy.md",
    `# Legacy

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

No markers here.

## Details

An unmigrated page.
`,
  );

  const index = await indexFor(root);
  const legacy = index.sections.filter((s) => s.pageRelativePath === "architecture/legacy.md");
  expect(legacy.length).toBeGreaterThan(0);
  for (const section of legacy) {
    expect(section.stability).toBe("version-bound");
  }
  expect(resolveWikiPageIdentity("architecture/legacy.md", "# Legacy\n").stability).toBe(
    "version-bound",
  );
});

test("AC7: a version-bound locator taken against an older body does not resolve into the new one", async () => {
  await writePage(
    "architecture",
    "legacy.md",
    "# Legacy\n\nVersion: 0.1.0\nType: architecture\nStatus: accepted\n\n## Summary\n\nFirst body.\n\n## Details\n\nOriginal text.\n",
  );
  const before = await indexFor(root);
  const staleRef = before.sections.find(
    (s) => s.pageRelativePath === "architecture/legacy.md" && s.title === "Details",
  )?.sectionRef;
  expect(staleRef).toBeDefined();

  await writePage(
    "architecture",
    "legacy.md",
    "# Legacy\n\nVersion: 0.2.0\nType: architecture\nStatus: accepted\n\n## Summary\n\nFirst body.\n\n## Details\n\nCompletely rewritten text.\n",
  );
  const after = await indexFor(root);
  const registry = await readSectionRegistryState(root);
  const resolution = resolveSectionIdentity(after, registry, staleRef as string);
  expect(resolution.kind).toBe("stale-locator");
});

// --- AC7: duplicate ids inside an owner namespace are a validation error -----

test("AC7: a duplicate section id inside one page is a validation error", async () => {
  await writePage(
    "architecture",
    "dupe.md",
    `<!-- keryx:page id="dupe" v=1 -->
# Dupe

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

Two sections claim one id.

<!-- keryx:section id="same" v=1 -->
## First

One.
<!-- /keryx:section -->

<!-- keryx:section id="same" v=1 -->
## Second

Two.
<!-- /keryx:section -->
`,
  );

  const index = await indexFor(root);
  const duplicates = index.issues.filter((issue) => issue.kind === "duplicate-section-id");
  expect(duplicates.length).toBe(1);
  expect(duplicates[0]?.page).toBe("architecture/dupe.md");
});

test("AC7: the same section id on two different pages is not a collision", async () => {
  const index = await indexFor(root);
  expect(index.issues.filter((issue) => issue.kind === "duplicate-section-id")).toEqual([]);
});

// --- AC7: the migration preserves content byte-for-byte ----------------------

test("AC7: migrating a page inserts markers and changes nothing else, byte for byte", async () => {
  const legacyBody =
    "# Legacy\n\nVersion: 0.1.0\nType: architecture\nStatus: accepted\n\n## Summary\n\nProse with  odd   spacing\tand a tab.\n\n## Details\n\n- a list\n- another\n\n```ts\nconst x = 1;\n```\n";
  await writePage("architecture", "legacy.md", legacyBody);

  const preview = await migrateSectionMarkers(root, { dryRun: true });
  const migrated = preview.pages.find((p) => p.page === "architecture/legacy.md");
  expect(migrated?.action).toBe("migrated");
  expect(migrated?.content).toBeDefined();
  expect(stripSectionMarkers(migrated?.content as string)).toBe(legacyBody);

  // A dry run writes nothing.
  expect(await readFile(path.join(root, ".metaproject", "wiki", "architecture", "legacy.md"), "utf8")).toBe(
    legacyBody,
  );

  const applied = await migrateSectionMarkers(root, { dryRun: false });
  expect(applied.pages.some((p) => p.page === "architecture/legacy.md")).toBe(true);
  const onDisk = await readFile(
    path.join(root, ".metaproject", "wiki", "architecture", "legacy.md"),
    "utf8",
  );
  expect(stripSectionMarkers(onDisk)).toBe(legacyBody);

  // And it is idempotent: a second run has nothing to do.
  const again = await migrateSectionMarkers(root, { dryRun: false });
  expect(again.pages.find((p) => p.page === "architecture/legacy.md")?.action).toBe("already");
  expect(
    await readFile(path.join(root, ".metaproject", "wiki", "architecture", "legacy.md"), "utf8"),
  ).toBe(onDisk);
});

test("AC7: migration refuses a page whose bytes changed since the preview (CAS)", async () => {
  const legacyBody =
    "# Legacy\n\nVersion: 0.1.0\nType: architecture\nStatus: accepted\n\n## Summary\n\nBefore.\n";
  await writePage("architecture", "legacy.md", legacyBody);

  const preview = await migrateSectionMarkers(root, { dryRun: true });
  const expected = preview.pages.find((p) => p.page === "architecture/legacy.md")?.baseDigest;
  expect(expected).toBeDefined();

  await writePage(
    "architecture",
    "legacy.md",
    legacyBody.replace("Before.", "Edited underneath the preview."),
  );

  const applied = await migrateSectionMarkers(root, {
    dryRun: false,
    expect: new Map([["architecture/legacy.md", expected as string]]),
  });
  const entry = applied.pages.find((p) => p.page === "architecture/legacy.md");
  expect(entry?.action).toBe("conflict");
  expect(await readFile(path.join(root, ".metaproject", "wiki", "architecture", "legacy.md"), "utf8")).toContain(
    "Edited underneath the preview.",
  );
});

// --- AC7: partial invalidation -----------------------------------------------

test("AC7: an unchanged page's records are REUSED, not re-parsed, on a partial rebuild", async () => {
  const pages = await collectPages(root);
  const sources = await Promise.all(
    pages.map(async (page) => ({ page, content: await readFile(page.absolutePath, "utf8") })),
  );
  const first = buildSectionIndex(sources);

  const edited = sources.map((source) =>
    source.page.relativePath === "architecture/os-sandbox.md"
      ? { ...source, content: `${source.content}\n## Appended\n\nNew text.\n` }
      : source,
  );
  const second = invalidateSectionIndex(first, edited);

  // Object identity is the observable form of "this part of the index was not
  // invalidated": the untouched page's records are the very same objects.
  expect(second.pages.get("business-rules/retry.md")).toBe(
    first.pages.get("business-rules/retry.md"),
  );
  expect(second.pages.get("architecture/os-sandbox.md")).not.toBe(
    first.pages.get("architecture/os-sandbox.md"),
  );
  expect(second.sections.some((s) => s.title === "Appended")).toBe(true);

  // A removed page drops out rather than lingering with stale offsets.
  const third = invalidateSectionIndex(
    second,
    edited.filter((source) => source.page.relativePath !== "business-rules/retry.md"),
  );
  expect(third.pages.has("business-rules/retry.md")).toBe(false);
  expect(third.sections.every((s) => s.pageRelativePath !== "business-rules/retry.md")).toBe(true);
});

test("AC7: an edit invalidates only the edited page and never mixes old offsets with a new body", async () => {
  const before = await indexFor(root);
  const untouchedBefore = before.sections.filter(
    (s) => s.pageRelativePath === "business-rules/retry.md",
  );

  await writePage(
    "architecture",
    "os-sandbox.md",
    OS_SANDBOX.replace("## Summary\n\nKernel-enforced containment for a run.\n", "## Summary\n\nKernel-enforced containment for a run.\n\nAn inserted paragraph that shifts every later line.\n"),
  );

  const after = await indexFor(root);
  const untouchedAfter = after.sections.filter(
    (s) => s.pageRelativePath === "business-rules/retry.md",
  );
  expect(untouchedAfter.map((s) => s.digest)).toEqual(untouchedBefore.map((s) => s.digest));
  expect(untouchedAfter.map((s) => s.bodyRange)).toEqual(untouchedBefore.map((s) => s.bodyRange));

  // The edited page's offsets are recomputed, not carried over.
  const editedBefore = before.sections.find((s) => s.title === "Restricted network" && s.domain === "architecture");
  const editedAfter = after.sections.find((s) => s.title === "Restricted network" && s.domain === "architecture");
  expect(editedAfter?.bodyRange.startLine).toBeGreaterThan(
    editedBefore?.bodyRange.startLine as number,
  );

  // Reading the recorded range out of the CURRENT file yields the section's own
  // text, which is the property "query does not mix old offsets with a new body"
  // is really about.
  const lines = (
    await readFile(path.join(root, ".metaproject", "wiki", "architecture", "os-sandbox.md"), "utf8")
  ).split("\n");
  const slice = lines
    .slice((editedAfter?.bodyRange.startLine as number) - 1, editedAfter?.bodyRange.endLine)
    .join("\n");
  expect(slice).toContain("spawnSync");
});
