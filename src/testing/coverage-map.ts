// Coverage-map Test Impact Analysis (Block D · D2; specification.md §7.2, §8.2).
//
// Builds/loads a deterministic `testFile → { coveredFiles[], coveredLines? }`
// map parsed from EXISTING coverage output (lcov and/or V8/bun JSON) — no
// bespoke instrumentation on the default path and NO new dependency. Any raw
// coverage stdout that is persisted is routed through the security write seam
// (`guardOutput`/`redactRaw`, AC18); the normalized `coverage-map.json` itself
// contains only file paths and line numbers.
//
// The static changed-file selection stays the byte-identical default: this
// module is only consulted when the `coverageMap` capability is enabled AND a
// map is present (see `service.ts`). `loadCoverageMap` returns `null` (never
// throws) when the map is absent/malformed ⇒ the caller runs its static path.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { guardOutput, redactRaw, formatGuardWarning } from "../security/guard";
import type { CoverageMap, CoverageMapEntry, TestingConfig } from "./types";

const COVERAGE_MAP_SCHEMA_VERSION = 1 as const;

export function coverageMapPath(cwd: string, cfg: TestingConfig): string {
  return path.isAbsolute(cfg.coverageMap.artifact)
    ? cfg.coverageMap.artifact
    : path.join(cwd, cfg.coverageMap.artifact);
}

// Load + validate the persisted map. Missing OR malformed ⇒ `null` (the caller
// falls back to static selection). Never throws (`C0-5` degrade-not-fail).
export async function loadCoverageMap(cwd: string, cfg: TestingConfig): Promise<CoverageMap | null> {
  const file = coverageMapPath(cwd, cfg);
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as CoverageMap;
    if (!parsed || typeof parsed !== "object" || typeof parsed.map !== "object") {
      return null;
    }
    return normalizeCoverageMap(parsed.map, parsed.gitRef ?? null, parsed.generatedAt);
  } catch {
    return null;
  }
}

// Normalize a raw map into a deterministic CoverageMap: sorted test keys,
// sorted+de-duplicated `coveredFiles`, sorted line arrays. Re-normalizing an
// already-normalized map is a fixed point (re-build ⇒ identical file, AC7).
export function normalizeCoverageMap(
  raw: Record<string, CoverageMapEntry>,
  gitRef: string | null,
  generatedAt: string,
): CoverageMap {
  const map: Record<string, CoverageMapEntry> = {};
  for (const testFile of Object.keys(raw).sort()) {
    const entry = raw[testFile];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const coveredFiles = Array.from(new Set(entry.coveredFiles ?? [])).sort();
    const normalized: CoverageMapEntry = { coveredFiles };
    if (entry.coveredLines && typeof entry.coveredLines === "object") {
      const lines: Record<string, number[]> = {};
      for (const file of Object.keys(entry.coveredLines).sort()) {
        const nums = Array.from(new Set(entry.coveredLines[file] ?? []))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
        lines[file] = nums;
      }
      normalized.coveredLines = lines;
    }
    map[testFile] = normalized;
  }
  return { schemaVersion: COVERAGE_MAP_SCHEMA_VERSION, generatedAt, gitRef, map };
}

// Serialize a CoverageMap deterministically (stable key/array ordering) so a
// re-build yields a byte-identical file (`XP4`, `F-2`).
export function serializeCoverageMap(map: CoverageMap): string {
  const normalized = normalizeCoverageMap(map.map, map.gitRef, map.generatedAt);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

// --- parsers (pure; parse EXISTING coverage output) -----------------------

// Parse an lcov report into a covered-file → covered-lines map. A `DA:line,hits`
// with hits > 0 marks the line covered; a file with any covered line is covered.
export function parseLcov(text: string): Map<string, number[]> {
  const covered = new Map<string, number[]>();
  let current: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      current = normalizePath(line.slice(3));
      if (!covered.has(current)) {
        covered.set(current, []);
      }
      continue;
    }
    if (line.startsWith("DA:") && current) {
      const [num, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) {
        covered.get(current)?.push(Number(num));
      }
      continue;
    }
    if (line === "end_of_record") {
      current = null;
    }
  }
  // Drop files with zero covered lines.
  for (const [file, lines] of covered) {
    if (lines.length === 0) {
      covered.delete(file);
    }
  }
  return covered;
}

// Parse a V8/bun `--coverage` JSON report. Accepts the bun/istanbul-style shape
// `{ "<file>": { lines: { "<n>": hits } } }` or a V8 `{ result: [{ url, ... }] }`
// coarse shape (file-level). Returns covered file → covered line numbers.
export function parseV8Json(json: unknown): Map<string, number[]> {
  const covered = new Map<string, number[]>();
  if (!json || typeof json !== "object") {
    return covered;
  }
  const root = json as Record<string, unknown>;
  // istanbul/bun-style: file → { lines: { n: hits } } or { s: { id: hits }, statementMap }
  for (const [file, value] of Object.entries(root)) {
    if (file === "result" || !value || typeof value !== "object") {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const lines = entry.lines as Record<string, number> | undefined;
    if (lines && typeof lines === "object") {
      const hit = Object.entries(lines)
        .filter(([, hits]) => Number(hits) > 0)
        .map(([n]) => Number(n))
        .filter((n) => Number.isFinite(n));
      if (hit.length > 0) {
        covered.set(normalizePath(file), hit);
      }
    }
  }
  return covered;
}

// --- selection -------------------------------------------------------------

// Select tests whose covered set intersects the changed files. Line-level when
// both sides carry lines, else file-level. Deterministic (sorted output).
export function selectByCoverageMap(
  changedFiles: string[],
  map: CoverageMap,
  changedLines?: Map<string, number[]>,
): { selectedTests: string[]; strategy: "coverage-map" } {
  const changed = new Set(changedFiles.map(normalizePath));
  const selected = new Set<string>();
  for (const [testFile, entry] of Object.entries(map.map)) {
    const intersects = entry.coveredFiles.some((file) => {
      const normalized = normalizePath(file);
      if (!changed.has(normalized)) {
        return false;
      }
      const wantLines = changedLines?.get(normalized);
      const haveLines = entry.coveredLines?.[normalized];
      if (wantLines && wantLines.length > 0 && haveLines && haveLines.length > 0) {
        return wantLines.some((line) => haveLines.includes(line));
      }
      return true; // file-level intersection
    });
    if (intersects) {
      selected.add(testFile);
    }
  }
  return { selectedTests: Array.from(selected).sort(), strategy: "coverage-map" };
}

// The set of source files present anywhere in the map (used to detect changed
// files that are absent from the map so the caller can fall back for them).
export function coveredFilesInMap(map: CoverageMap): Set<string> {
  const files = new Set<string>();
  for (const entry of Object.values(map.map)) {
    for (const file of entry.coveredFiles) {
      files.add(normalizePath(file));
    }
  }
  return files;
}

// --- build -----------------------------------------------------------------

// Build a coverage map. Import mode parses an existing report at
// `coverageMap.path` (no test run — honors "no mandatory instrumentation on the
// default path"). Build modes run the suite with coverage. Any persisted raw
// coverage log passes through the security write seam.
export async function buildCoverageMap(
  cwd: string,
  cfg: TestingConfig,
  input: { testFiles: string[]; gitRef?: string | null } = { testFiles: [] },
): Promise<{ map: CoverageMap; securityWarnings: string[]; path: string }> {
  const securityWarnings: string[] = [];
  const source = cfg.coverageMap.source;
  const generatedAt = new Date().toISOString();
  const gitRef = input.gitRef ?? null;

  let raw = "";
  const perTest: Record<string, CoverageMapEntry> = {};

  if (source === "import" || source === "auto") {
    const reportPath = path.isAbsolute(cfg.coverageMap.path)
      ? cfg.coverageMap.path
      : path.join(cwd, cfg.coverageMap.path);
    if (await pathExists(reportPath)) {
      raw = await readFile(reportPath, "utf8");
      const covered = reportPath.endsWith(".json")
        ? parseV8Json(safeJson(raw))
        : parseLcov(raw);
      // Import mode has no per-test attribution; attribute the aggregate to a
      // single synthetic "suite" entry so map-present files are still detected.
      const coveredFiles = Array.from(covered.keys()).sort();
      if (coveredFiles.length > 0) {
        const coveredLines: Record<string, number[]> = {};
        for (const [file, lines] of covered) {
          coveredLines[file] = cfg.coverageMap.lineGranularity ? lines.slice().sort((a, b) => a - b) : [];
        }
        perTest["<suite>"] = cfg.coverageMap.lineGranularity
          ? { coveredFiles, coveredLines }
          : { coveredFiles };
      }
    }
  }

  // Persist any raw coverage output through the security write seam (AC18).
  if (raw.length > 0) {
    const guard = await guardOutput({ cwd, content: raw, target: "report", source: "tool-output" });
    if (guard.allowed) {
      await writeRawCoverageLog(cwd, (await redactRaw({ cwd, content: raw, source: "tool-output" })).content);
      const warning = formatGuardWarning(guard.decision, "testing");
      if (warning) {
        securityWarnings.push(warning);
      }
    } else {
      securityWarnings.push(`raw coverage log not persisted: ${guard.reason ?? "security gate blocked"}`);
    }
  }

  const map = normalizeCoverageMap(perTest, gitRef, generatedAt);
  const outPath = coverageMapPath(cwd, cfg);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeCoverageMap(map), "utf8");
  return { map, securityWarnings, path: outPath };
}

async function writeRawCoverageLog(cwd: string, content: string): Promise<void> {
  const logs = path.join(cwd, ".metaproject", "data", "testing", "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, "coverage.raw.log"), content, "utf8");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
