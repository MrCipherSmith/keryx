import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectContext } from "./context";
import { renderProceduralBlock } from "../memory/inject";
import type { MemoryEntry } from "../memory/types";

test("P3: procedural prompt rendering bounds title, summary, and path", () => {
  const block = renderProceduralBlock([
    {
      absolutePath: "/tmp/secret.md",
      relativePath: `patterns/${"p".repeat(1_000)}.md`,
      type: "pattern",
      title: "T".repeat(1_000),
      version: null,
      status: "accepted",
      confidence: "high",
      summary: "S".repeat(2_000),
      details: "must not render",
      tags: [],
      scopes: { module: null, entity: null, files: [], skills: [] },
      created: null,
      updated: null,
      provenance: { source: null, link: null },
    } satisfies MemoryEntry,
  ]);
  expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(1_100);
  expect(block).not.toContain("must not render");
});

// AC-C8: accepted/current/procedural memory in the task scope is rendered into
// the assembled flow prompt via proceduralMemoryForScope + renderProceduralBlock;
// an empty scope leaves the prompt unchanged (no procedural block).

function patternMd(): string {
  return `# Retry with exponential backoff

Version: 1.0.0
Type: pattern
Status: accepted
Confidence: high

## Summary

Wrap outbound HTTP calls with exponential backoff and jitter on retry.

## Details

Procedural guidance.

## Related Scopes

- Module: http

## Tags

- retry
- backoff
`;
}

async function scaffold(withProcedural: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-flow-inject-"));
  const dir = path.join(root, ".metaproject", "memory", "patterns");
  await mkdir(dir, { recursive: true });
  if (withProcedural) {
    await writeFile(path.join(dir, "retry-backoff.md"), patternMd(), "utf8");
  }
  return root;
}

test("procedural memory in scope is injected into the assembled prompt (AC-C8)", async () => {
  const root = await scaffold(true);
  try {
    const { markdown } = await collectContext({
      cwd: root,
      title: "Add retry backoff to the HTTP client",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: new Date("2026-07-08"),
    });
    expect(markdown).toContain("## Procedural Memory");
    expect(markdown).toContain("Retry with exponential backoff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty scope leaves the prompt unchanged (no procedural block)", async () => {
  const root = await scaffold(false);
  try {
    const { markdown } = await collectContext({
      cwd: root,
      title: "Unrelated task about billing invoices",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: new Date("2026-07-08"),
    });
    expect(markdown).not.toContain("## Procedural Memory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
