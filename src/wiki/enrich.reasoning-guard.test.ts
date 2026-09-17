// flow 268 T18 — guard test: wiki enrich must never write a page built from
// reasoning text (AC12). `flow 268 T9`'s tests already cover an in-band
// `<think>` block embedded in the TEXT the model returned; this file covers
// the separate, EVENT-based reasoning channel (`reasoning_delta`) added by
// flow 268 T11 — `runModelTurn` (already pinned reasoning-clean by
// `../harness/provider/single-turn.reasoning-guard.test.ts`) is the only
// thing standing between a reasoning-capable provider and the page
// `wikiEnrich` writes, so this exercises that seam end-to-end through the
// real `wikiEnrich` entry point.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiCollect } from "./service";
import { wikiEnrich, type ProviderFactory } from "./enrich";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";

const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

const REASONING_MARKER = "REASONING-MARKER-268";

/** A ProviderPort that emits reasoning (carrying the marker) before its answer. */
function reasoningProvider(answerText: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: true,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub-reasoning" },
      };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield {
        kind: "reasoning_delta",
        sequence: 0,
        attemptId: opts.attemptId,
        text: `${REASONING_MARKER} let me think about how to phrase this wiki page...`,
      };
      yield { kind: "text_delta", sequence: 1, attemptId: opts.attemptId, text: answerText };
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
}

/** Seed a temp workspace with two draft component pages via wikiCollect. */
async function seedDrafts(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-enrich-reasoning-guard-"));
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl([
      { id: "src/alpha/a.ts", kind: "file", path: "src/alpha/a.ts" },
      { id: "src/alpha/b.ts", kind: "file", path: "src/alpha/b.ts" },
    ]),
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");
  await wikiCollect({ cwd: root });
  return root;
}

const GOOD_PAGE = `---
Title: Enriched
Version: 1.0.0
Type: component
Status: draft
Summary: Test page
---

# Enriched

Full prose body with enough text for validation checks to pass cleanly.
`;

test("flow 268 T18: wiki enrich never writes a page containing the model's reasoning-event text (AC12)", async () => {
  const root = await seedDrafts();
  const factory: ProviderFactory = () => reasoningProvider(GOOD_PAGE);
  try {
    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha",
      providerFactory: factory,
      validate: false,
    });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(1);
    const written = await readFile(
      path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"),
      "utf8",
    );
    expect(written).not.toContain(REASONING_MARKER);
    expect(written).toContain("Full prose body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
