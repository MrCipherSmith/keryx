import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPageAffinity,
  groupRelatedPages,
  parseGroupSize,
  parsePagesArgument,
  type GroupablePage,
} from "./page-groups";
import { clampConcurrency, MAX_CONCURRENCY, planEnrichGroups, wikiEnrich, type ProviderFactory } from "./enrich";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `count` pages in `clusters` link-connected chains, interleaved in path order. */
function clusteredPages(count: number, clusters: number): GroupablePage[] {
  const pages: GroupablePage[] = [];
  for (let i = 0; i < count; i += 1) {
    const cluster = i % clusters;
    const next = i + clusters;
    const link = next < count ? `[next](p${String(next).padStart(3, "0")}.md)` : "";
    pages.push({
      relativePath: `components/p${String(i).padStart(3, "0")}.md`,
      content: `# P${i}\n\nCluster ${cluster}. ${link.replace("(", "(./")}\n\nSee \`src/c${cluster}/mod.ts\`.\n`,
    });
  }
  return pages;
}

function assertPartition(groups: string[][], pages: readonly GroupablePage[], max: number): void {
  const flat = groups.flat();
  expect(flat.length).toBe(pages.length);
  expect(new Set(flat).size).toBe(pages.length);
  expect(new Set(flat)).toEqual(new Set(pages.map((p) => p.relativePath)));
  for (const group of groups) {
    expect(group.length).toBeGreaterThan(0);
    expect(group.length).toBeLessThanOrEqual(max);
  }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

test("every page lands in exactly one group, no group above max", () => {
  for (const count of [1, 9, 10, 21, 37, 100, 253]) {
    const pages = clusteredPages(count, 7);
    const groups = groupRelatedPages(pages, { min: 10, max: 20 });
    assertPartition(groups, pages, 20);
  }
});

test("groups respect min when there are at least min pages and the range leaves room", () => {
  for (const count of [10, 21, 37, 100, 253]) {
    const groups = groupRelatedPages(clusteredPages(count, 7), { min: 10, max: 20 });
    for (const group of groups) expect(group.length).toBeGreaterThanOrEqual(10);
  }
});

test("unrelated pages are still grouped within the size range", () => {
  const pages = Array.from({ length: 45 }, (_, i) => ({
    relativePath: `decisions/d${String(i).padStart(2, "0")}.md`,
    content: `# D${i}\n\nNo links.\n`,
  }));
  const groups = groupRelatedPages(pages, { min: 10, max: 20 });
  assertPartition(groups, pages, 20);
  expect(groups.map((g) => g.length)).toEqual([15, 15, 15]);
});

test("grouping is deterministic and independent of input order", () => {
  const pages = clusteredPages(80, 5);
  const a = groupRelatedPages(pages, { min: 10, max: 20 });
  const b = groupRelatedPages([...pages].reverse(), { min: 10, max: 20 });
  const c = groupRelatedPages(pages, { min: 10, max: 20 });
  expect(b).toEqual(a);
  expect(c).toEqual(a);
});

test("related pages end up together instead of in path order", () => {
  // 3 clusters of 12, interleaved by path: path-order chunking would mix them.
  const pages = clusteredPages(36, 3);
  const groups = groupRelatedPages(pages, { min: 10, max: 20 });
  expect(groups.length).toBe(3);
  for (const group of groups) {
    const clusters = new Set(group.map((p) => Number.parseInt(p.slice("components/p".length), 10) % 3));
    expect(clusters.size).toBe(1);
  }
});

test("a code file cited by very many pages is not an affinity signal", () => {
  const pages = Array.from({ length: 60 }, (_, i) => ({
    relativePath: `components/x${String(i).padStart(2, "0")}.md`,
    content: "Everything imports `src/lib/fs.ts`.\n",
  }));
  const affinity = buildPageAffinity(pages);
  for (const row of affinity.values()) expect(row.size).toBe(0);
});

test("a link and its backlink make a symmetric edge", () => {
  const affinity = buildPageAffinity([
    { relativePath: "architecture/a.md", content: "[b](../components/b.md)" },
    { relativePath: "components/b.md", content: "nothing" },
  ]);
  expect(affinity.get("architecture/a.md")!.get("components/b.md")).toBeGreaterThan(0);
  expect(affinity.get("components/b.md")!.get("architecture/a.md")).toBe(
    affinity.get("architecture/a.md")!.get("components/b.md"),
  );
});

test("an exact group size N gives groups of N with one smaller remainder at most", () => {
  const pages = clusteredPages(25, 25);
  const groups = groupRelatedPages(pages, { min: 10, max: 10 });
  assertPartition(groups, pages, 10);
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test("parseGroupSize accepts N and MIN-MAX and refuses the rest", () => {
  expect(parseGroupSize("10-20")).toEqual({ min: 10, max: 20 });
  expect(parseGroupSize("12")).toEqual({ min: 12, max: 12 });
  expect(() => parseGroupSize("20-10")).toThrow();
  expect(() => parseGroupSize("0")).toThrow();
  expect(() => parseGroupSize("ten")).toThrow();
  expect(() => parseGroupSize("10-500")).toThrow();
});

test("parsePagesArgument reads a list, a line file, or a JSON array file", () => {
  const none = (): string | null => null;
  expect(parsePagesArgument("a, b,a ,c.md", none)).toEqual(["a", "b", "c.md"]);
  expect(parsePagesArgument("list.txt", () => "x\n# comment\ny\n\n")).toEqual(["x", "y"]);
  expect(parsePagesArgument("list.json", () => '["p/q.md", "r"]')).toEqual(["p/q.md", "r"]);
  expect(() => parsePagesArgument("bad.json", () => "[1, 2]")).toThrow();
});

// ---------------------------------------------------------------------------
// Concurrency clamp
// ---------------------------------------------------------------------------

test("a concurrency above the cap is clamped and says so", () => {
  const over = clampConcurrency(MAX_CONCURRENCY + 4);
  expect(over.applied).toBe(MAX_CONCURRENCY);
  expect(over.clamped).toEqual({ requested: MAX_CONCURRENCY + 4, applied: MAX_CONCURRENCY, max: MAX_CONCURRENCY });
  expect(over.notice).toContain(`--concurrency ${MAX_CONCURRENCY + 4}`);
  expect(over.notice).toContain(`running ${MAX_CONCURRENCY}`);
});

test("a concurrency inside the range is not reported as clamped", () => {
  expect(clampConcurrency(10)).toEqual({ applied: 10 });
  expect(clampConcurrency(undefined)).toEqual({ applied: 1 });
  expect(clampConcurrency(0).clamped?.applied).toBe(1);
});

// ---------------------------------------------------------------------------
// wikiEnrich, grouped
// ---------------------------------------------------------------------------

function capturingProvider(reply: (request: string) => string, seen: string[]): ProviderFactory {
  return () =>
    ({
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
      async *stream(request: unknown, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        const text = JSON.stringify(request);
        seen.push(text);
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply(text) };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      },
    }) as ProviderPort;
}

function page(title: string, body: string): string {
  return `---\nTitle: ${title}\nVersion: 1.0.0\nType: decision\nStatus: draft\nSummary: About ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

async function seedWiki(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-page-groups-"));
  const dir = path.join(root, ".metaproject", "wiki", "decisions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "alpha.md"), page("Alpha", "Uses [Beta](beta.md). `src/a/x.ts`"), "utf8");
  await writeFile(path.join(dir, "beta.md"), page("Beta", "Stub. `src/a/x.ts`"), "utf8");
  await writeFile(path.join(dir, "gamma.md"), page("Gamma", "Stub. `src/g/y.ts`"), "utf8");
  await writeFile(path.join(dir, "delta.md"), page("Delta", "Uses [Gamma](gamma.md). `src/g/y.ts`"), "utf8");
  return root;
}

const reply = (text: string): string => {
  const title = /Title: (\w+)/.exec(text)?.[1] ?? "X";
  return page(title, "Full prose body with enough text for validation checks to pass cleanly.").replace(
    "Status: draft",
    "Status: accepted",
  );
};

test("a grouped run gives each worker a group and names the mates in every prompt", async () => {
  const root = await seedWiki();
  const seen: string[] = [];
  try {
    const result = await wikiEnrich({
      cwd: root,
      providerFactory: capturingProvider(reply, seen),
      validate: false,
      group: "related",
      groupSize: { min: 2, max: 2 },
      concurrency: 2,
      onPage: () => {},
    });
    expect(result.failed).toBe(0);
    expect(result.enriched).toBe(4);
    expect(result.groups).toEqual([
      ["decisions/alpha.md", "decisions/beta.md"],
      ["decisions/delta.md", "decisions/gamma.md"],
    ]);
    expect(seen.length).toBe(4);
    const alphaPrompt = seen.find((s) => s.includes("Title: Alpha"))!;
    expect(alphaPrompt).toContain("Related pages enriched in the same group");
    expect(alphaPrompt).toContain("[Beta](beta.md)");
    expect(alphaPrompt).not.toContain("[Gamma](gamma.md) —");
    // Status is never changed by enrich, even when the model returns accepted.
    const written = await readFile(path.join(root, ".metaproject", "wiki", "decisions", "alpha.md"), "utf8");
    expect(written).toMatch(/Status:\s*draft/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--pages enriches exactly those pages as one group and fails loudly on an unknown name", async () => {
  const root = await seedWiki();
  const seen: string[] = [];
  try {
    const result = await wikiEnrich({
      cwd: root,
      providerFactory: capturingProvider(reply, seen),
      validate: false,
      pages: ["alpha", "decisions/gamma.md", "no-such-page"],
      onPage: () => {},
    });
    expect(result.enriched).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.pages.find((p) => p.path === "no-such-page")?.reason).toContain("no wiki page matches");
    expect(result.groups).toEqual([["decisions/alpha.md", "decisions/gamma.md"]]);
    expect(seen.find((s) => s.includes("Title: Alpha"))).toContain("Gamma");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clamped run reports it in the result", async () => {
  const root = await seedWiki();
  try {
    const result = await wikiEnrich({
      cwd: root,
      providerFactory: capturingProvider(reply, []),
      validate: false,
      concurrency: MAX_CONCURRENCY + 1,
      onPage: () => {},
    });
    expect(result.concurrency).toBe(MAX_CONCURRENCY);
    expect(result.concurrencyClamped?.requested).toBe(MAX_CONCURRENCY + 1);
    expect(result.notices?.some((n) => n.includes("above the cap"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grouped run without a credential stays fail-closed", async () => {
  const root = await seedWiki();
  try {
    const result = await wikiEnrich({
      cwd: root,
      provider: "anthropic",
      env: {},
      group: "related",
      onPage: () => {},
    });
    expect(result.enriched).toBe(0);
    expect(result.skipped).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planEnrichGroups lists the groups without a provider", async () => {
  const root = await seedWiki();
  try {
    const groups = await planEnrichGroups({ cwd: root, groupSize: { min: 2, max: 2 } });
    expect(groups).toEqual([
      ["decisions/alpha.md", "decisions/beta.md"],
      ["decisions/delta.md", "decisions/gamma.md"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
