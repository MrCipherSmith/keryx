import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../../lib/fs";
import { resolveCapability } from "../../capability/seam";
import { hasWarned, resetWarnOnce } from "../../capability/warn-once";
import { DEFAULT_MEMORY_CONFIG as C } from "../config";
import { candidatePool, searchEntries } from "../search";
import { createMemoryService } from "../service";
import { collectEntries } from "../store";
import {
  MEMORY_EMBEDDING_ID,
  deterministicEmbedder,
  makeEmbeddingSpec,
} from "./adapter";
import { buildEmbeddingIndex, embeddingsDir, rerankByEmbedding } from "./index";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "paraphrase",
);
const MODEL_ASSET = "memory-embed-default";

let root: string;
let previousCache: string | undefined;

beforeEach(async () => {
  resetWarnOnce();
  root = await mkdtemp(path.join(tmpdir(), "gd-mem-embed-"));
  previousCache = process.env.GD_METAPRO_ASSET_CACHE;
  process.env.GD_METAPRO_ASSET_CACHE = path.join(root, ".cache", "gd-metapro", "assets");
});

afterEach(async () => {
  if (previousCache === undefined) {
    delete process.env.GD_METAPRO_ASSET_CACHE;
  } else {
    process.env.GD_METAPRO_ASSET_CACHE = previousCache;
  }
  await rm(root, { recursive: true, force: true });
});

// Copy the committed paraphrase fixture's memory tree into the temp workspace so
// writes (artifacts, embeddings) never dirty the committed fixture.
async function seedMemory(): Promise<void> {
  await cp(
    path.join(FIXTURE, ".metaproject", "memory"),
    path.join(root, ".metaproject", "memory"),
    { recursive: true },
  );
}

async function writeManifest(capabilityEnabled: boolean): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        memory: {
          enabled: true,
          capabilities: [{ id: MEMORY_EMBEDDING_ID, enabled: capabilityEnabled, kind: "ceiling" }],
        },
      },
    }),
    "utf8",
  );
}

async function writeConfig(index: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "memory.config.json"),
    JSON.stringify({ index }),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// AC-C1 — lexical default unchanged when embeddings OFF (byte-identical) +
// behavioral import-spy via the warn-once proxy.
// ---------------------------------------------------------------------------

test("AC-C1: default search is byte-identical and never consults the embedding seam", async () => {
  await seedMemory();
  // Capability enabled in the manifest, but index.enabled stays false (default)
  // and no --semantic ⇒ the seam must never be reached (no runtime import).
  await writeManifest(true);
  const service = createMemoryService();

  const query = "how should the service retry failed outbound network requests";
  const first = await service.search({ cwd: root, query });
  const latestMd = path.join(root, ".metaproject", "data", "memory", "artifacts", "latest.md");
  const mdA = await readFile(latestMd, "utf8");
  const second = await service.search({ cwd: root, query });
  const mdB = await readFile(latestMd, "utf8");

  // Byte-identical Markdown across runs.
  expect(mdB).toBe(mdA);
  // Ordering/scores identical to a direct lexical searchEntries call.
  const entries = await collectEntries(root);
  const direct = searchEntries(entries, query, {}, C, new Date());
  expect(first.results.map((r) => r.entry.relativePath)).toEqual(
    direct.map((r) => r.entry.relativePath),
  );
  expect(second.results.map((r) => r.score)).toEqual(direct.map((r) => r.score));

  // No embedding index was created and the seam was never consulted (no import).
  expect(await pathExists(embeddingsDir(root))).toBe(false);
  expect(hasWarned(MEMORY_EMBEDDING_ID)).toBe(false);
});

// ---------------------------------------------------------------------------
// AC-C4 — enabled but backend/asset absent ⇒ one warning, lexical result, exit 0.
// ---------------------------------------------------------------------------

test("AC-C4: --semantic with unresolved asset degrades to lexical (warn once, exit 0)", async () => {
  await seedMemory();
  await writeManifest(true);
  // Point the runtime at an always-importable module but leave the model asset
  // unresolved (no assets.lock / no cached file) ⇒ capability degrades.
  await writeConfig({ enabled: true, runtime: "node:util", modelAssetId: MODEL_ASSET });
  const service = createMemoryService();

  const query = "how should the service retry failed outbound network requests";
  const result = await service.search({ cwd: root, query });

  // Same result as pure lexical (fallback), and the seam warned exactly once.
  const entries = await collectEntries(root);
  const lexical = searchEntries(entries, query, {}, C, new Date());
  expect(result.results.map((r) => r.entry.relativePath)).toEqual(
    lexical.map((r) => r.entry.relativePath),
  );
  expect(hasWarned(MEMORY_EMBEDDING_ID)).toBe(true);
});

// ---------------------------------------------------------------------------
// AC-C4 — availability true via the real seam (dep present + asset verified) →
// the adapter runs and returns vectors. Mirrors capability/reference.test.ts.
// ---------------------------------------------------------------------------

async function writeVerifiedAsset(): Promise<void> {
  const bytes = "memory-embed-model-fixture\n";
  const cacheDir = path.join(root, ".cache", "gd-metapro", "assets");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, MODEL_ASSET), bytes, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "assets.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: {
        [MODEL_ASSET]: {
          version: "1.0.0",
          url: "https://assets.gd-metapro.dev/memory/fixture",
          sha256,
          size: Buffer.byteLength(bytes),
        },
      },
    }),
    "utf8",
  );
}

test("AC-C4: availability-true — dep present + asset verified → adapter embeds", async () => {
  await writeManifest(true);
  await writeVerifiedAsset();

  const spec = makeEmbeddingSpec({
    optionalDependency: "node:util",
    asset: MODEL_ASSET,
    embedder: deterministicEmbedder(),
  });
  const adapter = await resolveCapability(root, spec);
  expect(adapter).not.toBeNull();

  const vectors = await adapter!.run({ texts: ["retry failed requests", "unrelated text"] });
  expect(vectors.length).toBe(2);
  expect(vectors[0]?.length).toBeGreaterThan(0);
});

test("AC-C4: availability-false — capability disabled → null (no warning, no import)", async () => {
  await writeManifest(false);
  await writeVerifiedAsset();
  const spec = makeEmbeddingSpec({
    optionalDependency: "node:util",
    asset: MODEL_ASSET,
    embedder: deterministicEmbedder(),
  });
  const adapter = await resolveCapability(root, spec);
  expect(adapter).toBeNull();
  // A disabled ceiling is the normal default path — no degradation warning.
  expect(hasWarned(MEMORY_EMBEDDING_ID)).toBe(false);
});

// ---------------------------------------------------------------------------
// AC-C2 — embeddings improve recall@k on the paraphrase fixture.
// ---------------------------------------------------------------------------

test("AC-C2: recall@k(index) > recall@k(lexical) on the paraphrase fixture", async () => {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE, "manifest.json"), "utf8")) as {
    k: number;
    cases: Array<{ id: string; query: string; expected: string }>;
  };
  const entries = await collectEntries(FIXTURE);
  const now = new Date("2026-07-08");
  const embed = deterministicEmbedder();
  const k = manifest.k;

  let lexHits = 0;
  let idxHits = 0;
  for (const testCase of manifest.cases) {
    const lexical = searchEntries(entries, testCase.query, {}, C, now)
      .slice(0, k)
      .map((r) => r.entry.relativePath);
    const pool = candidatePool(entries, testCase.query, {}, C, now, C.index.k);
    const reranked = (await rerankByEmbedding(testCase.query, pool, embed, null))
      .slice(0, k)
      .map((r) => r.entry.relativePath);
    if (lexical.includes(testCase.expected)) {
      lexHits += 1;
    }
    if (reranked.includes(testCase.expected)) {
      idxHits += 1;
    }
  }
  const total = manifest.cases.length;
  const lexicalRecall = lexHits / total;
  const indexRecall = idxHits / total;
  expect(indexRecall).toBeGreaterThan(lexicalRecall);
  expect(indexRecall).toBe(1);
});

// ---------------------------------------------------------------------------
// AC-C3 — index is derived, disposable, deterministic; store never mutated.
// ---------------------------------------------------------------------------

test("AC-C3: delete→rebuild yields byte-identical vectors and rankings", async () => {
  await seedMemory();
  const entries = await collectEntries(root);
  const embed = deterministicEmbedder();
  const now = new Date("2026-07-08");

  await buildEmbeddingIndex(root, entries, embed, "stub", now);
  const vectorsPath = path.join(embeddingsDir(root), "vectors.jsonl");
  const firstBytes = await readFile(vectorsPath, "utf8");

  // Delete the whole derived index and rebuild.
  await rm(embeddingsDir(root), { recursive: true, force: true });
  expect(await pathExists(vectorsPath)).toBe(false);
  const rebuilt = await buildEmbeddingIndex(root, entries, embed, "stub", now);
  const secondBytes = await readFile(vectorsPath, "utf8");

  expect(secondBytes).toBe(firstBytes);
  expect(rebuilt.meta.entryCount).toBe(entries.length);

  // Rankings identical after rebuild.
  const query = "how should the service retry failed outbound network requests";
  const pool = candidatePool(entries, query, {}, C, now, C.index.k);
  const a = (await rerankByEmbedding(query, pool, embed, rebuilt)).map((r) => r.entry.relativePath);
  const b = (await rerankByEmbedding(query, pool, embed, rebuilt)).map((r) => r.entry.relativePath);
  expect(a).toEqual(b);
});

test("AC-C3/AC-C11: search + index(--embeddings) never mutate the Markdown store", async () => {
  await seedMemory();
  await writeManifest(true);

  const memRoot = path.join(root, ".metaproject", "memory");
  const snapshot = await snapshotDir(memRoot);

  const service = createMemoryService();
  const query = "how should the service retry failed outbound network requests";
  await service.search({ cwd: root, query }); // default
  await service.search({ cwd: root, query, filters: { semantic: true } }); // semantic (degrades)
  await service.index({ cwd: root, embeddings: true }); // build index (stub unavailable ⇒ lexical only)

  const after = await snapshotDir(memRoot);
  expect(after).toEqual(snapshot);
  // Any embedding artifacts live strictly under data/, never under memory/.
  expect(snapshot.every((p) => p.path.startsWith("memory/"))).toBe(true);
});

async function snapshotDir(dir: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, `${rel}/`);
      } else {
        out.push({ path: rel, content: await readFile(full, "utf8") });
      }
    }
  }
  await walk(dir, "memory/");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ---------------------------------------------------------------------------
// End-to-end: service.search reranks through the real seam when a deterministic
// runtime + verified asset resolve (proves the C1 wiring, offline).
// ---------------------------------------------------------------------------

test("service.search reranks via the seam when a deterministic runtime resolves", async () => {
  await seedMemory();
  await writeManifest(true);
  await writeVerifiedAsset();

  // A tiny local module that mimics the transformers feature-extraction API,
  // producing the same deterministic bag-of-token vectors as the stub embedder.
  const adapterPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "adapter.ts",
  );
  const runtimePath = path.join(root, "stub-runtime.ts");
  await writeFile(
    runtimePath,
    `import { deterministicEmbed } from ${JSON.stringify(adapterPath)};
export async function pipeline() {
  return async (text) => ({ data: Array.from(deterministicEmbed(text, 96)) });
}
`,
    "utf8",
  );
  await writeConfig({ enabled: true, runtime: runtimePath, modelAssetId: MODEL_ASSET });

  const service = createMemoryService();
  const query = "how should the service retry failed outbound network requests";
  const result = await service.search({ cwd: root, query, filters: { semantic: true, limit: 1 } });

  // Semantic rerank surfaces the paraphrase match that lexical ranks below a
  // higher-boost distractor.
  expect(result.results[0]?.entry.relativePath).toBe("patterns/retry-backoff.md");
  const lexicalTop = searchEntries(await collectEntries(root), query, {}, C, new Date())[0];
  expect(lexicalTop?.entry.relativePath).not.toBe("patterns/retry-backoff.md");
});
