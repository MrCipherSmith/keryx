import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { computeDedupHint } from "./decision-dedup";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "./workspace-service";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-decision-dedup-"));
}

async function createWorkspace(cwd: string, id: string, component?: string): Promise<void> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  await service.create({
    request: undefined,
    requestCorrelationId: randomUUID(),
    id,
    title: "test workspace",
    ...(component ? { component: { kind: "component" as const, uri: component } } : {}),
  });
}

/** Writes a real proposal record + evidence file, mirroring what `create()`
 * durably writes — `computeDedupHint` reads these through the same
 * `readVerifiedProposalEvidence` seam the real owner-writers use. */
async function writeProposalWithEvidence(
  cwd: string,
  workspaceId: string,
  proposalId: string,
  kind: "wiki-update" | "memory-entry",
  evidenceMarkdown: string,
): Promise<void> {
  const proposalsDir = path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals");
  await mkdir(proposalsDir, { recursive: true });
  const evidenceUri = `./.metaproject/workspaces/${workspaceId}/proposals/${proposalId}.evidence.md`;
  await writeFile(path.join(cwd, evidenceUri.slice(2)), evidenceMarkdown, "utf8");
  const revision = createHash("sha256").update(evidenceMarkdown).digest("hex");
  const record = {
    id: proposalId,
    workspaceId,
    kind,
    evidence: [{ kind: "wrap-up", uri: evidenceUri, revision, observedAt: "2026-08-17T00:00:00.000Z" }],
  };
  await writeFile(path.join(proposalsDir, `${proposalId}.json`), JSON.stringify(record), "utf8");
}

async function writeMemoryEntry(cwd: string, relativePath: string, opts: { title: string; type: string; status: string; summary: string; module?: string; tags?: string[] }): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "memory", path.dirname(relativePath));
  await mkdir(dir, { recursive: true });
  const content = `# ${opts.title}

Version: 0.1.0
Type: ${opts.type}
Status: ${opts.status}
Confidence: medium

## Summary

${opts.summary}

## Details

Details.

## Provenance

- Source: test
- Link:
- Created: 2026-08-17
- Updated: 2026-08-17

## Related Scopes

- Module: ${opts.module ?? ""}
- Entity:
- Files:
- Skills:

## Tags

${(opts.tags ?? []).map((t) => `- ${t}`).join("\n")}

## Changelog

- 0.1.0 - test fixture.
`;
  await writeFile(path.join(cwd, ".metaproject", "memory", relativePath), content, "utf8");
}

async function writeWikiDecisionPage(cwd: string, filename: string, opts: { title: string; status: string; summary: string; module?: string }): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "wiki", "decisions");
  await mkdir(dir, { recursive: true });
  const content = `# ${opts.title}

Version: 0.1.0
Type: decision
Status: ${opts.status}
${opts.module ? `Module: ${opts.module}\n` : ""}
## Summary

${opts.summary}

## Details

Details.
`;
  await writeFile(path.join(dir, filename), content, "utf8");
}

const DESCRIPTION: ProviderDescription = {
  capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false },
  descriptor: { providerId: "stub" },
};

function stubModelProvider(text: string): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: (_req, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })(),
  };
}

function unreachableModelProvider(): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: () => {
      throw new Error("model turn should never run when the hint is empty");
    },
  };
}

test("AC1: a memory-entry proposal with a near-identical title to an existing accepted entry produces a duplicate hint", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeMemoryEntry(cwd, "task-notes/existing.md", { title: "Use adapters for the pipeline", type: "task-note", status: "accepted", summary: "We decided to use adapters." });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-a", "memory-entry", "# Use adapters for the pipeline\n\n## Summary\n\nWe decided to use adapters.\n");

  const result = await computeDedupHint({ cwd, workspaceId: "workspace-a", proposalId: "proposal-a", kind: "memory-entry", annotate: false });
  expect(result).toBeDefined();
  expect(result?.hint.duplicates).toHaveLength(1);
  expect(result?.hint.duplicates[0]?.path).toBe("task-notes/existing.md");
});

test("AC1: a wiki-update proposal with a near-identical title to an existing decision page produces a duplicate hint", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeWikiDecisionPage(cwd, "sac-existing.md", { title: "SAC: Adopt the new caching layer", status: "accepted", summary: "We decided to adopt caching." });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-b", "wiki-update", "# Adopt the new caching layer\n\n## Summary\n\nWe decided to adopt caching.\n");

  const result = await computeDedupHint({ cwd, workspaceId: "workspace-a", proposalId: "proposal-b", kind: "wiki-update", annotate: false });
  expect(result).toBeDefined();
  expect(result?.hint.duplicates).toHaveLength(1);
  expect(result?.hint.duplicates[0]?.path).toBe("decisions/sac-existing.md");
});

test("a genuinely unrelated proposal produces an empty hint", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeMemoryEntry(cwd, "task-notes/existing.md", { title: "Use adapters for the pipeline", type: "task-note", status: "accepted", summary: "We decided to use adapters." });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-c", "memory-entry", "# A completely different topic about something else entirely\n\n## Summary\n\nNothing to do with the other one.\n");

  const result = await computeDedupHint({ cwd, workspaceId: "workspace-a", proposalId: "proposal-c", kind: "memory-entry", annotate: false });
  expect(result).toEqual({ hint: { duplicates: [], conflicts: [] } });
});

test("a conflict fires when the candidate and an existing accepted decision share the workspace's bound component (module scope)", async () => {
  const cwd = await tempCwd();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "pipeline.ts"), "export {};\n", "utf8");
  await createWorkspace(cwd, "workspace-a", "./src/pipeline.ts");
  await writeWikiDecisionPage(cwd, "sac-existing.md", { title: "SAC: Always retry on failure", status: "accepted", summary: "Pipeline retries automatically.", module: "./src/pipeline.ts" });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-d", "wiki-update", "# Never retry on failure\n\n## Summary\n\nA totally different, contradicting stance.\n");

  const result = await computeDedupHint({ cwd, workspaceId: "workspace-a", proposalId: "proposal-d", kind: "wiki-update", annotate: false });
  // The candidate's derived module (from the workspace's own bound
  // component) matches the existing accepted decision's module — this is
  // what makes AC4-class conflict detection possible at all for SAC content,
  // whose tags/other scopes are otherwise always empty on both sides.
  expect(result?.hint.conflicts.length).toBeGreaterThan(0);
});

test("an unreadable/missing proposal degrades to undefined, never throws", async () => {
  const cwd = await tempCwd();
  const result = await computeDedupHint({ cwd, workspaceId: "workspace-a", proposalId: "no-such-proposal", kind: "memory-entry", annotate: false });
  expect(result).toBeUndefined();
});

test("FR2: the model is never invoked when the hint is empty (nothing to judge)", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-e", "memory-entry", "# Something brand new\n\n## Summary\n\nNo existing entries to compare against.\n");

  const result = await computeDedupHint({ cwd, workspaceId: "workspace-a", proposalId: "proposal-e", kind: "memory-entry", providerFactory: () => unreachableModelProvider() });
  expect(result).toEqual({ hint: { duplicates: [], conflicts: [] } });
});

test("FR2: a bounded model call annotates a non-empty hint, and the annotation is informational only (never consulted by the caller)", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeMemoryEntry(cwd, "task-notes/existing.md", { title: "Use adapters for the pipeline", type: "task-note", status: "accepted", summary: "We decided to use adapters." });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-f", "memory-entry", "# Use adapters for the pipeline\n\n## Summary\n\nWe decided to use adapters.\n");

  const result = await computeDedupHint({
    cwd,
    workspaceId: "workspace-a",
    proposalId: "proposal-f",
    kind: "memory-entry",
    providerFactory: () => stubModelProvider("duplicate-of task-notes/existing.md"),
  });
  expect(result?.annotation).toEqual({ verdict: "duplicate-of", ref: "task-notes/existing.md" });
});

test("FR2: a hallucinated ref not present in the hint's own candidates is never accepted as an annotation", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeMemoryEntry(cwd, "task-notes/existing.md", { title: "Use adapters for the pipeline", type: "task-note", status: "accepted", summary: "We decided to use adapters." });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-g", "memory-entry", "# Use adapters for the pipeline\n\n## Summary\n\nWe decided to use adapters.\n");

  const result = await computeDedupHint({
    cwd,
    workspaceId: "workspace-a",
    proposalId: "proposal-g",
    kind: "memory-entry",
    providerFactory: () => stubModelProvider("duplicate-of task-notes/made-up-path.md"),
  });
  expect(result?.annotation).toBeUndefined();
  expect(result?.hint.duplicates).toHaveLength(1);
});

test("FR2: a hung model call times out and the hint is still returned without an annotation", async () => {
  const cwd = await tempCwd();
  await createWorkspace(cwd, "workspace-a");
  await writeMemoryEntry(cwd, "task-notes/existing.md", { title: "Use adapters for the pipeline", type: "task-note", status: "accepted", summary: "We decided to use adapters." });
  await writeProposalWithEvidence(cwd, "workspace-a", "proposal-h", "memory-entry", "# Use adapters for the pipeline\n\n## Summary\n\nWe decided to use adapters.\n");

  const result = await computeDedupHint({
    cwd,
    workspaceId: "workspace-a",
    proposalId: "proposal-h",
    kind: "memory-entry",
    providerFactory: () => ({
      describe: () => DESCRIPTION,
      stream: () => (async function* (): AsyncGenerator<NormalizedEvent> { await new Promise(() => {}); })(),
    }),
    annotationTimeoutMs: 100,
  });
  expect(result?.hint.duplicates).toHaveLength(1);
  expect(result?.annotation).toBeUndefined();
});
