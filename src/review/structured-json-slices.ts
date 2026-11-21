import { readPinnedReviewBlob, safeSourcePath } from "./pinned-source";
import { reviewDiffBlobPairs, type ScopedRegion } from "./scope";
import { ledgerOmissions, type SliceSource } from "./slice";

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const missing = Symbol("missing JSON document or key");
const zeroBlob = "0".repeat(40);

// Preserve number tokens rather than rounding distinct JSON numbers to the same
// JavaScript double. An alternate spelling may appear as a change.
class JsonNumber {
  constructor(readonly literal: string) {}
}

function parseJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("The runtime cannot preserve JSON number tokens.");
    return new JsonNumber(context.source);
  });
}

function jsonText(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!(item instanceof JsonNumber)) return item;
    if ("rawJSON" in JSON && typeof JSON.rawJSON === "function") return JSON.rawJSON(item.literal);
    throw new Error("The runtime cannot render exact JSON numbers.");
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

async function pinnedJson(cwd: string, blob: string) {
  if (blob === zeroBlob) return missing;
  const body = await readPinnedReviewBlob(cwd, blob, MAX_BLOB_BYTES);
  if (!body || body === "binary") throw new Error("The exact JSON blob is unavailable.");
  return parseJson(body.toString("utf8"));
}

/** Compare parsed values, preserving array order and using RFC 6901 pointers. */
function structuralDiff(before: unknown, after: unknown, blobs: readonly [string, string], maxBytes: number) {
  const lines = [
    ` Structural JSON diff of Git blobs ${blobs[0]} → ${blobs[1]}.`,
    " Locations are JSON pointers. The section's line numbers are synthetic.",
  ];
  let bytes = Buffer.byteLength(lines.join("\n")) + 1;
  let changedLines = 0;
  const append = (line: string) => {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > maxBytes) throw new Error("Structural evidence exceeds its byte budget.");
    lines.push(line);
  };
  const compare = (a: unknown, b: unknown, pointer: string, depth: number) => {
    if (a === b || a instanceof JsonNumber && b instanceof JsonNumber && a.literal === b.literal) return;
    if (depth > 128) throw new Error("The JSON document exceeds the comparison depth limit.");
    if (isObject(a) && isObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const segment = key.replaceAll("~", "~0").replaceAll("/", "~1");
        compare(Object.hasOwn(a, key) ? a[key] : missing, Object.hasOwn(b, key) ? b[key] : missing, `${pointer}/${segment}`, depth + 1);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        compare(index < a.length ? a[index] : missing, index < b.length ? b[index] : missing, `${pointer}/${index}`, depth + 1);
      }
      return;
    }
    const location = JSON.stringify(pointer);
    if (a !== missing) { append(`- ${location}: ${jsonText(a)}`); changedLines++; }
    if (b !== missing) { append(`+ ${location}: ${jsonText(b)}`); changedLines++; }
  };
  compare(before, after, "", 0);
  if (changedLines === 0) append(" Parsed JSON is unchanged. Whitespace and object member order are ignored.");
  return { text: lines.join("\n"), changedLines, bytes };
}

/** Replace whole-file JSON omissions with bounded evidence from the exact Git diff. */
export async function includeStructuredJson(cwd: string, diff: string, source: SliceSource): Promise<SliceSource> {
  const candidates = new Set([...source.drops.filter(drop => drop.granularity === "file"),
    ...ledgerOmissions(source.regions.filter(region => /\.json$/i.test(region.path)))]
    .filter(drop => (drop.reason === "generated" || drop.reason === "large-json") && /\.json$/i.test(drop.path) && safeSourcePath(drop.path))
    .map(drop => drop.path));
  if (!candidates.size) return source;
  const regions = new Map<string, ScopedRegion>();
  let remaining = MAX_EVIDENCE_BYTES;
  for (const entry of reviewDiffBlobPairs(diff, candidates)) {
    if (remaining <= 0) break;
    try {
      const [before, after] = await Promise.all(entry.blobs.map(blob => pinnedJson(cwd, blob)));
      const evidence = structuralDiff(before, after, entry.blobs, remaining);
      remaining -= evidence.bytes;
      regions.set(entry.path, { path: entry.path, startLine: 1, endLine: 1, changedLines: evidence.changedLines,
        contextTruncated: false, structuralJson: true, text: evidence.text });
    } catch {
      // Retain the original omission when the complete comparison cannot be produced.
    }
  }
  if (!regions.size) return source;
  return {
    ...source,
    regions: [...source.regions.filter(region => !regions.has(region.path)), ...regions.values()],
    drops: source.drops.filter(drop => !regions.has(drop.path)),
  };
}
