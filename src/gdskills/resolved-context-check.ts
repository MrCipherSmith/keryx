// Checks a worker's `project_context_applied` against the resolver output the
// worker was dispatched with: every `must_read` entry has to be cited with the
// sha256 the resolver pinned, and no resolved file may have changed since (the
// standard must not move between the RED and the GREEN commit). An entry promoted
// by a declared condition also owes a proof of the reading: the declared anchor
// and a summary in the section's own words (see ./reference-proof).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./project-rules";
import type { ContextEntry, ProjectContextResolution } from "./context-resolver";
import { readProjectContextConfig, type ProjectContextEnforcement } from "./project-context-config";
import { isPromoted, pickProofItem, proofFailures, type CitedItem, type ProofRule } from "./reference-proof";

export type ResolvedMiss = {
  path: string;
  reason: string;
  /** The resolver's sha256. */
  expected: string;
  /** The sha256 the result cited, when it cited the path at all. */
  cited?: string;
  /** Set when the entry was cited with the right hash but the proof of the reading failed; absent for a path/hash miss. */
  rule?: ProofRule;
  /** What is wrong and what is expected; continues the sentence "<path> (<reason>) ...". Present with {@link rule}. */
  detail?: string;
};

export type ResolvedDrift = {
  path: string;
  tier: ContextEntry["tier"];
  pinned: string;
  /** Absent when the file can no longer be read. */
  current?: string;
};

export type ResolvedContextReport = {
  enforcement: ProjectContextEnforcement;
  misses: ResolvedMiss[];
  drifted: ResolvedDrift[];
  warnings: string[];
  /** Enforcement is `block` and something is wrong. */
  blocking: boolean;
};

export const RESOLVED_SCHEMAS: readonly string[] = ["task-implementer-output", "tests-creator-output"];

export async function readResolvedFile(file: string): Promise<ProjectContextResolution> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`--resolved ${file}: cannot read it as JSON (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
  const value = parsed as Partial<ProjectContextResolution> | null;
  if (value === null || typeof value !== "object" || value.schema !== 1 || !Array.isArray(value.entries)) {
    throw new Error(`--resolved ${file}: not a resolve-context result (expected {"schema": 1, "entries": [...]}).`);
  }
  return value as ProjectContextResolution;
}

function appliedOf(result: unknown): Map<string, CitedItem[]> {
  const cited = new Map<string, CitedItem[]>();
  const list = (result as { project_context_applied?: unknown } | null)?.project_context_applied;
  if (!Array.isArray(list)) return cited;
  for (const item of list) {
    const entry = item as { path?: unknown; sha256?: unknown; how?: unknown; anchor?: unknown; summary?: unknown } | null;
    if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") continue;
    const kept: CitedItem = {
      sha256: entry.sha256,
      ...(typeof entry.how === "string" ? { how: entry.how } : {}),
      ...(typeof entry.anchor === "string" ? { anchor: entry.anchor } : {}),
      ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
    };
    cited.set(entry.path, [...(cited.get(entry.path) ?? []), kept]);
  }
  return cited;
}

async function currentSha(projectRoot: string, entryPath: string): Promise<string | undefined> {
  try {
    return sha256Hex(await readFile(path.isAbsolute(entryPath) ? entryPath : path.join(projectRoot, entryPath), "utf8"));
  } catch {
    return undefined;
  }
}

/** The proof misses of a promoted entry; none when it was not cited at all (the path miss already says so). */
async function proofMisses(projectRoot: string, entry: ContextEntry, items: readonly CitedItem[]): Promise<ResolvedMiss[]> {
  const item = pickProofItem(items, entry.sha256);
  if (item === undefined) return [];
  const failures = await proofFailures({ projectRoot, entry, item });
  return failures.map((failure) => ({ path: entry.path, reason: entry.reason, expected: entry.sha256, rule: failure.rule, detail: failure.detail }));
}

export async function checkResolvedContext(input: {
  projectRoot: string;
  resolved: ProjectContextResolution;
  result: unknown;
}): Promise<ResolvedContextReport> {
  const config = await readProjectContextConfig(input.projectRoot);
  const cited = appliedOf(input.result);
  const misses: ResolvedMiss[] = [];
  const drifted: ResolvedDrift[] = [];
  for (const entry of input.resolved.entries) {
    const items = [entry.path, ...(entry.also_at ?? [])].flatMap((where) => cited.get(where) ?? []);
    if (entry.tier === "must_read") {
      // Flow 461 semantics: the last citation of each path is the one that counts for the hash.
      const shas = [entry.path, ...(entry.also_at ?? [])].flatMap((where) => {
        const last = cited.get(where)?.at(-1);
        return last !== undefined ? [last.sha256] : [];
      });
      if (!shas.includes(entry.sha256)) misses.push({ path: entry.path, reason: entry.reason, expected: entry.sha256, ...(shas[0] !== undefined ? { cited: shas[0] } : {}) });
      if (isPromoted(entry)) misses.push(...(await proofMisses(input.projectRoot, entry, items)));
    }
    for (const where of [entry.path, ...(entry.also_at ?? [])]) {
      const current = await currentSha(input.projectRoot, where);
      if (current !== entry.sha256) drifted.push({ path: where, tier: entry.tier, pinned: entry.sha256, ...(current !== undefined ? { current } : {}) });
    }
  }
  return {
    enforcement: config.enforcement,
    misses,
    drifted,
    warnings: config.warnings,
    blocking: config.enforcement === "block" && (misses.length > 0 || drifted.length > 0),
  };
}

export function formatResolvedHeadline(report: ResolvedContextReport): string {
  return `project context: ${report.misses.length} miss(es), ${report.drifted.length} drifted (enforcement ${report.enforcement})`;
}

export function formatResolvedReport(report: ResolvedContextReport): string[] {
  const lines: string[] = [];
  for (const miss of report.misses) {
    if (miss.detail !== undefined) {
      lines.push(`- project context miss: ${miss.path} (${miss.reason}) ${miss.detail}`);
      continue;
    }
    lines.push(
      miss.cited === undefined
        ? `- project context miss: ${miss.path} (${miss.reason}) is must_read and project_context_applied does not cite it (sha256 ${miss.expected})`
        : `- project context miss: ${miss.path} (${miss.reason}) is cited with sha256 ${miss.cited}, the resolver pinned ${miss.expected}`,
    );
  }
  for (const drift of report.drifted) {
    lines.push(
      drift.current === undefined
        ? `- project context drift: ${drift.path} (${drift.tier}) can no longer be read; it was pinned at sha256 ${drift.pinned}`
        : `- project context drift: ${drift.path} (${drift.tier}) now hashes to ${drift.current}; the resolver pinned ${drift.pinned}`,
    );
  }
  return lines;
}
