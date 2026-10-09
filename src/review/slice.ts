import { buildReviewScope, type ReviewScopeConfig, type ScopedRegion, type ScopeDrop } from "./scope";

/** Per-reviewer ceiling for one slice, in bytes. A reviewer that must read more than this burns its round budget. */
export const DEFAULT_SLICE_MAX_BYTES = 150_000;
/** Below this a header alone would not fit, so a smaller ceiling is refused rather than silently exceeded. */
export const MIN_SLICE_MAX_BYTES = 200;

export type SliceSplit = "domain" | "file" | "hunk";

export type SliceEntry = {
  id: string;
  path: string;
  bytes: number;
  files: string[];
  domain: string;
  /** The deepest cut this slice needed: a whole domain, one file of a big domain, or one hunk of a big file. */
  split: SliceSplit;
  /** Set on a slice a retry produced. */
  retryOf?: string[];
  attempt?: number;
  reviewer?: string;
};

export type SliceOmission = {
  path: string;
  reason: string;
  detail: string;
  /** Bytes of diff text left out. 0 when the pre-filter dropped the file before it was rendered. */
  bytes: number;
};

export type SliceManifest = {
  schemaVersion: 1;
  maxBytes: number;
  source: "diff" | "scoped-diff";
  slices: SliceEntry[];
  omissions: SliceOmission[];
  totals: {
    slices: number;
    bytes: number;
    files: number;
    omittedFiles: number;
    omittedBytes: number;
    droppedBlocks: number;
  };
};

export type BuiltSlice = SliceEntry & { text: string };

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const SCOPED_RANGE = /^@@ (\d+),(\d+) @@$/;

function isScopedHeader(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.startsWith("--- ")) {
    return false;
  }
  if (index > 0 && lines[index - 1] !== "") {
    return false;
  }
  return SCOPED_RANGE.test(lines[index + 1] ?? "");
}

/** True for `renderScopedDiff` output: `--- path` followed by `@@ a,b @@`, with no git file headers. */
export function looksLikeScopedDiff(text: string): boolean {
  if (/^diff --git /m.test(text) || /^\+\+\+ /m.test(text)) {
    return false;
  }
  return isScopedHeader(text.split("\n"), 0);
}

/** Parse `keryx review scope --scoped-diff` output back into regions. */
export function parseScopedDiff(text: string): ScopedRegion[] {
  const lines = text.split("\n");
  const regions: ScopedRegion[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!isScopedHeader(lines, index)) {
      index += 1;
      continue;
    }
    const filePath = lines[index]!.slice(4);
    const range = SCOPED_RANGE.exec(lines[index + 1]!)!;
    let end = index + 2;
    while (end < lines.length && !isScopedHeader(lines, end)) {
      end += 1;
    }
    let body = lines.slice(index + 2, end);
    while (body.length > 0 && body.at(-1) === "") {
      body = body.slice(0, -1);
    }
    regions.push({
      path: filePath,
      startLine: Number(range[1]),
      endLine: Number(range[2]),
      changedLines: body.filter((line) => line.startsWith("+") || line.startsWith("-")).length,
      contextTruncated: false,
      text: body.join("\n"),
    });
    index = end;
  }
  return regions;
}

export type SliceSource = {
  source: "diff" | "scoped-diff";
  regions: ScopedRegion[];
  drops: ScopeDrop[];
};

/** A git unified diff (with `diff --git` or bare `---`/`+++` headers) or an already-scoped diff. */
export function sliceSourceFromDiff(diff: string, config?: Partial<ReviewScopeConfig>): SliceSource {
  if (looksLikeScopedDiff(diff)) {
    return { source: "scoped-diff", regions: parseScopedDiff(diff), drops: [] };
  }
  const scope = buildReviewScope(diff, config);
  return { source: "diff", regions: scope.regions, drops: scope.drops };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const LOCKFILE_RE =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock|deno\.lock)$/;
const DATA_RE = /\.(csv|tsv|psv|jsonl|ndjson|parquet)$/i;
const SNAPSHOT_RE = /(\.snap$|(^|\/)__snapshots__\/)/;
const GENERATED_RE = /(\.min\.(js|css)$|\.map$|(^|\/)(dist|__generated__|generated)\/|\.generated\.)/;
const FIXTURE_DIR_RE = /(^|\/)(fixtures?|__fixtures__|testdata)\//;
const FIXTURE_JSON_BYTES = 20_000;
const LARGE_JSON_BYTES = 100_000;

/** Why a path is a ledger or build product that no reviewer should read as code, or null. */
export function classifyLedger(filePath: string, bytes: number): { reason: string; detail: string } | null {
  if (LOCKFILE_RE.test(filePath)) {
    return { reason: "lockfile", detail: "lockfile: resolved dependency output" };
  }
  if (DATA_RE.test(filePath)) {
    return { reason: "data-ledger", detail: "data ledger: tabular or line-delimited data, not code" };
  }
  if (SNAPSHOT_RE.test(filePath)) {
    return { reason: "snapshot", detail: "snapshot: recorded test output" };
  }
  if (GENERATED_RE.test(filePath)) {
    return { reason: "generated", detail: "generated or minified build output" };
  }
  if (/\.json$/i.test(filePath)) {
    if (FIXTURE_DIR_RE.test(filePath) && bytes > FIXTURE_JSON_BYTES) {
      return { reason: "large-json", detail: `large json fixture (${bytes} bytes of diff)` };
    }
    if (bytes > LARGE_JSON_BYTES) {
      return { reason: "large-json", detail: `large json document (${bytes} bytes of diff)` };
    }
  }
  return null;
}

const TEST_RE = /(\.(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?|e2e)\/)/i;
const DOCS_RE = /(\.(md|mdx|rst|txt)$|(^|\/)docs?\/)/i;
const CONFIG_RE = /(\.(ya?ml|toml|ini|cfg|conf)$|(^|\/)\.[^/]+rc(\.[a-z]+)?$)/i;

/** Directory or module, plus file kind for tests, docs and config, so a test never shares a slice label with its subject. */
export function sliceDomainOf(filePath: string): string {
  const parts = filePath.split("/");
  const dirs = parts.slice(0, -1);
  const module = dirs.length === 0 ? "." : dirs.slice(0, dirs[0] === "src" || dirs[0] === "packages" ? 2 : 1).join("/");
  const kind = TEST_RE.test(filePath) ? "test" : DOCS_RE.test(filePath) ? "docs" : CONFIG_RE.test(filePath) ? "config" : "code";
  return kind === "code" ? module : `${module} [${kind}]`;
}

// ---------------------------------------------------------------------------
// Rendering and splitting
// ---------------------------------------------------------------------------

function renderSection(filePath: string, startLine: number, endLine: number, text: string): string {
  return `--- ${filePath}\n@@ ${startLine},${endLine} @@\n${text}`;
}

function regionSection(region: ScopedRegion): string {
  return renderSection(region.path, region.startLine, region.endLine, region.text);
}

/** Bytes a file holding exactly these sections occupies: joined by a blank line, ending in one newline. */
function sectionsBytes(sections: readonly string[]): number {
  if (sections.length === 0) {
    return 0;
  }
  return sections.reduce((total, section) => total + byteLength(section), 0) + 2 * (sections.length - 1) + 1;
}

function chunkLine(line: string, budget: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const size = byteLength(char);
    if (currentBytes + size > budget && current !== "") {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current !== "") {
    chunks.push(current);
  }
  return chunks;
}

/** Cut one region into sections that each fit `max` bytes alone, by line and, for a single huge line, by bytes. */
function splitRegion(region: ScopedRegion, max: number): string[] {
  const whole = regionSection(region);
  if (sectionsBytes([whole]) <= max) {
    return [whole];
  }
  const sourceLines = region.text.split("\n");
  const headerUpper = byteLength(renderSection(region.path, region.endLine + sourceLines.length, region.endLine + sourceLines.length, ""));
  const avail = Math.max(16, max - 1 - headerUpper);
  const lines = sourceLines.flatMap((line) => (byteLength(line) > avail ? chunkLine(line, avail) : [line]));

  const pieces: string[] = [];
  let bucket: string[] = [];
  let bucketBytes = -1;
  let cursor = region.startLine;
  let pieceStart = cursor;
  const flush = (): void => {
    if (bucket.length === 0) {
      return;
    }
    pieces.push(renderSection(region.path, pieceStart, Math.max(pieceStart, cursor - 1), bucket.join("\n")));
    bucket = [];
    bucketBytes = -1;
    pieceStart = cursor;
  };
  for (const line of lines) {
    const size = byteLength(line);
    if (bucket.length > 0 && bucketBytes + 1 + size > avail) {
      flush();
    }
    bucketBytes = bucket.length === 0 ? size : bucketBytes + 1 + size;
    bucket.push(line);
    if (!line.startsWith("-")) {
      cursor += 1;
    }
  }
  flush();
  return pieces;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

type Draft = {
  sections: string[];
  files: string[];
  domains: string[];
  split: SliceSplit;
};

const SPLIT_RANK: Record<SliceSplit, number> = { domain: 0, file: 1, hunk: 2 };

class Packer {
  readonly drafts: Draft[] = [];
  private current: Draft | null = null;

  constructor(private readonly max: number) {}

  close(): void {
    this.current = null;
  }

  place(sections: readonly string[], files: readonly string[], domain: string, split: SliceSplit): void {
    let draft = this.current;
    if (draft === null || sectionsBytes([...draft.sections, ...sections]) > this.max) {
      draft = { sections: [], files: [], domains: [], split: "domain" };
      this.drafts.push(draft);
      this.current = draft;
    }
    draft.sections.push(...sections);
    for (const file of files) {
      if (!draft.files.includes(file)) {
        draft.files.push(file);
      }
    }
    if (!draft.domains.includes(domain)) {
      draft.domains.push(domain);
    }
    if (SPLIT_RANK[split] > SPLIT_RANK[draft.split]) {
      draft.split = split;
    }
  }
}

function domainLabel(domains: readonly string[]): string {
  return domains.length <= 3 ? domains.join(", ") : `${domains.slice(0, 3).join(", ")} +${domains.length - 3} more`;
}

export type BuildSlicesOptions = {
  maxBytes?: number;
  /** Prefix for slice `path` values. Left empty, `path` is the bare file name. */
  dir?: string;
  /** Slice id and file prefix, e.g. `slice`. */
  prefix?: string;
  /** Skip the ledger filter, for text a previous pass already filtered. */
  keepLedgers?: boolean;
};

export function validateSliceMaxBytes(value: number): number {
  if (!Number.isInteger(value) || value < MIN_SLICE_MAX_BYTES) {
    throw new Error(`Invalid --max-bytes: ${value}. Expected an integer of at least ${MIN_SLICE_MAX_BYTES}.`);
  }
  return value;
}

/**
 * Cut scope A into slices of at most `maxBytes` each.
 *
 * Domains keep their files together; a domain larger than the ceiling is cut by
 * file, a file larger than the ceiling by hunk, a hunk larger than the ceiling by
 * line. Small domains share a slice only while they fit. Ledgers and the
 * pre-filter's file drops go to `omissions` with their reason, never into a slice.
 */
export function buildSlices(
  source: Pick<SliceSource, "regions" | "drops"> & { source?: SliceSource["source"] },
  options: BuildSlicesOptions = {},
): { manifest: SliceManifest; slices: BuiltSlice[] } {
  const max = validateSliceMaxBytes(options.maxBytes ?? DEFAULT_SLICE_MAX_BYTES);
  const prefix = options.prefix ?? "slice";
  const dir = options.dir === undefined || options.dir === "" ? "" : `${options.dir.replace(/\/+$/, "")}/`;

  const byFile = new Map<string, ScopedRegion[]>();
  for (const region of source.regions) {
    const list = byFile.get(region.path);
    if (list === undefined) {
      byFile.set(region.path, [region]);
    } else {
      list.push(region);
    }
  }

  const omissions: SliceOmission[] = [];
  for (const drop of source.drops) {
    if (drop.granularity === "file") {
      omissions.push({ path: drop.path, reason: drop.reason, detail: drop.detail, bytes: 0 });
    }
  }

  const byDomain = new Map<string, Map<string, ScopedRegion[]>>();
  for (const [filePath, regions] of byFile) {
    const bytes = sectionsBytes(regions.map(regionSection));
    const ledger = options.keepLedgers === true ? null : classifyLedger(filePath, bytes);
    if (ledger !== null) {
      omissions.push({ path: filePath, reason: ledger.reason, detail: ledger.detail, bytes });
      continue;
    }
    const domain = sliceDomainOf(filePath);
    const files = byDomain.get(domain) ?? new Map<string, ScopedRegion[]>();
    files.set(filePath, regions);
    byDomain.set(domain, files);
  }

  const packer = new Packer(max);
  for (const [domain, files] of byDomain) {
    const fileSections = [...files].map(([filePath, regions]) => ({ filePath, sections: regions.map(regionSection), regions }));
    const all = fileSections.flatMap((entry) => entry.sections);
    if (sectionsBytes(all) <= max) {
      packer.place(all, [...files.keys()], domain, "domain");
      continue;
    }
    packer.close();
    for (const entry of fileSections) {
      if (sectionsBytes(entry.sections) <= max) {
        packer.place(entry.sections, [entry.filePath], domain, "file");
        continue;
      }
      for (const region of entry.regions) {
        for (const piece of splitRegion(region, max)) {
          packer.place([piece], [entry.filePath], domain, "hunk");
        }
      }
    }
  }

  const width = Math.max(2, String(packer.drafts.length).length);
  const slices: BuiltSlice[] = packer.drafts.map((draft, index) => {
    const id = `${prefix}-${String(index + 1).padStart(width, "0")}`;
    const text = `${draft.sections.join("\n\n")}\n`;
    return {
      id,
      path: `${dir}${id}.diff`,
      bytes: byteLength(text),
      files: draft.files,
      domain: domainLabel(draft.domains),
      split: draft.split,
      text,
    };
  });

  const droppedBlocks = source.drops.filter((drop) => drop.granularity === "block").length;
  const manifest: SliceManifest = {
    schemaVersion: 1,
    maxBytes: max,
    source: source.source ?? "diff",
    slices: slices.map(({ text: _text, ...entry }) => entry),
    omissions,
    totals: {
      slices: slices.length,
      bytes: slices.reduce((total, slice) => total + slice.bytes, 0),
      files: new Set(slices.flatMap((slice) => slice.files)).size,
      omittedFiles: omissions.length,
      omittedBytes: omissions.reduce((total, omission) => total + omission.bytes, 0),
      droppedBlocks,
    },
  };
  return { manifest, slices };
}

/** Re-cut already-scoped slice text at a smaller ceiling. Used by the retry plan. */
export function resliceText(
  text: string | readonly string[],
  maxBytes: number,
  options: Pick<BuildSlicesOptions, "dir" | "prefix"> = {},
): BuiltSlice[] {
  const joined = typeof text === "string" ? text : text.join("\n");
  return buildSlices({ regions: parseScopedDiff(joined), drops: [], source: "scoped-diff" }, { ...options, maxBytes, keepLedgers: true }).slices;
}

export function renderSliceSummary(manifest: SliceManifest): string {
  const lines = [
    `slices: ${manifest.totals.slices} (<= ${manifest.maxBytes} bytes each, ${manifest.totals.bytes} bytes total, ${manifest.totals.files} files)`,
    ...manifest.slices.map((slice) => `- ${slice.id}  ${slice.bytes} bytes  ${slice.files.length} files  [${slice.split}]  ${slice.domain}`),
    `omitted: ${manifest.totals.omittedFiles} files (${manifest.totals.omittedBytes} bytes of diff)`,
    ...manifest.omissions.map((omission) => `- ${omission.path}  ${omission.reason}  ${omission.bytes} bytes`),
  ];
  return lines.join("\n");
}
