import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryReportInput, MemoryReportResult, MemorySearchReport, SearchFilters } from "./types";
import { isValidCalendarDate } from "./temporal";
import { MAX_QUERY_BYTES } from "./validation";

const MAX_QUERY_LENGTH = MAX_QUERY_BYTES;
const MAX_RUN_ID_LENGTH = 128;
const MAX_RESULTS = 100;
const MAX_PATH_LENGTH = 1024;
const MAX_TITLE_LENGTH = 512;
const MAX_TYPE_LENGTH = 128;
const MAX_REASON_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 2000;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const STALE_STAGING_MS = 60_000;
const STATUSES = new Set(["draft", "accepted", "deprecated", "conflict", "superseded"]);
const CLASSES = new Set(["semantic", "episodic", "procedural"]);

export type MemoryReportStoreDependencies = {
  clock?: () => Date;
  runId?: () => string;
};

function runtimeRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "runtime", "memory");
}

function bounded(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}`, "utf8") > maximum) break;
    output += character;
  }
  return output;
}

function cleanFilters(filters: SearchFilters): SearchFilters {
  return {
    ...(filters.module !== undefined ? { module: bounded(filters.module, 256) } : {}),
    ...(filters.entity !== undefined ? { entity: bounded(filters.entity, 256) } : {}),
    ...(filters.status !== undefined ? { status: filters.status } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.asOf !== undefined ? { asOf: filters.asOf } : {}),
    ...(filters.class !== undefined ? { class: filters.class } : {}),
    ...(filters.semantic !== undefined ? { semantic: filters.semantic } : {}),
  };
}

function relativeMemoryPath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  if (!normalized || path.isAbsolute(value) || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Memory report paths must be memory-root-relative");
  }
  return bounded(normalized, MAX_PATH_LENGTH);
}

/** Creates the bounded projection defined by memory-search-report.schema.json. */
export function renderMemorySearchReport(input: {
  runId: string;
  generatedAt: Date;
  search: MemoryReportInput["search"];
  filters: SearchFilters;
}): MemorySearchReport {
  const report: MemorySearchReport = {
    schemaVersion: 1,
    runId: bounded(input.runId, MAX_RUN_ID_LENGTH),
    query: bounded(input.search.query, MAX_QUERY_LENGTH),
    generatedAt: input.generatedAt.toISOString(),
    filters: cleanFilters(input.filters),
    results: input.search.results.slice(0, MAX_RESULTS).map((scored) => ({
      path: relativeMemoryPath(scored.entry.relativePath),
      title: bounded(scored.entry.title, MAX_TITLE_LENGTH),
      type: bounded(scored.entry.type, MAX_TYPE_LENGTH),
      status: scored.entry.status,
      score: scored.score,
      reason: bounded(scored.reason, MAX_REASON_LENGTH),
      summary: bounded(scored.entry.summary, MAX_SUMMARY_LENGTH),
    })),
  };
  const errors = validateMemorySearchReport(report);
  if (errors.length > 0) throw new Error(`Invalid memory search report: ${errors.join("; ")}`);
  return report;
}

/** Local dependency-free validation matching the checked-in report schema. */
export function validateMemorySearchReport(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["report must be an object"];
  const report = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "runId", "query", "generatedAt", "filters", "results"]);
  for (const key of Object.keys(report)) if (!allowed.has(key)) errors.push(`unexpected property: ${key}`);
  if (report.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof report.runId !== "string" || !RUN_ID_PATTERN.test(report.runId) || report.runId.length > MAX_RUN_ID_LENGTH) errors.push("runId is invalid");
  if (typeof report.query !== "string" || Buffer.byteLength(report.query, "utf8") > MAX_QUERY_LENGTH) errors.push("query is invalid");
  if (typeof report.generatedAt !== "string" || Number.isNaN(Date.parse(report.generatedAt))) errors.push("generatedAt is invalid");
  if (!report.filters || typeof report.filters !== "object" || Array.isArray(report.filters)) {
    errors.push("filters is invalid");
  } else {
    const filters = report.filters as Record<string, unknown>;
    const allowedFilters = new Set(["module", "entity", "status", "limit", "asOf", "class", "semantic"]);
    for (const key of Object.keys(filters)) if (!allowedFilters.has(key)) errors.push(`unexpected filter: ${key}`);
    if (filters.module !== undefined && (typeof filters.module !== "string" || filters.module.length > 256)) errors.push("module is invalid");
    if (filters.entity !== undefined && (typeof filters.entity !== "string" || filters.entity.length > 256)) errors.push("entity is invalid");
    if (filters.status !== undefined && (typeof filters.status !== "string" || !STATUSES.has(filters.status))) errors.push("status is invalid");
    if (filters.limit !== undefined && (!Number.isInteger(filters.limit) || (filters.limit as number) < 1 || (filters.limit as number) > MAX_RESULTS)) errors.push("limit is invalid");
    if (filters.asOf !== undefined && (typeof filters.asOf !== "string" || !isValidCalendarDate(filters.asOf))) errors.push("asOf is invalid");
    if (filters.class !== undefined && (typeof filters.class !== "string" || !CLASSES.has(filters.class))) errors.push("class is invalid");
    if (filters.semantic !== undefined && typeof filters.semantic !== "boolean") errors.push("semantic is invalid");
  }
  if (!Array.isArray(report.results) || report.results.length > MAX_RESULTS) {
    errors.push("results is invalid");
  } else {
    for (const result of report.results) {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        errors.push("result is invalid");
        continue;
      }
      const item = result as Record<string, unknown>;
      const allowedResult = new Set(["path", "title", "type", "status", "score", "reason", "summary"]);
      for (const key of Object.keys(item)) if (!allowedResult.has(key)) errors.push(`unexpected result property: ${key}`);
      if (typeof item.path !== "string" || !item.path || item.path.length > MAX_PATH_LENGTH || path.isAbsolute(item.path) || item.path.includes("..")) errors.push("result path is invalid");
      if (typeof item.title !== "string" || item.title.length > MAX_TITLE_LENGTH) errors.push("result title is invalid");
      if (typeof item.type !== "string" || item.type.length > MAX_TYPE_LENGTH) errors.push("result type is invalid");
      if (typeof item.status !== "string" || !STATUSES.has(item.status)) errors.push("result status is invalid");
      if (typeof item.score !== "number" || !Number.isFinite(item.score)) errors.push("result score is invalid");
      if (typeof item.reason !== "string" || item.reason.length > MAX_REASON_LENGTH) errors.push("result reason is invalid");
      if (typeof item.summary !== "string" || item.summary.length > MAX_SUMMARY_LENGTH) errors.push("result summary is invalid");
    }
  }
  return errors;
}

export function renderMemorySearchReportMarkdown(report: MemorySearchReport): string {
  const lines = [
    `# memory search report: ${report.query}`,
    "",
    `runId: ${report.runId}`,
    `generatedAt: ${report.generatedAt}`,
    `results: ${report.results.length}`,
    "",
  ];
  for (const [index, result] of report.results.entries()) {
    lines.push(`${index + 1}. [${result.score}] ${result.title} (${result.type}/${result.status}) - ${result.path}`);
    if (result.summary) lines.push(`   ${result.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class MemoryReportStore {
  private readonly clock: () => Date;
  private readonly nextRunId: () => string;

  constructor(dependencies: MemoryReportStoreDependencies = {}) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.nextRunId = dependencies.runId ?? (() => randomUUID());
  }

  async writeReport(input: MemoryReportInput): Promise<MemoryReportResult> {
    const runId = input.runId ?? this.nextRunId();
    if (!RUN_ID_PATTERN.test(runId) || runId.length > MAX_RUN_ID_LENGTH) throw new Error("Invalid memory report run ID");
    const report = renderMemorySearchReport({ runId, generatedAt: this.clock(), search: input.search, filters: input.filters ?? {} });
    const root = runtimeRoot(input.cwd);
    const searchRoot = path.join(root, "search");
    const tempRoot = path.join(root, "tmp");
    const destination = path.join(searchRoot, runId);
    if (await exists(destination)) throw new Error(`Memory report run already exists: ${runId}`);
    await mkdir(searchRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    const staleBefore = this.clock().getTime() - STALE_STAGING_MS;
    for (const name of await readdir(tempRoot)) {
      const candidate = path.join(tempRoot, name);
      if ((await stat(candidate)).mtimeMs <= staleBefore) await rm(candidate, { recursive: true, force: true });
    }
    const staging = path.join(tempRoot, `${runId}.${randomUUID()}`);
    try {
      await mkdir(staging);
      await Promise.all([
        writeFile(path.join(staging, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
        writeFile(path.join(staging, "report.md"), renderMemorySearchReportMarkdown(report), "utf8"),
      ]);
      if (await exists(destination)) throw new Error(`Memory report run already exists: ${runId}`);
      await rename(staging, destination);
    } catch (cause) {
      await rm(staging, { recursive: true, force: true });
      throw cause;
    }
    return {
      runId,
      markdownPath: path.relative(input.cwd, path.join(destination, "report.md")),
      jsonPath: path.relative(input.cwd, path.join(destination, "report.json")),
    };
  }
}

export function createMemoryReportStore(dependencies: MemoryReportStoreDependencies = {}): MemoryReportStore {
  return new MemoryReportStore(dependencies);
}
