import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiCollect } from "./service";
import {
  hasCredential,
  isWikiEnrichIntent,
  planWikiEnrich,
  wikiEnrich,
  type ProviderFactory,
} from "./enrich";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";

const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

/** A ProviderPort that replays a fixed reply as one text_delta then model_end. */
function stubProvider(reply: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

/** Seed a temp workspace with two draft component pages via wikiCollect. */
async function seedDrafts(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-enrich-"));
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    jsonl([
      { id: "src/alpha/a.ts", kind: "file", path: "src/alpha/a.ts" },
      { id: "src/alpha/b.ts", kind: "file", path: "src/alpha/b.ts" },
      { id: "src/beta/a.ts", kind: "file", path: "src/beta/a.ts" },
      { id: "src/beta/b.ts", kind: "file", path: "src/beta/b.ts" },
    ]),
    "utf8",
  );
  await writeFile(path.join(graphDir, "edges.jsonl"), "", "utf8");
  await wikiCollect({ cwd: root });
  return root;
}

test("enrich rewrites every draft page with the model reply", async () => {
  const root = await seedDrafts();
  const factory: ProviderFactory = () => stubProvider("# Enriched\n\nFull prose body.");
  try {
    const result = await wikiEnrich({ cwd: root, providerFactory: factory });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBeGreaterThan(0);
    expect(result.pages.every((page) => page.action === "enriched")).toBe(true);

    const first = result.pages[0];
    expect(first).toBeDefined();
    const written = await readFile(path.join(root, ".metaproject", "wiki", first!.path), "utf8");
    expect(written).toContain("Full prose body.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run previews without writing", async () => {
  const root = await seedDrafts();
  const factory: ProviderFactory = () => stubProvider("# Draft preview\n\nWould be written.");
  try {
    const before = await readFile(
      path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"),
      "utf8",
    );
    const result = await wikiEnrich({ cwd: root, dryRun: true, providerFactory: factory });

    expect(result.dryRun).toBeGreaterThan(0);
    expect(result.enriched).toBe(0);
    expect(result.pages[0]?.preview).toContain("Would be written.");

    const after = await readFile(
      path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"),
      "utf8",
    );
    expect(after).toBe(before); // unchanged
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fail-closed: no credential and no injected factory skips every page", async () => {
  const root = await seedDrafts();
  try {
    const result = await wikiEnrich({ cwd: root, provider: "anthropic", env: {} });
    expect(result.credentialAvailable).toBe(false);
    expect(result.enriched).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.pages.every((page) => page.action === "skipped")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a provider_error marks the page failed, not written", async () => {
  const root = await seedDrafts();
  const erroring: ProviderFactory = () => ({
    describe: stubProvider("x").describe,
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield {
        kind: "provider_error",
        sequence: 0,
        attemptId: opts.attemptId,
        error: { kind: "rate_limit", retryable: true, message: "slow down" },
      };
    },
  });
  try {
    const result = await wikiEnrich({ cwd: root, providerFactory: erroring });
    expect(result.enriched).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.pages[0]?.reason).toContain("rate_limit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hasCredential: ollama always true, anthropic needs a key", () => {
  expect(hasCredential("ollama", {})).toBe(true);
  expect(hasCredential("anthropic", {})).toBe(false);
  expect(hasCredential("anthropic", { ANTHROPIC_API_KEY: "sk-x" })).toBe(true);
  expect(hasCredential("grok", { XAI_API_KEY: "xai-x" })).toBe(true);
  expect(hasCredential("grok", {})).toBe(false);
});

test("isWikiEnrichIntent matches RU/EN enrich requests", () => {
  expect(isWikiEnrichIntent("обогати вики через модель")).toBe(true);
  expect(isWikiEnrichIntent("Обогатить вики")).toBe(true);
  expect(isWikiEnrichIntent("enrich the wiki please")).toBe(true);
  expect(isWikiEnrichIntent("wiki enrich all drafts")).toBe(true);
  expect(isWikiEnrichIntent("что такое graph")).toBe(false);
});

test("force enrich includes accepted pages; default batch is drafts only", async () => {
  const root = await seedDrafts();
  const factory: ProviderFactory = () => stubProvider("# Enriched\n\nBody.");
  try {
    // Mark one page accepted.
    const acceptedPath = path.join(root, ".metaproject", "wiki", "components", "src-alpha.md");
    const raw = await readFile(acceptedPath, "utf8");
    await writeFile(acceptedPath, raw.replace(/status:\s*draft/i, "status: accepted"), "utf8");

    const plan = await planWikiEnrich(root);
    expect(plan.drafts.length).toBeGreaterThan(0);
    expect(plan.accepted.length).toBeGreaterThanOrEqual(1);

    const draftsOnly = await wikiEnrich({ cwd: root, providerFactory: factory });
    const forceAll = await wikiEnrich({ cwd: root, force: true, providerFactory: factory });

    expect(forceAll.enriched).toBeGreaterThan(draftsOnly.enriched);
    expect(forceAll.pages.some((p) => p.path.includes("src-alpha"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
