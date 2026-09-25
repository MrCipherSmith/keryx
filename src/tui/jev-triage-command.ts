// flow 340 — `/triage`: runs `review-jev-triage` over the latest review
// package on disk and prints its annotations straight into the transcript.
//
// Deliberately NOT a modal, and deliberately its own file — same shape flow
// 335's `jev-contract-command.ts` chose for `/contract` (see its own
// header): a one-shot advisory pass has nothing to keep open across turns.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { computeJevTriageResult, jevTriageGateRefusal, type JevTriageComputedResult } from "../commands/review-jev-triage";
import { renderTriageMarkdown } from "../review/jev-triage";

export const JEV_TRIAGE_COMMAND = "/triage";

export function isJevTriageCommand(name: string): boolean {
  return name === JEV_TRIAGE_COMMAND;
}

/** English, plain-text transcript rendering. */
export function renderJevTriageForShell(result: JevTriageComputedResult): string {
  return renderTriageMarkdown(result).trimEnd();
}

/**
 * Every `findings.json` under `<cwd>/.metaproject/flows/*&#47;reviews/*`,
 * newest `mtime` first — a deterministic, filesystem-only notion of "the
 * latest review package" that needs no separate "current flow" concept the
 * rest of this codebase does not otherwise track. `undefined` when no flow
 * has a review package yet.
 */
export async function resolveLatestReviewPackage(cwd: string): Promise<string | undefined> {
  const flowsDir = path.join(cwd, ".metaproject", "flows");
  let flowEntries: string[];
  try {
    flowEntries = (await readdir(flowsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }

  const candidates: { readonly dir: string; readonly mtimeMs: number }[] = [];
  for (const flowName of flowEntries) {
    const reviewsDir = path.join(flowsDir, flowName, "reviews");
    let reviewEntries: string[];
    try {
      reviewEntries = (await readdir(reviewsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const reviewName of reviewEntries) {
      const packageDir = path.join(reviewsDir, reviewName);
      const findingsPath = path.join(packageDir, "findings.json");
      try {
        const stats = await stat(findingsPath);
        candidates.push({ dir: packageDir, mtimeMs: stats.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : b.dir.localeCompare(a.dir)));
  return candidates[0]!.dir;
}

/**
 * The whole job of `/triage`: the gate, finding the latest review package,
 * the check, the render — one string back, refusal or result, never a throw
 * for an ordinary "not enabled"/"no credential"/"no review package yet"
 * state.
 */
export async function runJevTriageForShell(cwd: string): Promise<string> {
  const refusal = await jevTriageGateRefusal(cwd);
  if (refusal !== undefined) {
    return refusal;
  }
  const packageDir = await resolveLatestReviewPackage(cwd);
  if (packageDir === undefined) {
    return "review-jev-triage: no review package found under .metaproject/flows/*/reviews/ — run a review round first.";
  }
  const findingsRaw = JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8")) as unknown;
  const result = await computeJevTriageResult({ findingsRaw });
  return `review-jev-triage: ${path.relative(cwd, packageDir)}\n${renderJevTriageForShell(result)}`;
}
