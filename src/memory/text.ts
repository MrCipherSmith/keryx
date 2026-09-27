export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length >= 2);
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * A small, deterministic English suffix stripper — NOT a full Porter
 * stemmer, and not meant to be one. Flow 353 AC5: `keryx memory search`'s
 * lexical mode treats "release" and "released"/"releases" as the same
 * term. Scoped to a handful of common suffixes for the short, mostly
 * technical vocabulary memory entries actually carry, rather than a general
 * algorithm whose false positives (Porter's own well-known ones) are a
 * worse failure mode here than under-stemming a rare word.
 *
 * The trailing-"e" drop after suffix removal is what makes "release" (no
 * suffix to strip) and "released"/"releases" (suffix stripped, then a
 * bare trailing "e" left behind — the "e" English orthography elides
 * before adding "-ed"/"-ing"/"-es") converge on the SAME stem ("releas")
 * instead of two different ones. It is a known, accepted source of
 * over-stemming for short unrelated words that happen to end in "e"
 * (e.g. "note"/"not") — acceptable because this only widens a lexical
 * SCORE, never a filter: nothing that would not otherwise match is
 * suddenly required to.
 *
 * Only used inside `search.ts`'s scoring, not on the base
 * `tokenize`/`tokenSet` above — `dedup.ts`'s title/summary similarity and
 * `relevant.ts`'s scope matching stay on exact tokens, unaffected.
 */
export function stem(token: string): string {
  let base = token;
  if (base.length >= 6 && base.endsWith("ies")) {
    base = `${base.slice(0, -3)}y`;
  } else {
    for (const suffix of ["ing", "edly", "ed", "es", "s"]) {
      if (base.length - suffix.length >= 3 && base.endsWith(suffix)) {
        base = base.slice(0, base.length - suffix.length);
        break;
      }
    }
  }
  if (base.length >= 4 && base.endsWith("e")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}
