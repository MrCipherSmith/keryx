import { test, expect } from "bun:test";
import { renderProceduralBlock } from "./inject";
import type { MemoryEntry } from "./types";

function proceduralEntry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "patterns/x.md",
    type: "pattern",
    title: "retry with backoff",
    version: "1.0.0",
    status: "accepted",
    confidence: "high",
    summary: "wrap outbound calls with exponential backoff",
    details: "",
    tags: [],
    scopes: { module: null, entity: null, files: [], skills: [] },
    created: null,
    updated: null,
    provenance: { source: null, link: null },
    ...over,
  };
}

// AFC-25 / AC6: the handoff (renderProceduralBlock, spliced verbatim into the
// task-implementer/flow prompt by src/flow/context.ts) carries the caveat
// attached to an accepted entry as evidence alongside the "follow it"
// instruction, instead of flattening the entry into a bare, unqualified
// assertion the reader has no way to know is deferred/qualified.
test("AFC-25: handoff block surfaces a caveat instead of flattening evidence into a bare assertion", () => {
  const deferred = proceduralEntry({
    relativePath: "patterns/deferred.md",
    caveat: "rollout deferred pending security sign-off",
  });
  const block = renderProceduralBlock([deferred]);
  expect(block).toContain("rollout deferred pending security sign-off");
});

// A caveat-free entry renders exactly as before (no phantom "unknown" noise
// injected into every line of an agent prompt for the common case).
test("AFC-25: an entry without a caveat renders unchanged", () => {
  const plain = proceduralEntry({ relativePath: "patterns/plain.md" });
  const block = renderProceduralBlock([plain]);
  expect(block).not.toContain("caveat");
});
