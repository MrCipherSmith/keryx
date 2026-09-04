// LWG-7 change classification (flow 226, phase 1).
//
// Answers, per changed file, *what kind* of change happened — because that is
// what decides whether documentation is in doubt. Today's mechanism is a
// sha256 over a module's top-6 files, which cannot tell a renamed export from
// a reflowed comment: both flip the hash, and only one of them can make a page
// wrong.
//
// Six classes, and the one that earns its keep is `cosmetic`: it must produce
// no work at all. Measured caveat, recorded rather than hidden — on this
// repository, filtering cosmetic changes out of a three-week backlog saved
// ZERO pages (`metrics-and-validation.md` §2.1), because over that span every
// module also received a substantive commit. The class pays off per commit,
// which is the granularity a hook works at, not per accumulated report.
//
// Signature detection reuses the tree-sitter symbol layer rather than adding a
// second parser: the adapter takes arbitrary `FileRecord`s, so the same
// extractor that builds `symbols.jsonl` can be run over a file's *previous*
// content and the two `{id, signature}` sets compared.
//
// DEGRADATION IS EXPLICIT. Without the symbol layer this module returns `body`
// for any substantive change and NEVER claims `signature` (flow 226 AC4). A
// guessed signature verdict would send a page to prose enrichment — the
// expensive path — on no evidence.

import type { FileRecord } from "../../gdgraph/treesitter/adapter";
import type { SymbolLayer } from "../../gdgraph/types";

export type ChangeClass = "added" | "removed" | "moved" | "signature" | "body" | "cosmetic";

export interface FileChange {
  path: string;
  /** Content at the base revision. `undefined` ⇒ the file is new. */
  before?: string | undefined;
  /** Content at head. `undefined` ⇒ the file was deleted. */
  after?: string | undefined;
  /** Set when the file was renamed; the path it had at the base revision. */
  previousPath?: string | undefined;
}

export interface ClassifiedChange {
  path: string;
  previousPath?: string | undefined;
  changeClass: ChangeClass;
  /** Exported symbols whose signature changed. Empty unless `signature`. */
  symbols: string[];
}

export interface ClassifyResult {
  changes: ClassifiedChange[];
  /**
   * False when no symbol extractor was available. The caller MUST surface this
   * as a `symbol-layer-unavailable` limitation: a report that silently
   * downgrades every signature change to `body` looks like a clean report.
   */
  symbolLayerAvailable: boolean;
}

/** Extracts symbols from arbitrary file contents; `null` ⇒ unavailable. */
export type SymbolExtractor = (files: FileRecord[]) => Promise<SymbolLayer>;

export async function classifyChanges(input: {
  changes: readonly FileChange[];
  extractSymbols?: SymbolExtractor | null;
}): Promise<ClassifyResult> {
  const extractor = input.extractSymbols ?? null;
  const out: ClassifiedChange[] = [];

  for (const change of input.changes) {
    out.push(await classifyOne(change, extractor));
  }

  return { changes: out, symbolLayerAvailable: extractor !== null };
}

async function classifyOne(
  change: FileChange,
  extractor: SymbolExtractor | null,
): Promise<ClassifiedChange> {
  const renamed = change.previousPath !== undefined && change.previousPath !== change.path;

  if (change.before === undefined) {
    return { path: change.path, changeClass: "added", symbols: [] };
  }
  if (change.after === undefined) {
    return { path: change.path, changeClass: "removed", symbols: [] };
  }

  const contentClass = await classifyContent(
    change.path,
    change.before,
    change.after,
    extractor,
  );

  if (!renamed) {
    return { path: change.path, changeClass: contentClass.changeClass, symbols: contentClass.symbols };
  }

  // A rename always matters — a `describes` edge points at the old path and
  // must be repointed. But a rename that ALSO changed a signature is the
  // stronger fact, and reporting only "moved" would lose it. So take whichever
  // is stronger: `moved` outranks `cosmetic`, and `signature` outranks both.
  const stronger = contentClass.changeClass === "signature" ? "signature" : "moved";
  return {
    path: change.path,
    previousPath: change.previousPath,
    changeClass: stronger,
    symbols: contentClass.symbols,
  };
}

async function classifyContent(
  path: string,
  before: string,
  after: string,
  extractor: SymbolExtractor | null,
): Promise<{ changeClass: ChangeClass; symbols: string[] }> {
  if (before === after) {
    return { changeClass: "cosmetic", symbols: [] };
  }
  if (normalizeSource(before, path) === normalizeSource(after, path)) {
    return { changeClass: "cosmetic", symbols: [] };
  }

  if (extractor === null) {
    // AC4: no extractor ⇒ never claim `signature`.
    return { changeClass: "body", symbols: [] };
  }

  try {
    const [beforeLayer, afterLayer] = await Promise.all([
      extractor([{ path, content: before }]),
      extractor([{ path, content: after }]),
    ]);
    const changed = changedSignatures(beforeLayer, afterLayer);
    if (changed.length > 0) {
      return { changeClass: "signature", symbols: changed };
    }
  } catch {
    // An extractor that throws is an extractor that told us nothing. Falling
    // through to `body` under-reports; inventing `signature` would over-report
    // onto the expensive path.
    return { changeClass: "body", symbols: [] };
  }

  return { changeClass: "body", symbols: [] };
}

/**
 * Names whose signature appeared, disappeared or changed. Compares the
 * rendered `signature` where the layer provides one, falling back to the
 * symbol's identity so an added or removed symbol still counts.
 */
export function changedSignatures(before: SymbolLayer, after: SymbolLayer): string[] {
  const index = (layer: SymbolLayer): Map<string, string> => {
    const map = new Map<string, string>();
    for (const symbol of layer.symbols) {
      // A symbol with no rendered signature contributes its identity, so its
      // appearance or removal is still visible; what it cannot do is make an
      // unchanged symbol look changed.
      map.set(symbol.id, symbol.signature ?? `${symbol.kind}:${symbol.name}`);
    }
    return map;
  };

  const from = index(before);
  const to = index(after);
  const changed = new Set<string>();

  for (const [id, signature] of to) {
    if (from.get(id) !== signature) {
      changed.add(nameOf(id));
    }
  }
  for (const id of from.keys()) {
    if (!to.has(id)) {
      changed.add(nameOf(id));
    }
  }
  return [...changed].sort();
}

function nameOf(symbolId: string): string {
  const hash = symbolId.indexOf("#");
  return hash >= 0 ? symbolId.slice(hash + 1) : symbolId;
}

/**
 * Strip comments and collapse insignificant whitespace so two sources that
 * differ only in formatting compare equal.
 *
 * CONSERVATIVE BY CONSTRUCTION. String and template literals are walked so a
 * `//` inside a URL is never mistaken for a comment, and an unterminated
 * literal aborts normalisation and returns the input unchanged. The failure
 * direction matters: returning the input makes a cosmetic change look
 * substantive, which costs a wasted backlog entry. The opposite error would
 * silently drop a real change, and no one would ever learn it happened.
 */
export function normalizeSource(source: string, path: string): string {
  const style = commentStyle(path);
  if (style === "none") {
    return source;
  }
  const stripped = style === "hash" ? stripHashComments(source) : stripCLikeComments(source);
  if (stripped === null) {
    return source;
  }
  return stripped.replace(/\s+/g, " ").trim();
}

type CommentStyle = "c-like" | "hash" | "none";

function commentStyle(path: string): CommentStyle {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|java)$/i.test(path)) {
    return "c-like";
  }
  if (/\.py$/i.test(path)) {
    return "hash";
  }
  return "none";
}

/** `null` ⇒ could not parse confidently; the caller keeps the original. */
function stripCLikeComments(source: string): string | null {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const literal = readLiteral(source, index, char);
      if (literal === null) return null;
      out += literal.text;
      index = literal.next;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function stripHashComments(source: string): string | null {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const literal = readLiteral(source, index, char);
      if (literal === null) return null;
      out += literal.text;
      index = literal.next;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function readLiteral(
  source: string,
  start: number,
  quote: string,
): { text: string; next: number } | null {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      return { text: source.slice(start, index + 1), next: index + 1 };
    }
    // A newline ends a single-quoted or double-quoted literal in every
    // language handled here; a template literal may legally span lines.
    if (char === "\n" && quote !== "`") {
      return null;
    }
    index += 1;
  }
  return null;
}
