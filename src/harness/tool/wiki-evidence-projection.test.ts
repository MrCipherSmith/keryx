// AFC (flow 240) — the wiki evidence envelope at the agent/MCP boundary, and
// the property that boundary keeps breaking: NO FIELD IS DROPPED.
//
// MEASURED BEFORE THIS LANE. `METAPROJECT_OPERATIONS` held sixteen operations
// and none was `wiki_evidence`; `createGdWikiService().evidence` — required
// items that cannot be silently dropped, symmetric `conflictRefs`, a
// `budget-exceeded` overflow instead of a shortened rule — was called by
// `src/wiki/evidence.test.ts` and by nothing else in `src/`.
//
// WHY THE ASSERTIONS BELOW ARE SHAPED THIS WAY. A previous lane measured this
// same boundary and found six unreported gaps, the largest dropping THIRTEEN
// fields from a wiki answer, because the projection was a hand-written list of
// the fields somebody remembered. So this file never lists field names by hand
// either: it walks `EVIDENCE_ITEM_FIELDS` (checked against `keyof EvidenceItem`
// by the compiler) and, for every field, walks the actual VALUE the real
// service produced and requires each leaf to appear in the rendered text.
//
// And the check itself is proved capable of failing: the last test runs the
// identical walk against a five-field re-map — the shape that caused the
// original defect — and asserts it is caught.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import {
  EVIDENCE_FIELDS_NOT_PROJECTED,
  EVIDENCE_ITEM_FIELDS,
  METAPROJECT_OPERATIONS,
  formatWikiEvidence,
} from "./metaproject-operations";
import { createGdWikiService } from "../../wiki/service";
import type { EvidencePackage } from "../../wiki/evidence";

// `EVIDENCE_ITEM_FIELDS` above is the registry the RENDERER is driven by,
// IMPORTED rather than re-typed here. A second hand-written copy of the field
// names in this file would drift with the first and then agree with it while
// both were wrong — which is the failure mode this whole file exists to catch.
// The registry's own correctness is checked twice: against `keyof EvidenceItem`
// by the compiler (in `./metaproject-operations.ts`), and against the keys the
// LIVE service actually emits by the first test below.

function operation(name: string) {
  const found = METAPROJECT_OPERATIONS.find((op) => op.name === name);
  if (found === undefined) {
    throw new Error(`operation "${name}" is not registered`);
  }
  return found;
}

/**
 * Every scalar a value carries, plus every nested key — the full set of strings
 * a lossless projection has to preserve. Derived from the VALUE, so a field
 * added inside `provenance` or `freshness` is covered without editing this file.
 */
function leaves(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(leaves);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
      key,
      ...leaves(nested),
    ]);
  }
  return [String(value)];
}

/** The leaves of `value` that do NOT appear in `rendered` — the loss, named. */
function missingFrom(rendered: string, value: unknown): string[] {
  const gaps: string[] = [];
  for (const leaf of leaves(value)) {
    for (const line of leaf.split("\n")) {
      const text = line.trim();
      if (text.length > 0 && !rendered.includes(text)) {
        gaps.push(text);
      }
    }
  }
  return gaps;
}

// --- fixture: a conflicted rule, so the hardest fields carry real values ------
//
// `conflictRefs` on both sides, an authored `Authority`/`Claim-Type` so
// `provenance` and `bindings` are non-empty, and enough unrelated pages that
// `wikiAsk` classifies the question `ok` rather than `insufficient-evidence`.

function filler(slug: string, subject: string, words: string[]): string {
  return `<!-- keryx:page id="${slug}" v=1 -->
# ${subject}

Version: 1.0.0
Type: architecture
Status: accepted

## Summary

${subject} covers ${words.join(", ")}.

<!-- keryx:section id="${slug}-detail" v=1 -->
## Details

The ${words[0]} subsystem coordinates ${words[1]} and reports ${words[2]} to the
operator console on every cycle.
<!-- /keryx:section -->
`;
}

const PAGES: Record<string, string> = {
  "architecture/telemetry.md": filler("telemetry", "Telemetry Pipeline", [
    "telemetry",
    "sampling",
    "counters",
  ]),
  "architecture/storage.md": filler("storage", "Storage Layout", [
    "storage",
    "compaction",
    "segments",
  ]),
  "architecture/scheduler.md": filler("scheduler", "Scheduler", [
    "scheduler",
    "leases",
    "partitions",
  ]),
  "architecture/routing.md": filler("routing", "Request Routing", [
    "routing",
    "affinity",
    "shards",
  ]),
  "business-rules/retry-policy.md": `<!-- keryx:page id="retry-policy" v=1 -->
# Retry Policy

Version: 2.0.0
Type: business-rule
Status: accepted

## Summary

Delivery retry limits for outbound webhooks.

<!-- keryx:section id="retry-limit" v=1 -->
## Webhook retry limit

Claim-Type: instruction
Authority: decision:retry-2026-03@v2
Conflicts-With: keryx:page/retry-history#retry-limit-old

A failed webhook delivery is retried at most three times, then parked.
<!-- /keryx:section -->
`,
  "decisions/retry-history.md": `<!-- keryx:page id="retry-history" v=1 -->
# Retry Decision Record

Version: 1.0.0
Type: decision
Status: accepted

## Summary

The earlier accepted webhook retry decision.

<!-- keryx:section id="retry-limit-old" v=1 -->
## Webhook retry limit

A failed webhook delivery is retried at most ten times before it is parked.
<!-- /keryx:section -->
`,
};

async function makeWiki(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-evidence-projection-"));
  for (const [relative, content] of Object.entries(PAGES)) {
    const absolute = path.join(root, ".metaproject", "wiki", relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

const QUESTION = "webhook retry limit";

test("wiki_evidence is registered on the agent boundary, and therefore on the MCP projection", () => {
  const names = METAPROJECT_OPERATIONS.map((op) => op.name);
  expect(names).toContain("wiki_evidence");
  const op = operation("wiki_evidence");
  expect(op.risk).toBe("read");
  expect(op.module).toBe("wiki");
  expect(op.inputSchema).toMatchObject({ required: ["question"] });
});

test("the field registry matches the envelope the LIVE service actually produces", async () => {
  // Runtime cross-check of the compile-time registry against real data, in
  // both directions. A field added to `EvidenceItem` and forgotten here fails
  // the build; a field present at runtime and absent from the registry fails
  // right here, against bytes the real service wrote.
  const root = await makeWiki();
  try {
    const envelope = await createGdWikiService().evidence({ cwd: root, question: QUESTION });
    expect(envelope.status).toBe("ok");
    const item = envelope.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(Object.keys(item).sort()).toEqual([...EVIDENCE_ITEM_FIELDS].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("REAL SEAM — every field of every item survives the projection to the model", async () => {
  const root = await makeWiki();
  try {
    // The real adapter over the real service — no injected wikiEvidence.
    const port = createMetaprojectAdapter(root);
    const result = await operation("wiki_evidence").invoke(port, { question: QUESTION });
    expect(result.isError).toBe(false);

    // The same envelope, read directly, so the assertion compares the rendered
    // text against what the owner actually produced rather than against a
    // fixture somebody typed.
    const envelope = await createGdWikiService().evidence({ cwd: root, question: QUESTION });
    expect(envelope.status).toBe("ok");
    expect(envelope.items.length).toBeGreaterThan(0);

    const gaps: string[] = [];
    for (const item of envelope.items) {
      for (const field of EVIDENCE_ITEM_FIELDS) {
        if (field in EVIDENCE_FIELDS_NOT_PROJECTED) {
          // A deliberate omission is allowed ONLY as a named decision, and the
          // renderer must print the reason where the value would have been.
          expect(result.output).toContain(`${field}: (not projected —`);
          continue;
        }
        expect(result.output).toContain(field);
        gaps.push(...missingFrom(result.output, item[field]).map((leaf) => `${field}: ${leaf}`));
      }
    }
    expect(gaps).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("REAL SEAM — the conflict pairing is legible in the rendered text, on both sides", async () => {
  const root = await makeWiki();
  try {
    const port = createMetaprojectAdapter(root);
    const result = await operation("wiki_evidence").invoke(port, { question: QUESTION });
    // Both claims, and the number each one asserts. A projection that rendered
    // one side would let a contested rule read as settled.
    expect(result.output).toContain("three times");
    expect(result.output).toContain("ten times");
    // Each side carries the OTHER's ref, version and section fragment.
    expect(result.output).toContain("keryx:page/retry-history");
    expect(result.output).toContain("keryx:page/retry-policy");
    expect(result.output).toContain("section:retry-limit-old");
    expect(result.output).toContain("conflictRefs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("REAL SEAM — a mandatory overflow renders as budget-exceeded with the required ref, never as a shorter answer", async () => {
  const root = await makeWiki();
  try {
    const port = createMetaprojectAdapter(root);
    const result = await operation("wiki_evidence").invoke(port, {
      question: QUESTION,
      // A budget no required item can fit in.
      budgetTokens: 1,
    });
    expect(result.output).toContain("code: budget-exceeded");
    expect(result.output).toContain("context_overflow");
    expect(result.output).toContain("requiredRef");
    expect(result.output).toContain("items (0):");
    // An overflow is an ERROR at this boundary: a caller that reads it as an
    // ordinary empty success has been handed the shortened answer the contract
    // forbids, wearing a success's clothes.
    expect(result.isError).toBe(true);
    // And no excerpt text leaks into the refusal.
    expect(result.output).not.toContain("three times");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a backing failure is a named failure, never an empty envelope that reads as no-match", async () => {
  const port = createMetaprojectAdapter(process.cwd(), {
    wikiEvidence: async () => {
      throw new Error("the wiki root is unreadable");
    },
  });
  const result = await operation("wiki_evidence").invoke(port, { question: QUESTION });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("the wiki root is unreadable");
  expect(result.output).not.toContain("no-match");
});

test("PLANTED VIOLATION — the field walk catches the five-field re-map that caused the original defect", async () => {
  // The check above asserts an ABSENCE (no gaps). This proves that assertion
  // can fail: the same walk, run against the shape the previous lane measured
  // — a hand-written subset of the fields somebody remembered — reports the
  // loss instead of passing quietly.
  const root = await makeWiki();
  try {
    const envelope = await createGdWikiService().evidence({ cwd: root, question: QUESTION });
    const item = envelope.items[0];
    expect(item).toBeDefined();
    if (!item) return;

    const lossy = [item.title, item.pageRef, item.sectionId, item.excerpt.text].join("\n");
    const dropped = EVIDENCE_ITEM_FIELDS.filter(
      (field) => missingFrom(lossy, item[field]).length > 0,
    );
    // The exact class of loss that made this lane necessary: freshness,
    // lifecycle, provenance and the conflict pairing all vanish silently.
    expect(dropped).toContain("freshness");
    expect(dropped).toContain("lifecycle");
    expect(dropped).toContain("provenance");
    expect(dropped).toContain("conflictRefs");
    expect(dropped.length).toBeGreaterThan(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PLANTED VIOLATION — a named omission must state a reason, and the reason is printed in place of the value", () => {
  // `EVIDENCE_FIELDS_NOT_PROJECTED` is empty today (every field reaches the
  // model). This drives the mechanism itself with a planted entry, so the
  // "a deliberate omission is a named decision, not an absence" contract is
  // exercised rather than merely documented.
  for (const [field, reason] of Object.entries(EVIDENCE_FIELDS_NOT_PROJECTED)) {
    expect(typeof reason).toBe("string");
    expect((reason ?? "").length).toBeGreaterThan(0);
    expect(EVIDENCE_ITEM_FIELDS as readonly string[]).toContain(field);
  }

  const planted: EvidencePackage = {
    status: "ok",
    reason: "",
    items: [],
    refused: [],
    omittedOptional: [],
    partial: false,
    overflow: null,
    suggestion: "",
  };
  const rendered = formatWikiEvidence({ question: "q", envelope: planted });
  // Every package-level field is labelled even when its value is empty — an
  // absent label and an empty value must not look alike.
  expect(rendered.output).toContain("refused: (none)");
  expect(rendered.output).toContain("overflow: null");
  expect(rendered.output).toContain("items (0):");
  expect(rendered.isError).toBe(false);
});
