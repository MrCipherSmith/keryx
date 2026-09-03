import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiCollect } from "./service";
import {
  ensureWikiFrontmatter,
  hasCredential,
  hasYamlFrontmatter,
  isWikiEnrichIntent,
  loadResumeState,
  planWikiEnrich,
  repairEnrichedFrontmatter,
  resumeStatePath,
  saveResumeState,
  validateEnrichedMarkdown,
  wikiEnrich,
  type ProviderFactory,
  type ResumeState,
} from "./enrich";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import { guardOutput as defaultGuardOutput } from "../security/guard";

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

test("enrich rewrites every draft page with the model reply", async () => {
  const root = await seedDrafts();
  const factory: ProviderFactory = () => stubProvider(GOOD_PAGE);
  try {
    const result = await wikiEnrich({ cwd: root, providerFactory: factory, validate: false });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBeGreaterThan(0);
    expect(result.pages.every((page) => page.action === "enriched")).toBe(true);

    const first = result.pages[0];
    expect(first).toBeDefined();
    const written = await readFile(path.join(root, ".metaproject", "wiki", first!.path), "utf8");
    expect(written).toContain("Full prose body");
    // Flow 194 / issue #391: `wiki enrich` rewrites prose only — it must
    // never itself promote a page's Status. These pages started as
    // `Status: draft` (seeded by wikiCollect); enrich must leave them draft,
    // not silently land `Status: accepted` with zero SAC review.
    expect(written).toMatch(/Status:\s*draft/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flow 219: abort stops the pool before another page starts and fences post-abort writes", async () => {
  const root = await seedDrafts();
  const controller = new AbortController();
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let calls = 0;
  const factory: ProviderFactory = () => ({
    describe: stubProvider(GOOD_PAGE).describe,
    stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      calls += 1;
      if (calls === 1) markFirstStarted();
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        await firstMayFinish;
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: GOOD_PAGE };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })();
    },
  });

  const run = wikiEnrich({
    cwd: root,
    providerFactory: factory,
    concurrency: 1,
    validate: false,
    signal: controller.signal,
  } as Parameters<typeof wikiEnrich>[0]);

  try {
    await firstStarted;
    controller.abort("user interrupted wiki enrich");
  } finally {
    releaseFirst();
  }

  const result = await run;
  try {
    // The provider can ignore abort. The scheduler and persistence boundary
    // still must not accept its late result or dequeue a second page.
    expect(calls).toBe(1);
    expect(result.enriched).toBe(0);
    expect(result.failed).toBe(0);
    expect((result as typeof result & { cancelled?: number }).cancelled).toBe(result.pages.length);
    for (const relativePath of ["components/src-alpha.md", "components/src-beta.md"]) {
      const content = await readFile(path.join(root, ".metaproject", "wiki", relativePath), "utf8");
      expect(content).not.toContain("Full prose body");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("flow 219: a non-RLM abort during page preparation starts no provider turn", async () => {
  const root = await seedDrafts();
  const controller = new AbortController();
  let calls = 0;
  const providerFactory: ProviderFactory = () => ({
    describe: stubProvider(GOOD_PAGE).describe,
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      calls += 1;
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: GOOD_PAGE };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  });
  try {
    const result = await wikiEnrich({
      cwd: root,
      providerFactory,
      signal: controller.signal,
      validate: false,
      onPage: (info) => {
        if (info.phase === "start") controller.abort("cancel during page preparation");
      },
    });

    expect(calls).toBe(0);
    expect(result.pages.every((page) => page.action === "cancelled")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("flow 219: a non-RLM abort during output guarding persists no late page", async () => {
  const root = await seedDrafts();
  const controller = new AbortController();
  let releaseGuard!: () => void;
  const guardMayFinish = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  let markGuardStarted!: () => void;
  const guardStarted = new Promise<void>((resolve) => {
    markGuardStarted = resolve;
  });
  try {
    const run = wikiEnrich({
      cwd: root,
      providerFactory: () => stubProvider(GOOD_PAGE),
      signal: controller.signal,
      validate: false,
      guardOutput: async (input) => {
        markGuardStarted();
        await guardMayFinish;
        return defaultGuardOutput(input);
      },
    });
    await guardStarted;
    controller.abort("cancel during output guarding");
    releaseGuard();

    const result = await run;
    const page = result.pages[0];
    expect(page?.action).toBe("cancelled");
    const content = await readFile(path.join(root, ".metaproject", "wiki", page!.path), "utf8");
    expect(content).not.toContain("Full prose body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flow 219: natural-language wiki enrichment remains picker-eligible but explicit CLI syntax is not hijacked", () => {
  expect(isWikiEnrichIntent("please enrich the wiki with the model")).toBe(true);
  expect(
    isWikiEnrichIntent(
      "keryx wiki enrich --page components/src-alpha.md --limit 2 --resume --dry-run --concurrency 1 --provider openai --model gpt-test --force",
    ),
  ).toBe(false);
});

test("flow 194 / issue #391 regression: enrich never lands Status: accepted on a draft page, even when the model's own reply claims accepted", async () => {
  const root = await seedDrafts();
  // Reproduces the original repro's shape (`wiki new` + `wiki enrich
  // --prompt`): a model turn that itself returns `Status: accepted` in its
  // frontmatter — the exact vector a compromised/prompt-injected turn (or,
  // pre-fix, the CLI's own default `markAccepted`) used to bypass SAC review
  // entirely. The write path must force Status back to what it was before
  // this run, regardless of what the model claims and regardless of any
  // flags passed.
  const modelClaimsAccepted = `---
Title: Enriched
Version: 1.0.0
Type: component
Status: accepted
Summary: Test page
---

# Enriched

Full prose body with enough text for validation checks to pass cleanly.
`;
  const factory: ProviderFactory = () => stubProvider(modelClaimsAccepted);
  try {
    // Single page, `validate: false` — same pattern the "rewrites every draft
    // page" test above uses for this same `seedDrafts()` fixture (its
    // generated draft body is long enough that a short stub reply trips the
    // unrelated truncation-size check under `validate: true`). This test is
    // about the Status-forcing behavior, not structural validation.
    const result = await wikiEnrich({
      cwd: root,
      page: "components/src-alpha.md",
      providerFactory: factory,
      validate: false,
    });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(1);

    const written = await readFile(
      path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"),
      "utf8",
    );
    expect(written).toContain("Full prose body");
    expect(written).toMatch(/Status:\s*draft/i);
    expect(written).not.toMatch(/Status:\s*accepted/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run previews without writing", async () => {
  const root = await seedDrafts();
  const factory: ProviderFactory = () => stubProvider(GOOD_PAGE);
  try {
    const before = await readFile(
      path.join(root, ".metaproject", "wiki", "components", "src-alpha.md"),
      "utf8",
    );
    const result = await wikiEnrich({ cwd: root, dryRun: true, providerFactory: factory });

    expect(result.dryRun).toBeGreaterThan(0);
    expect(result.enriched).toBe(0);
    expect(result.pages[0]?.preview).toContain("Full prose body");

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
  const factory: ProviderFactory = () => stubProvider(GOOD_PAGE);
  try {
    // Mark one page accepted.
    const acceptedPath = path.join(root, ".metaproject", "wiki", "components", "src-alpha.md");
    const raw = await readFile(acceptedPath, "utf8");
    await writeFile(acceptedPath, raw.replace(/Status:\s*draft/i, "Status: accepted"), "utf8");

    const plan = await planWikiEnrich(root);
    expect(plan.drafts.length).toBeGreaterThan(0);
    expect(plan.accepted.length).toBeGreaterThanOrEqual(1);

    const draftsOnly = await wikiEnrich({ cwd: root, providerFactory: factory, validate: false });
    // Re-seed remaining drafts as draft again for force comparison
    const forceAll = await wikiEnrich({
      cwd: root,
      force: true,
      providerFactory: factory,
      validate: false,
    });

    expect(forceAll.pages.some((p) => p.path.includes("src-alpha"))).toBe(true);
    expect(forceAll.enriched + forceAll.failed + forceAll.skipped).toBeGreaterThanOrEqual(
      draftsOnly.enriched,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateEnrichedMarkdown rejects missing frontmatter", () => {
  expect(validateEnrichedMarkdown("x".repeat(100), "no frontmatter here")).toMatch(/frontmatter/i);
  expect(validateEnrichedMarkdown("x".repeat(100), GOOD_PAGE)).toBeNull();
});

test("ensureWikiFrontmatter synthesizes YAML from legacy H1 + pseudo-meta (os-sandbox style)", () => {
  const legacy = `# OS Sandbox

Version: 1.0.0
Type: architecture
Status: accepted

## Summary

The OS sandbox is a kernel-enforced containment layer under the policy engine.
It constrains what a process can write and reach after it starts.

## Details

More prose here so the body is substantial enough for enrich validation.
`;
  expect(hasYamlFrontmatter(legacy)).toBe(false);
  const { markdown, normalized } = ensureWikiFrontmatter(legacy, { pageType: "architecture" });
  expect(normalized).toBe(true);
  expect(markdown.startsWith("---")).toBe(true);
  expect(markdown).toMatch(/Title:\s*OS Sandbox/);
  expect(markdown).toMatch(/Status:\s*accepted/);
  expect(markdown).toMatch(/Type:\s*architecture/);
  expect(markdown).toContain("# OS Sandbox");
  expect(markdown).toContain("kernel-enforced containment");
  // Idempotent when already normalized.
  const again = ensureWikiFrontmatter(markdown);
  expect(again.normalized).toBe(false);
  expect(again.markdown.startsWith("---")).toBe(true);
  expect(validateEnrichedMarkdown(markdown, markdown)).toBeNull();
});

test("ensureWikiFrontmatter is a no-op for pages that already have YAML frontmatter", () => {
  const { markdown, normalized } = ensureWikiFrontmatter(GOOD_PAGE);
  expect(normalized).toBe(false);
  expect(markdown).toBe(GOOD_PAGE);
});

test("repairEnrichedFrontmatter re-attaches original FM when model returns body-only", () => {
  const original = ensureWikiFrontmatter(`# Module src/commands

Version: 1.0.0
Type: component
Status: accepted

## Summary

CLI command layer of keryx with enough body text for validation checks.
`).markdown;
  const bodyOnly = `# Module src/commands

Enriched prose about the CLI command layer with enough length to pass
body-length validation after frontmatter is re-attached by repair.
`;
  expect(hasYamlFrontmatter(bodyOnly)).toBe(false);
  const repaired = repairEnrichedFrontmatter(original, bodyOnly);
  expect(repaired.startsWith("---")).toBe(true);
  expect(repaired).toMatch(/Title:/);
  expect(repaired).toContain("Enriched prose about the CLI");
  expect(validateEnrichedMarkdown(original, repaired)).toBeNull();
});

test("enrich accepts legacy page when model omits frontmatter (pre-normalize + repair)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-enrich-legacy-"));
  try {
    const wikiDir = path.join(root, ".metaproject", "wiki", "architecture");
    await mkdir(wikiDir, { recursive: true });
    const legacy = `# OS Sandbox

Version: 1.0.0
Type: architecture
Status: accepted

## Summary

Legacy stub without YAML fences. Enough text for the collect/enrich pipeline.
`;
    await writeFile(path.join(wikiDir, "os-sandbox.md"), legacy, "utf8");

    // Model returns body without frontmatter — repair must save the run.
    const bodyOnly = `# OS Sandbox

The OS sandbox is kernel-enforced containment under the policy engine.
Workspace-write and network-off are the default harness posture.
This prose is long enough to pass structural validation after repair.
`;
    const factory: ProviderFactory = () => stubProvider(bodyOnly);
    const result = await wikiEnrich({
      cwd: root,
      page: "architecture/os-sandbox",
      providerFactory: factory,
      validate: true,
    });

    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(1);
    const written = await readFile(path.join(wikiDir, "os-sandbox.md"), "utf8");
    expect(written.startsWith("---")).toBe(true);
    expect(written).toMatch(/Status:\s*accepted/i);
    expect(written).toContain("kernel-enforced containment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mapPool runs with concurrency > 1", async () => {
  const { mapPool } = await import("./enrich");
  const seen: number[] = [];
  const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
    seen.push(n);
    return n * 2;
  });
  expect(out).toEqual([2, 4, 6, 8]);
  expect(seen.sort()).toEqual([1, 2, 3, 4]);
});

test("T5/resume state — round-trips completedNodeHashes through save + load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-resume-"));
  try {
    const state: ResumeState = {
      updatedAt: new Date().toISOString(),
      provider: "anthropic",
      model: "claude",
      completed: ["components/alpha.md"],
      completedNodeHashes: { "components/alpha.md": "abc123" },
      failed: [],
    };
    saveResumeState(root, state);

    const loaded = loadResumeState(root);
    expect(loaded.completed).toEqual(["components/alpha.md"]);
    expect(loaded.completedNodeHashes).toEqual({ "components/alpha.md": "abc123" });

    const onDisk = JSON.parse(await readFile(resumeStatePath(root), "utf8"));
    expect(onDisk.completedNodeHashes).toEqual({ "components/alpha.md": "abc123" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T5/resume state — backward compat: old JSON without completedNodeHashes loads fine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-resume-"));
  try {
    const file = resumeStatePath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        completed: ["components/alpha.md"],
        failed: [],
      }),
      "utf8",
    );

    const loaded = loadResumeState(root);
    expect(loaded.completed).toEqual(["components/alpha.md"]);
    expect(loaded.completedNodeHashes).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T5/resume state — malformed completedNodeHashes (non-string values) degrades to absent, never throws", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-resume-"));
  try {
    const file = resumeStatePath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        completed: [],
        completedNodeHashes: { "components/alpha.md": 12345 },
        failed: [],
      }),
      "utf8",
    );

    const loaded = loadResumeState(root);
    expect(loaded.completedNodeHashes).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
