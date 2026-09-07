import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { collectContext } from "./context";

// AFC-25 / AC6: "Search -> compression -> handoff preserves the exact source
// fragment/version, author, and confirming participant together with a
// deferral caveat; an unknown source is explicitly visible; high confidence
// never promotes a hypothesis into a decision/permission." A previous task
// made the compression stage (report.ts) carry these fields, but the live
// "Related Memory" section in this file built its own ad hoc one-line
// markdown straight from scored entries, bypassing that formatter entirely --
// so nothing on the real handoff path ever showed them.

async function scaffold(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-flow-context-provenance-"));
  await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
  return root;
}

async function writeEntry(root: string, folder: string, name: string, content: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "memory", folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), content, "utf8");
}

const NOW = new Date("2026-08-10T00:00:00.000Z");

// Defect-3-scoped: a single fully-sourced entry is enough to show the "Related
// Memory" section renders through the provenance-preserving formatter (which
// carries version/provenance) instead of the old "- [status/type] title -
// path" one-liner that never rendered them at all.
test("AFC-25: Related Memory routes through the provenance-preserving report formatter", async () => {
  const root = await scaffold();
  try {
    await writeEntry(
      root,
      "decisions",
      "canary.md",
      `# Roll out canary deploys for the release pipeline

Version: 3.4.1
Type: decision
Status: accepted
Confidence: high

## Summary

Adopt canary deploys for the release pipeline.

## Provenance

- Source: pr#901
- Link: https://example.invalid/pr/901
- Created: 2026-06-01
- Updated: 2026-06-01
`,
    );
    const { markdown } = await collectContext({
      cwd: root,
      title: "release pipeline canary deploys",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: NOW,
    });
    expect(markdown).toContain("## Related Memory");
    expect(markdown).toContain("version: 3.4.1");
    expect(markdown).toContain("provenance: source=pr#901 link=https://example.invalid/pr/901");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The end-to-end proof of AC6 on the real path: a memory entry written to
// disk as Markdown, with a real source fragment/version, a named confirming
// participant, and a deferral caveat, driven through search -> compression ->
// the assembled flow context string. A second, unsourced entry must render
// the explicit "unknown" sentinel rather than a blank.
test("AFC-25/AC6: source fragment, version, confirming participant and caveat survive into the assembled handoff", async () => {
  const root = await scaffold();
  try {
    await writeEntry(
      root,
      "decisions",
      "canary.md",
      `# Roll out canary deploys for the release pipeline

Version: 3.4.1
Type: decision
Status: accepted
Confidence: high
Caveat: rollout deferred to Q3 pending security sign-off

## Summary

Adopt canary deploys for the release pipeline.

## Provenance

- Source: pr#901
- Link: https://example.invalid/pr/901
- Confirmed-By: reviewer:alice
- Created: 2026-06-01
- Updated: 2026-06-01

## Related Scopes

- Module: release-pipeline
`,
    );
    await writeEntry(
      root,
      "decisions",
      "trunk-based.md",
      `# Adopt trunk-based development for the release pipeline

Type: decision
Status: accepted
Confidence: high

## Summary

Adopt trunk-based development for the release pipeline.

## Provenance

- Created: 2026-06-01
- Updated: 2026-06-01

## Related Scopes

- Module: release-pipeline
`,
    );
    const { markdown } = await collectContext({
      cwd: root,
      title: "release pipeline decisions",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: NOW,
    });

    // Sourced entry: exact source fragment/version, confirming participant,
    // and caveat all survive verbatim into the handoff text.
    expect(markdown).toContain("Roll out canary deploys for the release pipeline");
    expect(markdown).toContain("decisions/canary.md");
    expect(markdown).toContain("version: 3.4.1");
    expect(markdown).toContain("provenance: source=pr#901 link=https://example.invalid/pr/901 author=unknown confirmedBy=reviewer:alice");
    expect(markdown).toContain("caveat: rollout deferred to Q3 pending security sign-off");

    // Unsourced entry: explicit "unknown" sentinel, never a blank/dropped field.
    expect(markdown).toContain("Adopt trunk-based development for the release pipeline");
    expect(markdown).toContain("decisions/trunk-based.md");
    expect(markdown).toContain("version: unknown");
    expect(markdown).toContain("provenance: source=unknown link=unknown author=unknown confirmedBy=unknown");

    console.log("--- assembled handoff markdown (AFC-25/AC6 end-to-end) ---\n" + markdown);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// T20 finding 4 (flow 234 review, MAJOR): the "Related Memory" section used
// to splice in the FULL report markdown, which opens with its own `#`
// heading (nested inside this section's `##`), a `runId` for a run this
// pure/no-write call never persisted to disk, a `generatedAt` timestamp
// byte-identical to the one the outer context markdown already states three
// lines above, and a `query:` line restating the flow title again. Only a
// model ever reads this document, and none of that preamble carries
// information it doesn't already have. The result payload (claimType,
// version, provenance, confirmedBy, caveat) must still be present.
test("T20 finding 4: Related Memory has no nested heading, no fabricated runId, no duplicate timestamp, and no restated query", async () => {
  const root = await scaffold();
  try {
    await writeEntry(
      root,
      "decisions",
      "canary.md",
      `# Roll out canary deploys for the release pipeline

Version: 3.4.1
Type: decision
Status: accepted
Confidence: high

## Summary

Adopt canary deploys for the release pipeline.

## Provenance

- Source: pr#901
- Link: https://example.invalid/pr/901
- Created: 2026-06-01
- Updated: 2026-06-01
`,
    );
    const { markdown } = await collectContext({
      cwd: root,
      title: "release pipeline canary deploys",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: NOW,
    });

    // The payload must still be there.
    expect(markdown).toContain("## Related Memory");
    expect(markdown).toContain("version: 3.4.1");
    expect(markdown).toContain("provenance: source=pr#901 link=https://example.invalid/pr/901");

    // The preamble must be gone: no nested `# memory search report: ...`
    // heading, no fabricated runId, no restated query, and `generatedAt:`
    // must not appear a second time (it already appears once in the outer
    // "Collected deterministically ... at <timestamp>." line).
    expect(markdown).not.toContain("# memory search report:");
    expect(markdown).not.toContain("runId:");
    expect(markdown).not.toContain("flow-context-related-memory");
    expect(markdown).not.toContain("query: release pipeline canary deploys");
    const generatedAtOccurrences = markdown.split("generatedAt:").length - 1;
    expect(generatedAtOccurrences).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The negative half of AC6: high confidence must never promote a hypothesis
// into a decision or confer any permission. claimType is carried verbatim
// from the entry's own type -- never derived from score/confidence.
test("AFC-25/AC6: a high-confidence hypothesis still reads as a hypothesis and confers no permission", async () => {
  const root = await scaffold();
  try {
    await writeEntry(
      root,
      "decisions",
      "hypothesis.md",
      `# Release pipeline legacy endpoint may bypass rate limiting

Type: hypothesis
Status: accepted
Confidence: high

## Summary

Hypothesis: the release pipeline's legacy endpoint may not enforce the new rate limiter. Unconfirmed.

## Provenance

- Source: manual
- Created: 2026-06-01
- Updated: 2026-06-01

## Related Scopes

- Module: release-pipeline
`,
    );
    const { markdown } = await collectContext({
      cwd: root,
      title: "release pipeline decisions",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: NOW,
    });
    expect(markdown).toContain("claimType: hypothesis");
    expect(markdown).not.toContain("claimType: decision");
    expect(markdown.toLowerCase()).not.toContain("permission");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
