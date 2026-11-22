import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, opendirSync, type BigIntStats, type Dir } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { DescriptorReadError, readDescriptorChain } from "../lib/descriptor-read";

export type OpenSpecKind = "spec" | "change" | "archive";
export type OpenSpecAvailability = "missing" | "empty" | "ready" | "partial" | "unavailable";

export interface OpenSpecArtifact {
  path: string;
  markdown: string;
  digest: string;
}

export interface OpenSpecEntry {
  id: string;
  kind: OpenSpecKind;
  title: string;
  path: string;
  archiveDate?: string;
  artifacts: OpenSpecArtifact[];
}

export interface OpenSpecDiagnostic {
  code: string;
  message: string;
  path?: string;
  index?: number;
  retryable?: boolean;
}

export interface OpenSpecLink {
  source: { kind: "spec" | "change"; path: string };
  target: { kind: "wiki" | "file" | "module"; path: string };
  index: number;
  path: string;
  digest: string;
}

export interface OpenSpecCatalog {
  snapshotId: string;
  availability: OpenSpecAvailability;
  counts: Record<OpenSpecKind, number>;
  entries: OpenSpecEntry[];
  links: OpenSpecLink[];
  diagnostics: OpenSpecDiagnostic[];
  truncated: boolean;
}

export interface OpenSpecScanOptions {
  signal?: AbortSignal;
  hooks?: { beforeOpen?: (relativePath: string) => Promise<void> | void };
}

const SPEC_ROOT = "openspec/specs";
const CHANGE_ROOT = "openspec/changes";
const ARCHIVE_ROOT = "openspec/changes/archive";
const LINK_PATH = ".metaproject/openspec/links.json";
const MAX_DISCOVERY_ENTRIES = 10_000;
// Each earlier collection gets this share plus one lookahead. Archive gets the remainder.
const RESERVED_COLLECTION_ENTRIES = Math.floor(MAX_DISCOVERY_ENTRIES / 3) - 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * MAX_FILE_BYTES;
const MAX_DEPTH = 12;
const MAX_DIAGNOSTICS = 200;
const MAX_LINK_ROWS = 2000;
const METADATA_YIELD_INTERVAL = 128;
const DIAGNOSTIC_LIMIT = "diagnostic-limit";

class SourceChanged extends Error {
  constructor(readonly relativePath: string) {
    super("OpenSpec source changed during discovery. Refresh to retry.");
  }
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

function compareArchives(left: OpenSpecEntry, right: OpenSpecEntry): number {
  return comparePaths(right.archiveDate ?? "", left.archiveDate ?? "")
    || comparePaths(left.path, right.path);
}

function archiveDate(name: string): string | undefined {
  const date = /^(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1];
  if (!date || date.startsWith("0000")) return undefined;
  const timestamp = Date.parse(date);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return undefined;
  return date;
}

function checkedPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 1024
    // eslint-disable-next-line no-control-regex -- control characters are forbidden in source paths
    || /^[a-z]:/i.test(value) || /[\\\x00-\x1f\x7f]/.test(value)) return false;
  return value.split("/").every((component) => component !== "" && component !== "." && component !== "..");
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameVersion(left: BigIntStats | undefined, right: BigIntStats | undefined): boolean {
  if (!left || !right) return left === right;
  return sameNode(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function statOrMissing(absolutePath: string): BigIntStats | undefined {
  try {
    return lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function snapshot(
  rootKey: string, availability: OpenSpecAvailability, entries: OpenSpecEntry[],
  diagnostics: OpenSpecDiagnostic[], options: { links?: OpenSpecLink[]; linkDigest?: string; truncated?: boolean } = {},
): OpenSpecCatalog {
  const counts = { spec: 0, change: 0, archive: 0 };
  const evidence = entries.map(({ id, kind, artifacts }) => {
    counts[kind]++;
    return [id, artifacts.map(({ path: artifactPath, digest: hash }) => [artifactPath, hash])];
  });
  return {
    snapshotId: digest(JSON.stringify([rootKey, availability, evidence, options.linkDigest, diagnostics])),
    availability,
    counts,
    entries,
    links: options.links ?? [],
    diagnostics,
    truncated: options.truncated ?? false,
  };
}

/** Discover text from one authorized checkout. Inputs that changed are discarded together. */
export async function scanOpenSpec(root: string, options: OpenSpecScanOptions = {}): Promise<OpenSpecCatalog> {
  const requestedRoot = path.resolve(root);
  options.signal?.throwIfAborted();
  let canonicalRoot: string;
  let rootIdentity: BigIntStats;
  try {
    rootIdentity = lstatSync(requestedRoot, { bigint: true });
    if (!rootIdentity.isDirectory()) {
      return snapshot(requestedRoot, "unavailable", [], [rootUnavailable()]);
    }
    canonicalRoot = await realpath(requestedRoot);
    const canonicalIdentity = lstatSync(canonicalRoot, { bigint: true });
    if (!sameNode(rootIdentity, canonicalIdentity)) {
      return snapshot(requestedRoot, "unavailable", [], [rootUnavailable()]);
    }
  } catch {
    return snapshot(requestedRoot, "unavailable", [], [rootUnavailable()]);
  }

  const scan = new CheckoutScan(canonicalRoot, rootIdentity, options);
  try {
    return await scan.run();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof SourceChanged)) throw error;
    return snapshot(scan.rootKey, "partial", [], [{
      code: "source-changed",
      message: error.message,
      ...(error.relativePath && { path: error.relativePath }),
      retryable: true,
    }]);
  }
}

function rootUnavailable(): OpenSpecDiagnostic {
  return { code: "root-unavailable", message: "The authorized checkout is unavailable." };
}

interface CollectionBudget {
  remaining: number;
  limitReported: boolean;
}

class CheckoutScan {
  readonly rootKey: string;
  private readonly checked = new Map<string, BigIntStats | undefined>();
  private readonly diagnostics: OpenSpecDiagnostic[] = [];
  private remainingDiscoveryEntries = MAX_DISCOVERY_ENTRIES;
  private metadataProbes = 0;
  private admittedBytes = 0;
  private linkDigest?: string;
  private truncated = false;

  constructor(
    private readonly root: string,
    private readonly rootIdentity: BigIntStats,
    private readonly options: OpenSpecScanOptions,
  ) {
    this.rootKey = JSON.stringify([root, String(rootIdentity.dev), String(rootIdentity.ino)]);
  }

  async run(): Promise<OpenSpecCatalog> {
    const source = await this.directory("openspec");
    if (!source) {
      this.assertCoherent();
      return snapshot(this.rootKey, this.diagnostics.length ? "unavailable" : "missing", [], this.diagnostics);
    }
    const entries = [
      ...await this.currentSpecs(),
      ...await this.changes("change", CHANGE_ROOT),
      ...await this.changes("archive", ARCHIVE_ROOT),
    ];
    const links = await this.declaredLinks(entries);
    this.assertCoherent();
    const availability = this.diagnostics.length ? "partial" : entries.length ? "ready" : "empty";
    return snapshot(this.rootKey, availability, entries, this.diagnostics, {
      links, ...(this.linkDigest && { linkDigest: this.linkDigest }), truncated: this.truncated,
    });
  }

  private async currentSpecs(): Promise<OpenSpecEntry[]> {
    const budget = { remaining: RESERVED_COLLECTION_ENTRIES, limitReported: false };
    const entries: OpenSpecEntry[] = [];
    for (const capability of await this.children(SPEC_ROOT, budget)) {
      const capabilityPath = `${SPEC_ROOT}/${capability}`;
      if (!await this.directory(capabilityPath, "listed")) continue;
      const artifactPath = `${capabilityPath}/spec.md`;
      if (!this.takeEntry(artifactPath, budget)) break;
      const artifact = await this.artifact(artifactPath);
      if (artifact) entries.push(entry("spec", capability, artifactPath, [artifact]));
    }
    return entries;
  }

  private async changes(kind: "change" | "archive", collectionPath: string): Promise<OpenSpecEntry[]> {
    if (kind === "archive" && !await this.directory(CHANGE_ROOT)) return [];
    const remaining = kind === "archive" ? this.remainingDiscoveryEntries - 1 : RESERVED_COLLECTION_ENTRIES;
    const budget = { remaining, limitReported: false };
    const entries: OpenSpecEntry[] = [];
    for (const name of await this.children(collectionPath, budget)) {
      if (kind === "change" && name === "archive") continue;
      const entryPath = `${collectionPath}/${name}`;
      if (!await this.directory(entryPath, "listed")) continue;
      entries.push(entry(kind, name, entryPath, await this.artifacts(entryPath, budget, true)));
    }
    return kind === "archive" ? entries.sort(compareArchives) : entries;
  }

  private async artifacts(directory: string, budget: CollectionBudget, directoryChecked = false): Promise<OpenSpecArtifact[]> {
    const artifacts: OpenSpecArtifact[] = [];
    for (const name of await this.children(directory, budget, directoryChecked)) {
      const relativePath = `${directory}/${name}`;
      const source = await this.inspect(relativePath, "listed");
      if (!source) continue;
      if (relativePath.split("/").length - 1 > MAX_DEPTH) {
        this.limit("path-depth", relativePath, "OpenSpec source exceeds the path depth limit.");
      } else if (source.isDirectory()) {
        artifacts.push(...await this.artifacts(relativePath, budget));
      } else if (source.isFile()) {
        if (/\.md$/i.test(name)) {
          const artifact = await this.artifact(relativePath, source);
          if (artifact) artifacts.push(artifact);
        }
      } else {
        this.warn("source-not-regular", relativePath, "OpenSpec source is not a regular file or directory.");
      }
    }
    return artifacts;
  }

  private async artifact(relativePath: string, source?: BigIntStats): Promise<OpenSpecArtifact | undefined> {
    const bytes = await this.read(relativePath, source);
    return bytes && { path: relativePath, markdown: bytes.toString("utf8"), digest: digest(bytes) };
  }

  private async declaredLinks(entries: OpenSpecEntry[]): Promise<OpenSpecLink[]> {
    if (!await this.directory(".metaproject") || !await this.directory(".metaproject/openspec")) return [];
    const bytes = await this.read(LINK_PATH);
    if (!bytes) return [];
    this.linkDigest = digest(bytes);
    return parseLinks(bytes, this.linkDigest, entries, (diagnostic) => this.addDiagnostic(diagnostic));
  }

  private async inspect(relativePath: string, existence?: "listed"): Promise<BigIntStats | undefined> {
    // Metadata and descriptor reads are local syscalls. Yield periodically
    // without scheduling a separate filesystem promise for every path component.
    if (++this.metadataProbes % METADATA_YIELD_INTERVAL === 0) await yieldToEventLoop();
    this.options.signal?.throwIfAborted();
    if (!checkedPath(relativePath)) {
      this.warn("invalid-source-path", undefined, "An OpenSpec source path is invalid.");
      return undefined;
    }
    let source: BigIntStats | undefined;
    try {
      source = statOrMissing(path.join(this.root, relativePath));
    } catch {
      this.warn("source-read-failed", relativePath, "OpenSpec source metadata is unavailable.");
      return undefined;
    }
    if ((this.checked.has(relativePath) && !sameVersion(this.checked.get(relativePath), source))
      || (existence === "listed" && !source)) throw new SourceChanged(relativePath);
    this.checked.set(relativePath, source);
    if (source?.isSymbolicLink()) {
      this.warn("source-symlink", relativePath, "OpenSpec symbolic links are skipped.");
      return undefined;
    }
    return source;
  }

  private async directory(relativePath: string, existence?: "listed"): Promise<boolean> {
    const source = await this.inspect(relativePath, existence);
    if (!source) return false;
    if (!source.isDirectory()) {
      if (!existence || !source.isFile()) {
        this.warn("source-not-directory", relativePath, "OpenSpec source is not a directory.");
      }
      return false;
    }
    try {
      accessSync(path.join(this.root, relativePath), constants.R_OK | constants.X_OK);
      return true;
    } catch {
      this.warn("source-read-failed", relativePath, "OpenSpec directory is unreadable.");
      return false;
    }
  }

  private async children(relativePath: string, budget: CollectionBudget, directoryChecked = false): Promise<string[]> {
    if (budget.remaining === 0) {
      this.reportEntryLimit(relativePath, budget);
      return [];
    }
    if (!directoryChecked && !await this.directory(relativePath)) return [];
    let directory: Dir;
    try {
      this.assertUnchanged(relativePath);
      directory = opendirSync(path.join(this.root, relativePath));
    } catch (error) {
      if (error instanceof SourceChanged) throw error;
      this.warn("source-read-failed", relativePath, "OpenSpec directory is unreadable.");
      return [];
    }
    return this.directoryNames(directory, relativePath, budget);
  }

  private directoryNames(directory: Dir, relativePath: string, budget: CollectionBudget): string[] {
    const names: string[] = [];
    try {
      // Refuse an over-budget directory as a unit so OS enumeration order cannot affect admission.
      for (;;) {
        this.options.signal?.throwIfAborted();
        const child = directory.readSync();
        if (!child) return names.sort(comparePaths);
        if (!this.takeEntry(relativePath, budget)) return [];
        names.push(child.name);
      }
    } catch (error) {
      this.options.signal?.throwIfAborted();
      if (error instanceof SourceChanged) throw error;
      this.warn("source-read-failed", relativePath, "OpenSpec directory could not be enumerated.");
      return [];
    } finally {
      directory.closeSync();
    }
  }

  private takeEntry(relativePath: string, budget: CollectionBudget): boolean {
    // Charge the over-limit candidate as well as admitted entries.
    this.remainingDiscoveryEntries--;
    if (budget.remaining > 0) {
      budget.remaining--;
      return true;
    }
    this.reportEntryLimit(relativePath, budget);
    return false;
  }

  private reportEntryLimit(relativePath: string, budget: CollectionBudget): void {
    if (!budget.limitReported) {
      this.limit("scan-limit", relativePath, "OpenSpec collection exceeds the discovery entry limit.");
      budget.limitReported = true;
    }
  }

  private async read(relativePath: string, observed?: BigIntStats): Promise<Buffer | undefined> {
    const source = observed ?? await this.inspect(relativePath);
    if (!source) return undefined;
    if (!source.isFile()) {
      this.warn("source-not-regular", relativePath, "OpenSpec source is not a regular file.");
      return undefined;
    }
    if (source.size > MAX_FILE_BYTES) {
      this.limit("file-limit", relativePath, "OpenSpec source exceeds the text file byte limit.");
      return undefined;
    }
    if (source.size > MAX_TOTAL_BYTES - this.admittedBytes) {
      this.limit("snapshot-limit", relativePath, "OpenSpec snapshot exceeds the total text byte limit.");
      return undefined;
    }
    try {
      await this.options.hooks?.beforeOpen?.(relativePath);
      // The descriptor walk pins the root and leaf and refuses symlinks in
      // every component. The final observation checks the ancestor versions
      // together with the rest of the snapshot before admitting any results.
      const bytes = readDescriptorChain(this.root, path.join(this.root, relativePath), {
        maxBytes: Number(source.size),
        requireRegularFile: true,
        expectedRootIdentity: this.rootIdentity,
        expectedTargetIdentity: source,
      });
      if (bytes.length !== Number(source.size)) throw new SourceChanged(relativePath);
      this.admittedBytes += bytes.length;
      return bytes;
    } catch (error) {
      this.options.signal?.throwIfAborted();
      this.assertPath(relativePath);
      if (error instanceof SourceChanged) throw error;
      if (error instanceof DescriptorReadError && (error.code === "race" || error.code === "too-large")) throw new SourceChanged(relativePath);
      this.warn("source-read-failed", relativePath, "OpenSpec text could not be read safely.");
      return undefined;
    }
  }

  private assertPath(relativePath: string): void {
    this.assertRoot();
    const components = relativePath.split("/");
    for (let index = 1; index <= components.length; index++) {
      const ancestor = components.slice(0, index).join("/");
      this.assertUnchanged(ancestor);
    }
  }

  private assertCoherent(): void {
    this.assertRoot();
    for (const relativePath of this.checked.keys()) this.assertUnchanged(relativePath);
    this.assertRoot();
  }

  private assertRoot(): void {
    this.options.signal?.throwIfAborted();
    const root = this.observedStat("");
    if (!root || !sameNode(this.rootIdentity, root)) throw new SourceChanged("");
  }

  private assertUnchanged(relativePath: string): void {
    this.options.signal?.throwIfAborted();
    if (!this.checked.has(relativePath)) return;
    if (!sameVersion(this.checked.get(relativePath), this.observedStat(relativePath))) {
      throw new SourceChanged(relativePath);
    }
  }

  private observedStat(relativePath: string): BigIntStats | undefined {
    try {
      return statOrMissing(path.join(this.root, relativePath));
    } catch {
      throw new SourceChanged(relativePath);
    }
  }

  private limit(code: string, relativePath: string, message: string): void {
    this.truncated = true;
    this.warn(code, relativePath, message);
  }

  private warn(code: string, relativePath: string | undefined, message: string): void {
    this.addDiagnostic({ code, message, ...(relativePath && { path: relativePath }) });
  }

  private addDiagnostic(diagnostic: OpenSpecDiagnostic): void {
    if (this.diagnostics.length < MAX_DIAGNOSTICS - 1) {
      this.diagnostics.push(diagnostic);
    } else if (this.diagnostics.at(-1)?.code !== DIAGNOSTIC_LIMIT) {
      this.diagnostics.push({ code: DIAGNOSTIC_LIMIT, message: "Additional OpenSpec diagnostics were omitted." });
    }
  }
}

function entry(kind: OpenSpecKind, title: string, relativePath: string, artifacts: OpenSpecArtifact[]): OpenSpecEntry {
  const date = kind === "archive" ? archiveDate(title) : undefined;
  return {
    id: digest(JSON.stringify([kind, relativePath])),
    kind, title, path: relativePath, artifacts,
    ...(date && { archiveDate: date }),
  };
}

function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseLinkEndpoint(value: unknown): { kind: unknown; path: string } | undefined {
  if (!exactRecord(value, ["kind", "path"]) || !checkedPath(value.path)) return undefined;
  return { kind: value.kind, path: value.path };
}

function parseLinkRow(row: unknown, index: number, hash: string): OpenSpecLink | undefined {
  if (!exactRecord(row, ["source", "target"])) return undefined;
  const source = parseLinkEndpoint(row.source);
  const target = parseLinkEndpoint(row.target);
  if (!source || (source.kind !== "spec" && source.kind !== "change")) return undefined;
  if (!target || (target.kind !== "wiki" && target.kind !== "file" && target.kind !== "module")) return undefined;
  return {
    source: { kind: source.kind, path: source.path },
    target: { kind: target.kind, path: target.path },
    path: LINK_PATH, digest: hash, index,
  };
}

function linkRows(bytes: Buffer, report: (diagnostic: OpenSpecDiagnostic) => void): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    report({ code: "links-invalid-json", path: LINK_PATH, message: "OpenSpec link configuration is not valid JSON." });
    return [];
  }
  if (!exactRecord(value, ["version", "links"]) || !Array.isArray(value.links) || value.links.length > MAX_LINK_ROWS) {
    report({ code: "links-invalid-envelope", path: LINK_PATH, message: "OpenSpec link configuration has an invalid envelope or exceeds the row limit." });
    return [];
  }
  if (value.version !== 1) {
    report({ code: "links-unsupported-version", path: LINK_PATH, message: "OpenSpec link configuration has an unsupported version." });
    return [];
  }
  return value.links;
}

function parseLinks(
  bytes: Buffer, hash: string, entries: OpenSpecEntry[], report: (diagnostic: OpenSpecDiagnostic) => void,
): OpenSpecLink[] {
  const sources = new Map(entries.map((entry) => [entry.path, entry.kind === "archive" ? "change" : entry.kind]));
  const links: OpenSpecLink[] = [];
  for (const [index, row] of linkRows(bytes, report).entries()) {
    const link = parseLinkRow(row, index, hash);
    if (!link) {
      report({ code: "link-invalid-row", path: LINK_PATH, index, message: "OpenSpec link row is invalid." });
    } else if (sources.get(link.source.path) !== link.source.kind) {
      report({ code: "link-source-not-found", path: LINK_PATH, index, message: "OpenSpec link source was not discovered." });
    } else {
      links.push(link);
    }
  }
  return links;
}
