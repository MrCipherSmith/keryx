// A JSON document that does not fit, summarised into JSON that still parses.
//
// Flow 235 / T9, AC3 (AFC-14): "JSON валиден". `specification.md` §6 asks for
// "JSON → schema-valid summary со своим type" — a summary with its OWN type,
// not a shortened copy of the document.
//
// The two previous states of this path were both wrong, in opposite ways:
//
//   1. Line truncation produced a body that opened `{`, closed `}` and failed
//      `JSON.parse` mid-array. A consumer that parses gets a hard error; a
//      consumer that eyeballs it believes it read the file.
//   2. Labelling that fragment "an excerpt, which does not parse" (the previous
//      step in this flow) stopped the lie but left the reader with nothing
//      machine-readable. Honest and useless.
//
// So an elided JSON document now becomes a bounded structural summary that
// parses, declares itself incomplete, states where each loss happened, and
// carries the address of the full copy. The document's own shape is preserved
// so that the fields a reader looks for — `exitCode`, a failed-test count, an
// `errors` array — are still where they were, rather than surviving by the
// accident of sitting near the head of the file.
//
// A document that already fits is returned untouched. Wrapping a 22-byte object
// in a summary envelope would fail the other half of the same criterion
// ("короткий ввод не раздувается") and it would parse to something the caller
// did not ask for.

export const SUMMARY_TYPE = "json-structure";
export const SUMMARY_VERSION = 1;

type Budget = {
  /** Upper bound on the rendered summary, in UTF-8 bytes. */
  maxBytes: number;
  /** The address of the full copy, for the envelope and the array markers. */
  recover: string;
};

type Limits = {
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
  maxDepth: number;
};

/**
 * The elision markers are strings and objects, so every one of them is legal
 * JSON in the position it occupies: an array keeps its array type and gains one
 * more element; an object keeps its object type and gains one more key. Nothing
 * downstream has to special-case a hole.
 */
const ARRAY_MARKER = (omitted: number, total: number, recover: string): string =>
  `… ${omitted} of ${total} items omitted — ${recover}`;

const KEY_MARKER = "…omitted";

/** Progressively tighter limits. The first that fits the budget is used. */
const LIMIT_LADDER: Limits[] = [
  { maxArrayItems: 25, maxObjectKeys: 64, maxStringLength: 400, maxDepth: 8 },
  { maxArrayItems: 10, maxObjectKeys: 48, maxStringLength: 200, maxDepth: 7 },
  { maxArrayItems: 5, maxObjectKeys: 32, maxStringLength: 120, maxDepth: 6 },
  { maxArrayItems: 3, maxObjectKeys: 24, maxStringLength: 80, maxDepth: 5 },
  { maxArrayItems: 2, maxObjectKeys: 16, maxStringLength: 60, maxDepth: 4 },
  { maxArrayItems: 1, maxObjectKeys: 12, maxStringLength: 40, maxDepth: 3 },
  { maxArrayItems: 0, maxObjectKeys: 8, maxStringLength: 24, maxDepth: 2 },
];

/**
 * The human-readable line above a structural summary.
 *
 * Deliberately NOT `excerptNotice` from ./lines: that one ends "which does not
 * parse", which was true of a truncated fragment and is false of this. Saying
 * a parseable summary does not parse would be the same class of dishonesty,
 * pointing the other way.
 */
export function structuralSummaryNotice(totalLines: number, recover: string): string {
  return (
    `Excerpt: a bounded structural summary of a ${totalLines}-line json document — ` +
    `valid JSON of its own \`keryxSummary\` type, not the document itself. ` +
    `The whole document: \`${recover}\`.`
  );
}

export type JsonSummary = {
  /** The rendered summary. Always parses. */
  text: string;
  /** False when anything was elided. */
  complete: boolean;
};

/**
 * Summarise `content` as JSON, or return null when it is not a whole JSON
 * document (the caller then falls back to line compaction).
 *
 * Returns the source verbatim when it already fits, so that "already within
 * budget" costs nothing and the caller gets the real document back.
 */
export function summarizeJsonDocument(content: string, budget: Budget): JsonSummary | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let document: unknown;
  try {
    document = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (Buffer.byteLength(trimmed) <= budget.maxBytes) {
    return { text: trimmed, complete: true };
  }

  for (const limits of LIMIT_LADDER) {
    const loss = { arrays: 0, objectKeys: 0, strings: 0 };
    const summarised = summarizeNode(document, limits, 0, budget.recover, loss);
    const text = render(summarised, loss, budget.recover);
    if (Buffer.byteLength(text) <= budget.maxBytes) {
      return { text, complete: false };
    }
  }

  // Even the tightest ladder rung overflows — a pathological document (tens of
  // thousands of top-level keys). Say what it is and where it is rather than
  // emitting something that does not parse.
  const loss = { arrays: 0, objectKeys: 0, strings: 0 };
  const shape = describeShape(document);
  return {
    text: render(shape, loss, budget.recover, "the document is too large to summarise structurally"),
    complete: false,
  };
}

function render(
  document: unknown,
  loss: { arrays: number; objectKeys: number; strings: number },
  recover: string,
  note?: string,
): string {
  return JSON.stringify(
    {
      keryxSummary: {
        type: SUMMARY_TYPE,
        version: SUMMARY_VERSION,
        complete: false,
        recover,
        elided: loss,
        ...(note ? { note } : {}),
      },
      document,
    },
    null,
    2,
  );
}

function describeShape(document: unknown): unknown {
  if (Array.isArray(document)) {
    return { type: "array", length: document.length };
  }
  if (document !== null && typeof document === "object") {
    return { type: "object", keys: Object.keys(document).length };
  }
  return { type: typeof document };
}

function summarizeNode(
  node: unknown,
  limits: Limits,
  depth: number,
  recover: string,
  loss: { arrays: number; objectKeys: number; strings: number },
): unknown {
  if (node === null || typeof node === "boolean" || typeof node === "number") {
    return node;
  }

  if (typeof node === "string") {
    if (node.length <= limits.maxStringLength) {
      return node;
    }
    loss.strings += 1;
    return `${node.slice(0, limits.maxStringLength)}… (${node.length} chars)`;
  }

  if (Array.isArray(node)) {
    if (depth >= limits.maxDepth) {
      loss.arrays += 1;
      return [ARRAY_MARKER(node.length, node.length, recover)];
    }
    const shown = node
      .slice(0, limits.maxArrayItems)
      .map((item) => summarizeNode(item, limits, depth + 1, recover, loss));
    if (node.length <= limits.maxArrayItems) {
      return shown;
    }
    loss.arrays += 1;
    return [...shown, ARRAY_MARKER(node.length - shown.length, node.length, recover)];
  }

  if (typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    if (depth >= limits.maxDepth) {
      loss.objectKeys += entries.length;
      return { [KEY_MARKER]: `${entries.length} keys not shown — ${recover}` };
    }
    const kept = entries.slice(0, limits.maxObjectKeys);
    const summarised: Record<string, unknown> = {};
    for (const [key, value] of kept) {
      summarised[key] = summarizeNode(value, limits, depth + 1, recover, loss);
    }
    if (entries.length > kept.length) {
      loss.objectKeys += entries.length - kept.length;
      summarised[KEY_MARKER] = `${entries.length - kept.length} more keys not shown — ${recover}`;
    }
    return summarised;
  }

  return null;
}

/**
 * JSON Lines: keep whole rows, and make the elision itself a valid row.
 *
 * The unit of validity for JSONL is the line, so head/tail compaction already
 * leaves every SOURCE row parseable — the one line that does not parse is the
 * marker compaction inserts in the middle. One prose line is enough to make
 * `readLines().map(JSON.parse)` throw on the first thing a JSONL consumer does,
 * so the marker is rewritten as a row that carries the same facts and parses.
 */
export function jsonlOmissionRow(note: string, recover: string): string {
  return JSON.stringify({ keryxOmitted: { note, recover } });
}

/**
 * The notice above a compacted JSONL body.
 *
 * Not `excerptNotice`, for the same reason as above: after the marker is
 * repaired every row parses, so "which does not parse" would be false. What is
 * true, and what the reader needs, is that rows are MISSING.
 */
export function jsonlExcerptNotice(shownRows: number, totalRows: number): string {
  return (
    `Excerpt: \`${shownRows} of ${totalRows} rows\` — an incomplete jsonl document. ` +
    `Every row shown parses; the omitted rows are addressed below.`
  );
}

/** True when `line` is a parseable JSON row. */
export function isJsonRow(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every line of a compacted JSONL body, with any line that does not parse
 * replaced by one that does.
 */
export function repairJsonLines(lines: string[], recover: string): string[] {
  return lines.map((line) =>
    line.trim().length === 0 || isJsonRow(line) ? line : jsonlOmissionRow(line.trim(), recover),
  );
}
