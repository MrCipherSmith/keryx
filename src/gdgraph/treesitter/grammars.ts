// Grammar WASM resolution via the Block 0 Asset Resolver (specification.md §8.1;
// T-B11, A-1..A-7). Grammar assets are pinned in `.metaproject/assets.lock.json`
// and resolved (sha256-verified on EVERY load) through `resolveAsset` — a
// tampered/missing grammar ⇒ `null` ⇒ the capability degrades to the regex
// fallback (AC1.6). This module NEVER touches the network and imports no optional
// dependency.

import path from "node:path";
import { loadAssetsLock, registryFromLock } from "../../assets/lock";
import { resolveAsset } from "../../assets/resolver";

export type GrammarLanguage = "typescript" | "tsx" | "javascript";

// The asset id for a language's grammar in `assets.lock.json`.
export function grammarAssetId(language: GrammarLanguage): string {
  return `tree-sitter-${language}`;
}

// Map an extractor language to its parsed-symbol language tag.
export function symbolLanguage(language: GrammarLanguage): "typescript" | "javascript" {
  return language === "javascript" ? "javascript" : "typescript";
}

export interface ResolvedGrammar {
  language: GrammarLanguage;
  path: string;
}

// Resolve a single grammar to a verified on-disk wasm path, or `null` when the
// asset is absent / fails checksum. `grammarsPath` (config T1) supplies an
// optional per-id user override directory of `tree-sitter-<lang>.wasm` files.
export async function resolveGrammar(
  cwd: string,
  language: GrammarLanguage,
  grammarsPath?: string | null,
): Promise<ResolvedGrammar | null> {
  const id = grammarAssetId(language);
  const lock = await loadAssetsLock(cwd);
  const overrides = grammarsPath
    ? { [id]: { path: path.join(grammarsPath, `${id}.wasm`) } }
    : undefined;
  const registry = registryFromLock(lock, overrides);
  const resolved = await resolveAsset(registry, id);
  if (!resolved) {
    return null;
  }
  return { language, path: resolved.path };
}

// Resolve every requested grammar that is available. Unavailable ones are
// skipped (not an error) — the adapter is available when at least one resolves.
export async function resolveGrammars(
  cwd: string,
  languages: GrammarLanguage[],
  grammarsPath?: string | null,
): Promise<ResolvedGrammar[]> {
  const resolved: ResolvedGrammar[] = [];
  for (const language of languages) {
    const grammar = await resolveGrammar(cwd, language, grammarsPath);
    if (grammar) {
      resolved.push(grammar);
    }
  }
  return resolved;
}

// Normalize config language strings to supported grammar languages.
export function toGrammarLanguages(languages: string[]): GrammarLanguage[] {
  const out: GrammarLanguage[] = [];
  for (const language of languages) {
    if (language === "typescript" || language === "tsx" || language === "javascript") {
      if (!out.includes(language)) {
        out.push(language);
      }
    }
  }
  return out;
}

// Choose the grammar for a source file path.
export function grammarForFile(file: string, available: GrammarLanguage[]): GrammarLanguage | null {
  const ext = path.extname(file);
  const preference: GrammarLanguage[] =
    ext === ".tsx"
      ? ["tsx", "typescript"]
      : ext === ".ts"
        ? ["typescript"]
        : ext === ".jsx" || ext === ".js" || ext === ".mjs" || ext === ".cjs"
          ? ["javascript"]
          : [];
  for (const language of preference) {
    if (available.includes(language)) {
      return language;
    }
  }
  return null;
}
