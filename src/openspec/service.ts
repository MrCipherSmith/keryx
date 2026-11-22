import { createHash } from "node:crypto";

import {
  scanOpenSpec, type OpenSpecArtifact, type OpenSpecCatalog, type OpenSpecDiagnostic,
  type OpenSpecEntry, type OpenSpecKind, type OpenSpecLink,
} from "./catalog";
import { parseOpenSpecMarkdown, type OpenSpecDeltaOperation, type OpenSpecMarkdownRequirement } from "./markdown";

export type OpenSpecEntrySummary = Omit<OpenSpecEntry, "artifacts">;

export interface OpenSpecSourceRef {
  path: string;
  digest: string;
  startLine?: number;
  endLine?: number;
}

export interface OpenSpecScenario {
  title: string;
  section: string;
  source: OpenSpecSourceRef;
}

export interface OpenSpecRequirement extends OpenSpecScenario {
  operation?: OpenSpecDeltaOperation;
  renamedTo?: string;
  baseline?: { state: "matched" | "absent" | "unresolved"; source?: OpenSpecSourceRef };
  scenarios: OpenSpecScenario[];
}

export interface OpenSpecDeltaRelationship {
  changeId: string;
  specPath: string;
  source: OpenSpecSourceRef;
}

export interface OpenSpecHistoryItem {
  entry: OpenSpecEntrySummary;
  source: OpenSpecSourceRef;
  requirements: OpenSpecRequirement[];
}

export interface OpenSpecSearchHit {
  entry: OpenSpecEntrySummary;
  rank: number;
  matchType: "title" | "path" | "heading" | "body";
  snippet: string;
  section?: string;
  source: OpenSpecSourceRef;
}

export interface OpenSpecArtifactDetail {
  source: OpenSpecSourceRef;
  markdown: string;
  requirements: OpenSpecRequirement[];
  section?: string;
}

interface ServiceDiagnostic extends OpenSpecDiagnostic {
  line?: number;
  endLine?: number;
}

export interface OpenSpecDetail {
  snapshotId: string;
  entry: OpenSpecEntrySummary;
  artifacts: OpenSpecSourceRef[];
  artifact?: OpenSpecArtifactDetail;
  diagnostics: ServiceDiagnostic[];
  relatedSpecs: OpenSpecDeltaRelationship[];
  partial: boolean;
}

export interface OpenSpecPage<T> {
  snapshotId: string;
  items: T[];
  nextCursor?: string;
  partial: boolean;
}

interface PageOptions {
  cursor?: string;
  expectedSnapshotId?: string;
}

interface SearchOptions {
  query: string;
  scope?: readonly OpenSpecKind[];
}

interface DetailOptions {
  id?: string;
  path?: string;
  artifactPath?: string;
  section?: string;
  expectedDigest?: string;
  expectedSnapshotId?: string;
}

type ReadErrorCode = "invalid-input" | "stale-snapshot" | "stale-section" | "not-found";

export class OpenSpecReadError extends Error {
  constructor(readonly code: ReadErrorCode, message: string) {
    super(message);
    this.name = "OpenSpecReadError";
  }
}

export interface OpenSpecSnapshot {
  catalog: OpenSpecCatalog;
  relationships: { deltas: OpenSpecDeltaRelationship[]; links: OpenSpecLink[] };
  list(options: PageOptions & { kind: OpenSpecKind }): OpenSpecPage<OpenSpecEntrySummary>;
  detail(options: DetailOptions): OpenSpecDetail;
  history(options: PageOptions & { id: string }): OpenSpecPage<OpenSpecHistoryItem>;
  search(options: SearchOptions & PageOptions): OpenSpecPage<OpenSpecSearchHit>;
  searchHits(options: SearchOptions): { items: OpenSpecSearchHit[]; partial: boolean };
}

const KINDS: readonly OpenSpecKind[] = ["spec", "change", "archive"];
const DEFAULT_SCOPE: readonly OpenSpecKind[] = ["spec", "change"];
const PAGE_SIZE = 100;
const MAX_PAGE_BYTES = 900 * 1024;
const MAX_ARTIFACT_MARKDOWN_BYTES = 400 * 1024;
const MAX_DETAIL_METADATA_BYTES = 450 * 1024;
const MAX_HISTORY_ITEM_BYTES = 200 * 1024;
const MAX_HITS_PER_KIND = 12_000;
const MAX_QUERY_LENGTH = 512;
const SHA256 = /^[a-f0-9]{64}$/;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

function summary({ artifacts: _artifacts, ...entry }: OpenSpecEntry): OpenSpecEntrySummary {
  return entry;
}

function sourceRef(artifact: OpenSpecArtifact, range?: { startLine: number; endLine: number }): OpenSpecSourceRef {
  return { path: artifact.path, digest: artifact.digest, ...range };
}

function filePath(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex -- reject control characters in exposed paths
  return typeof value === "string" && value.length <= 1024 && !/^[a-z]:|[\\\x00-\x1f\x7f]/i.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function deltaTarget(entry: OpenSpecEntry, artifact: OpenSpecArtifact): string | undefined {
  if (entry.kind === "spec") return undefined;
  const relativePath = artifact.path.slice(entry.path.length + 1);
  return /^specs\/[^/]+\/spec\.md$/.test(relativePath) ? `openspec/${relativePath}` : undefined;
}

function checkSnapshot(actual: string, expected?: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new OpenSpecReadError("stale-snapshot", "OpenSpec changed. Refresh and retry.");
  }
}

function cursorOffset(snapshotId: string, key: string, cursor?: string): number {
  if (cursor === undefined) return 0;
  try {
    if (cursor.length > 255 || !/^[\w-]+$/.test(cursor)) throw new Error("format");
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("encoding");
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error("shape");
    const [pin, cursorKey, offset]: unknown[] = decoded;
    if (typeof pin !== "string" || !SHA256.test(pin) || cursorKey !== key
      || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset <= 0) throw new Error("fields");
    checkSnapshot(snapshotId, pin);
    return offset;
  } catch (error) {
    if (error instanceof OpenSpecReadError) throw error;
    throw new OpenSpecReadError("invalid-input", "The OpenSpec cursor does not match this request.");
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function boundedItems<T>(values: Iterable<T>, maxBytes: number, maxItems = Infinity): { items: T[]; truncated: boolean } {
  const items: T[] = [];
  let bytes = 2;
  for (const value of values) {
    bytes += jsonBytes(value) + 1;
    if (items.length >= maxItems || bytes > maxBytes) return { items, truncated: true };
    items.push(value);
  }
  return { items, truncated: false };
}

function openPage(catalog: OpenSpecCatalog, key: string, size: number, options: PageOptions): number {
  checkSnapshot(catalog.snapshotId, options.expectedSnapshotId);
  const offset = cursorOffset(catalog.snapshotId, key, options.cursor);
  if (offset > 0 && offset >= size) throw new OpenSpecReadError("invalid-input", "The OpenSpec cursor offset is out of range.");
  return offset;
}

function page<T>(
  catalog: OpenSpecCatalog, key: string,
  input: { offset: number; total: number; items: T[]; partial?: boolean },
): OpenSpecPage<T> {
  const { snapshotId } = catalog;
  const { offset, total, items } = input;
  if (offset < total && items.length === 0) {
    throw new OpenSpecReadError("invalid-input", "An OpenSpec item exceeds the response budget.");
  }
  const next = offset + items.length;
  return {
    snapshotId, items,
    partial: (input.partial ?? false) || catalog.availability === "partial" || catalog.truncated,
    ...(next < total && { nextCursor: Buffer.from(JSON.stringify([snapshotId, key, next])).toString("base64url") }),
  };
}

interface IndexedSection extends OpenSpecScenario {
  line: number;
  end: number;
}

interface ParsedArtifact {
  sections: IndexedSection[];
  requirements: OpenSpecRequirement[];
  diagnostics: ServiceDiagnostic[];
}

function indexSections(
  artifact: OpenSpecArtifact, parsed: ReturnType<typeof parseOpenSpecMarkdown>, lineCount: number,
): Map<number, IndexedSection> {
  const headings = new Map(parsed.headings.map((heading) => [heading.line, heading]));
  const ranges = new Map<number, number>();
  for (const requirement of parsed.requirements) {
    headings.set(requirement.startLine, { title: requirement.title, line: requirement.startLine, level: 3 });
    ranges.set(requirement.startLine, requirement.endLine);
    for (const scenario of requirement.scenarios) {
      headings.set(scenario.startLine, { title: scenario.title, line: scenario.startLine, level: 4 });
      ranges.set(scenario.startLine, scenario.endLine);
    }
  }
  const sections = new Map<number, IndexedSection>();
  const parents: { level: number; value: IndexedSection }[] = [];
  const occurrences = new Map<string, number>();
  for (const { title, level, line } of [...headings.values()].sort((a, b) => a.line - b.line)) {
    while (parents.length && (parents.at(-1)?.level ?? 0) >= level) {
      const previous = parents.pop()?.value;
      if (previous) previous.end = Math.min(previous.end, line - 1);
    }
    const parent = parents.at(-1)?.value.section ?? "";
    const key = hash([parent, title]);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);

    const end = ranges.get(line) ?? lineCount;
    const value = {
      title, section: hash([artifact.path, key, occurrence]), line, end,
      source: sourceRef(artifact, { startLine: line, endLine: end }),
    };
    sections.set(line, value);
    parents.push({ level, value });
  }
  for (const value of sections.values()) value.source.endLine = value.end;
  return sections;
}

function normalizeQuery(query: string): string {
  if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH || !query.trim()) {
    throw new OpenSpecReadError("invalid-input", "Provide a nonempty OpenSpec search query of at most 512 characters.");
  }
  return query.trim().toLowerCase();
}

function normalizeScope(scope: readonly OpenSpecKind[] = DEFAULT_SCOPE): OpenSpecKind[] {
  if (!Array.isArray(scope) || !scope.length || scope.some((kind) => !KINDS.includes(kind))) {
    throw new OpenSpecReadError("invalid-input", "The OpenSpec search scope is invalid.");
  }
  return KINDS.filter((kind) => scope.includes(kind));
}

function plainSnippet(text: string, query: string): string {
  const offset = text.toLowerCase().indexOf(query);
  const start = Math.max(0, offset - 40);
  // eslint-disable-next-line no-control-regex -- keep search excerpts on one line
  return text.slice(start, start + 200).replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function* searchArtifact(
  artifact: OpenSpecArtifact, sections: Map<number, IndexedSection>,
  options: { entry: OpenSpecEntrySummary; query: string; omitArtifactHit: boolean },
): Iterable<OpenSpecSearchHit> {
  const { entry, query, omitArtifactHit } = options;
  const hits = new Set<string>();
  const lines = artifact.markdown.split(/\r\n?|\n/);
  let current: IndexedSection | undefined;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const next = sections.get(lineNumber);
    if (next) current = next;
    if (current && lineNumber > current.end) current = undefined;

    const headingMatch = next && next.title.toLowerCase().includes(query) ? next : undefined;
    if (!headingMatch && !line.toLowerCase().includes(query)) continue;
    const key = current?.section ?? "";
    if (hits.has(key) || (!current && omitArtifactHit)) continue;
    hits.add(key);
    yield {
      entry, rank: headingMatch ? 1 : 2, matchType: headingMatch ? "heading" : "body",
      snippet: plainSnippet(headingMatch?.title ?? line, query),
      source: headingMatch?.source ?? sourceRef(artifact, { startLine: lineNumber, endLine: lineNumber }),
      ...(current && { section: current.section }),
    };
  }
}

function compareHits(left: OpenSpecSearchHit, right: OpenSpecSearchHit): number {
  return left.rank - right.rank || compareText(left.entry.kind, right.entry.kind)
    || compareText(left.entry.path, right.entry.path) || compareText(left.source.path, right.source.path)
    || (left.source.startLine ?? 0) - (right.source.startLine ?? 0);
}

function boundedMarkdown(artifact: OpenSpecArtifact, selected?: IndexedSection): { markdown: string; truncated: boolean } {
  const markdown = selected
    ? artifact.markdown.split(/(?<=\n)|(?<=\r)(?!\n)/).slice(selected.line - 1, selected.end).join("")
    : artifact.markdown;
  if (jsonBytes(markdown) <= MAX_ARTIFACT_MARKDOWN_BYTES) return { markdown, truncated: false };

  // A serialized control character can take six bytes. Keep the prefix within the wire budget.
  let length = Math.floor((MAX_ARTIFACT_MARKDOWN_BYTES - 2) / 6);
  if (/[\uD800-\uDBFF]/.test(markdown.charAt(length - 1))) length--;
  return { markdown: markdown.slice(0, length), truncated: true };
}

function chooseEntry(
  byId: Map<string, OpenSpecEntry>, byPath: Map<string, OpenSpecEntry>, options: DetailOptions,
): OpenSpecEntry {
  if ((options.id === undefined) === (options.path === undefined)
    || (options.path !== undefined && !filePath(options.path))
    || (options.artifactPath !== undefined && !filePath(options.artifactPath))) {
    throw new OpenSpecReadError("invalid-input", "Provide one OpenSpec entry ID or a contained source path.");
  }
  const entry = options.id !== undefined ? byId.get(options.id) : byPath.get(options.path ?? "");
  if (!entry) throw new OpenSpecReadError("not-found", "The OpenSpec entry was not found.");
  return entry;
}

function chooseArtifact(entry: OpenSpecEntry, options: DetailOptions): OpenSpecArtifact | undefined {
  if (options.artifactPath !== undefined) {
    const artifact = entry.artifacts.find((item) => item.path === options.artifactPath);
    if (!artifact) throw new OpenSpecReadError("not-found", "The artifact was not found in the selected OpenSpec entry.");
    return artifact;
  }
  return entry.artifacts.find((item) => item.path === `${entry.path}/proposal.md`) ?? entry.artifacts[0];
}

class CheckoutOpenSpec implements OpenSpecSnapshot {
  readonly relationships: OpenSpecSnapshot["relationships"];
  private readonly byId = new Map<string, OpenSpecEntry>();
  private readonly byPath = new Map<string, OpenSpecEntry>();
  private readonly parsed = new Map<string, ParsedArtifact>();
  private readonly baselines = new Map<string, Map<string, OpenSpecSourceRef | undefined>>();
  private readonly archived = new Map<string, { entry: OpenSpecEntry; artifact: OpenSpecArtifact }[]>();
  private readonly related = new Map<string, OpenSpecDeltaRelationship[]>();

  constructor(readonly catalog: OpenSpecCatalog) {
    for (const entry of catalog.entries) {
      this.byId.set(entry.id, entry);
      this.byPath.set(entry.path, entry);
    }
    const deltas = catalog.entries.flatMap((entry) => this.indexDeltaPaths(entry));
    for (const delta of deltas) {
      const spec = this.byPath.get(delta.specPath);
      if (!spec) continue;
      const incoming = this.related.get(spec.id) ?? [];
      incoming.push(delta);
      this.related.set(spec.id, incoming);
    }
    this.relationships = { deltas, links: catalog.links };
  }

  list(options: PageOptions & { kind: OpenSpecKind }): OpenSpecPage<OpenSpecEntrySummary> {
    if (!KINDS.includes(options.kind)) throw new OpenSpecReadError("invalid-input", "The OpenSpec collection is invalid.");
    checkSnapshot(this.catalog.snapshotId, options.expectedSnapshotId);
    const items = this.catalog.entries.filter((entry) => entry.kind === options.kind).map(summary);
    const key = hash(["list", options.kind]);
    const offset = openPage(this.catalog, key, items.length, options);
    const bounded = boundedItems(items.slice(offset, offset + PAGE_SIZE), MAX_PAGE_BYTES);
    return page(this.catalog, key, { offset, total: items.length, items: bounded.items });
  }

  detail(options: DetailOptions): OpenSpecDetail {
    checkSnapshot(this.catalog.snapshotId, options.expectedSnapshotId);
    const entry = chooseEntry(this.byId, this.byPath, options);
    const artifact = chooseArtifact(entry, options);
    const artifactResult = artifact ? this.detailArtifact(entry, artifact, options) : undefined;
    if (!artifactResult && (options.section !== undefined || options.expectedDigest !== undefined)) {
      throw new OpenSpecReadError("stale-section", "The selected OpenSpec source section changed.");
    }
    const artifacts = boundedItems(entry.artifacts.map((item) => sourceRef(item)), MAX_DETAIL_METADATA_BYTES / 4);
    const related = boundedItems(this.related.get(entry.id) ?? [], MAX_DETAIL_METADATA_BYTES / 4);
    return {
      snapshotId: this.catalog.snapshotId, entry: summary(entry), artifacts: artifacts.items, relatedSpecs: related.items,
      diagnostics: artifactResult?.diagnostics ?? [],
      ...(artifactResult && { artifact: artifactResult.artifact }),
      partial: this.catalog.availability === "partial" || this.catalog.truncated || artifacts.truncated
        || related.truncated || (artifactResult?.partial ?? false),
    };
  }

  history(options: PageOptions & { id: string }): OpenSpecPage<OpenSpecHistoryItem> {
    checkSnapshot(this.catalog.snapshotId, options.expectedSnapshotId);
    const spec = this.byId.get(options.id);
    if (spec?.kind !== "spec") throw new OpenSpecReadError("not-found", "The current OpenSpec specification was not found.");

    const key = hash(["history", spec.id]);
    const rows = this.archived.get(spec.path) ?? [];
    const offset = openPage(this.catalog, key, rows.length, options);
    let partial = false;
    const read = this.parse.bind(this);
    function* candidates() {
      for (const { entry, artifact } of rows.slice(offset, offset + PAGE_SIZE)) {
        const { requirements } = read(entry, artifact);
        const limited = boundedItems(requirements, MAX_HISTORY_ITEM_BYTES - 4096);
        partial ||= limited.truncated;
        yield { entry: summary(entry), source: sourceRef(artifact), requirements: limited.items };
      }
    }
    const { items } = boundedItems(candidates(), MAX_PAGE_BYTES);
    return page(this.catalog, key, { offset, total: rows.length, items, partial });
  }

  search(options: SearchOptions & PageOptions): OpenSpecPage<OpenSpecSearchHit> {
    checkSnapshot(this.catalog.snapshotId, options.expectedSnapshotId);
    const scope = normalizeScope(options.scope);
    const query = normalizeQuery(options.query);
    const key = hash(["search", query, scope]);
    cursorOffset(this.catalog.snapshotId, key, options.cursor);
    const { items, partial } = this.searchHits({ query, scope });
    const offset = openPage(this.catalog, key, items.length, options);
    const bounded = boundedItems(items.slice(offset, offset + PAGE_SIZE), MAX_PAGE_BYTES);
    return page(this.catalog, key, { offset, total: items.length, items: bounded.items, partial });
  }

  searchHits(options: SearchOptions): { items: OpenSpecSearchHit[]; partial: boolean } {
    const query = normalizeQuery(options.query);
    const scope = normalizeScope(options.scope);
    const hits = new Map<OpenSpecKind, OpenSpecSearchHit[][]>();
    let partial = this.catalog.availability === "partial" || this.catalog.truncated;
    const entries = this.catalog.entries.filter((entry) => scope.includes(entry.kind))
      .sort((left, right) => compareText(left.path, right.path));
    for (const entry of entries) {
      const byRank = hits.get(entry.kind) ?? [[], [], []];
      hits.set(entry.kind, byRank);
      for (const hit of this.entryHits(entry, query)) {
        const bucket = byRank[hit.rank];
        if (!bucket) continue;
        if (bucket.length >= MAX_HITS_PER_KIND) partial = true;
        else bucket.push(hit);
      }
    }
    const items = [...hits.values()].flatMap((byRank) => {
      const ordered = byRank.flatMap((bucket) => bucket.sort(compareHits));
      partial ||= ordered.length > MAX_HITS_PER_KIND;
      return ordered.slice(0, MAX_HITS_PER_KIND);
    });
    return { items: items.sort(compareHits), partial };
  }

  private *entryHits(entry: OpenSpecEntry, query: string): Iterable<OpenSpecSearchHit> {
    const metadata = summary(entry);
    const title = entry.title.toLowerCase();
    const path = entry.path.toLowerCase();
    const titleMatch = title.includes(query);
    const pathMatch = path.includes(query);
    const first = entry.artifacts[0];
    const entryMatch = titleMatch || pathMatch;
    if (first && entryMatch) {
      const usePath = path === query || !titleMatch;
      yield {
        entry: metadata, rank: title === query || path === query ? 0 : 1,
        matchType: usePath ? "path" : "title",
        snippet: plainSnippet(usePath ? entry.path : entry.title, query), source: sourceRef(first),
      };
    }
    for (const artifact of entry.artifacts) {
      const artifactPath = artifact.path.toLowerCase();
      const artifactMatch = artifactPath.includes(query) && !(artifact === first && entryMatch);
      if (artifactMatch) {
        yield {
          entry: metadata, rank: artifactPath === query ? 0 : 1, matchType: "path",
          snippet: plainSnippet(artifact.path, query), source: sourceRef(artifact),
        };
      }
      if (!artifact.markdown.toLowerCase().includes(query)) continue;
      const parsed = parseOpenSpecMarkdown(artifact.markdown, { delta: deltaTarget(entry, artifact) !== undefined });
      const sections = indexSections(artifact, parsed, artifact.markdown.split(/\r\n?|\n/).length);
      yield* searchArtifact(artifact, sections, {
        entry: metadata, query, omitArtifactHit: artifactMatch || (artifact === first && entryMatch),
      });
    }
  }

  private indexDeltaPaths(entry: OpenSpecEntry): OpenSpecDeltaRelationship[] {
    const deltas: OpenSpecDeltaRelationship[] = [];
    for (const artifact of entry.artifacts) {
      const specPath = deltaTarget(entry, artifact);
      if (!specPath) continue;
      if (entry.kind === "archive") {
        const rows = this.archived.get(specPath) ?? [];
        rows.push({ entry, artifact });
        this.archived.set(specPath, rows);
      }
      if (this.byPath.get(specPath)?.kind === "spec") {
        deltas.push({ changeId: entry.id, specPath, source: sourceRef(artifact) });
      }
    }
    this.related.set(entry.id, deltas);
    return deltas;
  }

  private parse(entry: OpenSpecEntry, artifact: OpenSpecArtifact): ParsedArtifact {
    const cached = this.parsed.get(artifact.path);
    if (cached) return cached;
    const target = deltaTarget(entry, artifact);
    const parsed = parseOpenSpecMarkdown(artifact.markdown, { delta: target !== undefined });
    const sections = indexSections(artifact, parsed, artifact.markdown.split(/\r\n?|\n/).length);
    const requirements = parsed.requirements.flatMap((requirement) => {
      const indexed = sections.get(requirement.startLine);
      if (!indexed) return [];
      const baseline = entry.kind === "change" && target ? this.baseline(target, requirement) : undefined;
      return [{
        title: indexed.title, section: indexed.section, source: indexed.source,
        ...(requirement.operation && { operation: requirement.operation }),
        ...(requirement.renamedTo && { renamedTo: requirement.renamedTo }),
        ...(baseline && { baseline }),
        scenarios: requirement.scenarios.flatMap((scenario) => {
          const value = sections.get(scenario.startLine);
          return value ? [{ title: value.title, section: value.section, source: value.source }] : [];
        }),
      }];
    });
    const result = {
      requirements, sections: [...sections.values()],
      diagnostics: parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, path: artifact.path })),
    };
    this.parsed.set(artifact.path, result);
    return result;
  }

  private baseline(target: string, requirement: OpenSpecMarkdownRequirement): OpenSpecRequirement["baseline"] {
    let names = this.baselines.get(target);
    if (!names) {
      names = new Map();
      const spec = this.byPath.get(target);
      const artifact = spec?.artifacts.find((item) => item.path === target);
      if (spec && artifact) {
        for (const { title, source } of this.parse(spec, artifact).requirements) {
          names.set(title, names.has(title) ? undefined : source);
        }
      }
      this.baselines.set(target, names);
    }
    const match = names.get(requirement.title);
    if (match) return { state: "matched", source: match };
    if (requirement.operation === "added" && !names.has(requirement.title)) return { state: "absent" };
    return { state: "unresolved" };
  }

  private detailArtifact(entry: OpenSpecEntry, artifact: OpenSpecArtifact, options: DetailOptions) {
    if (options.expectedDigest !== undefined && options.expectedDigest !== artifact.digest) {
      throw new OpenSpecReadError("stale-section", "The selected OpenSpec artifact changed.");
    }
    const parsed = this.parse(entry, artifact);
    const selected = options.section === undefined ? undefined : parsed.sections.find((item) => item.section === options.section);
    if (options.section !== undefined && !selected) {
      throw new OpenSpecReadError("stale-section", "The selected OpenSpec source section changed.");
    }
    const rendered = boundedMarkdown(artifact, selected);
    const visible = selected ? parsed.requirements.filter(({ source }) =>
      (source.endLine ?? 0) >= selected.line && (source.startLine ?? 0) <= selected.end) : parsed.requirements;
    const requirements = boundedItems(visible, MAX_DETAIL_METADATA_BYTES / 2);
    const diagnostics = boundedItems(parsed.diagnostics, MAX_DETAIL_METADATA_BYTES / 8, 200);
    return {
      artifact: {
        source: selected?.source ?? sourceRef(artifact),
        markdown: rendered.markdown, requirements: requirements.items,
        ...(selected && { section: selected.section }),
      },
      diagnostics: diagnostics.items,
      partial: rendered.truncated || requirements.truncated || diagnostics.truncated,
    };
  }
}

export async function readOpenSpec(root: string): Promise<OpenSpecSnapshot> {
  const initial = await scanOpenSpec(root);
  const changed = initial.diagnostics.some((diagnostic) => diagnostic.code === "source-changed");
  return new CheckoutOpenSpec(changed ? await scanOpenSpec(root) : initial);
}
