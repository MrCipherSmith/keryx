import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

// Seed the tree-sitter grammar assets into a project's `assets.lock.json` so the
// gdgraph symbol layer works out of the box: `keryx gdgraph symbols enable` then
// `keryx gdgraph assets pull` can fetch + verify real grammars. These are real,
// publicly-hosted, sha-pinned wasm builds (tree-sitter-wasms on jsDelivr), ABI
// 14 — compatible with web-tree-sitter 0.22.
//
// Merge-safe: only ADDS missing grammar entries. Existing entries (user re-pins,
// model-asset placeholders) are preserved untouched.

interface AssetEntry {
  version: string;
  url: string;
  sha256: string;
  size: number;
}

export const GRAMMAR_ASSETS: Record<string, AssetEntry> = {
  "tree-sitter-typescript": {
    version: "0.1.13",
    url: "https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-typescript.wasm",
    sha256: "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
    size: 2342690,
  },
  "tree-sitter-tsx": {
    version: "0.1.13",
    url: "https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-tsx.wasm",
    sha256: "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
    size: 2411272,
  },
  "tree-sitter-javascript": {
    version: "0.1.13",
    url: "https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-javascript.wasm",
    sha256: "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
    size: 647334,
  },
  "tree-sitter-java": {
    version: "0.1.13",
    url: "https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-java.wasm",
    sha256: "637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f",
    size: 430239,
  },
  "tree-sitter-python": {
    version: "0.1.13",
    url: "https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/tree-sitter-python.wasm",
    sha256: "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
    size: 476105,
  },
};

interface LockShape {
  schemaVersion?: number;
  assets?: Record<string, unknown>;
}

// Compute the merged lock (pure) — adds any missing grammar entry, preserves the
// rest. Returns `{ lock, changed }` so callers can skip a no-op write.
export function mergeGrammarAssets(existing: LockShape): { lock: LockShape; changed: boolean } {
  const lock: LockShape = {
    schemaVersion: typeof existing.schemaVersion === "number" ? existing.schemaVersion : 1,
    assets: { ...(existing.assets ?? {}) },
  };
  let changed = existing.schemaVersion === undefined || existing.assets === undefined;
  for (const [id, entry] of Object.entries(GRAMMAR_ASSETS)) {
    if (!lock.assets![id]) {
      lock.assets![id] = entry;
      changed = true;
    }
  }
  return { lock, changed };
}

// Ensure `<metaprojectRoot>/assets.lock.json` carries the grammar pins. Never
// throws on a malformed existing file — it is treated as empty and reseeded.
export async function seedAssetsLock(metaprojectRoot: string): Promise<void> {
  const file = path.join(metaprojectRoot, "assets.lock.json");
  let existing: LockShape = {};
  const present = await pathExists(file);
  if (present) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as LockShape;
      }
    } catch {
      // Malformed lock ⇒ reseed from scratch.
    }
  }

  const { lock, changed } = mergeGrammarAssets(existing);
  if (changed || !present) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
}
