import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import { packageScopeFiles, projectRootOfPackage, requiredReviewers, type ReviewMode } from "../review/coverage";
import { type Disposition, type LedgerGap, type RawFile, buildLedger, isEmptyOutput, ledgerBlockers, parseReviewResult, sha } from "../review/ledger";
import { type RetryState, emptyRetryState, scopeFingerprint } from "../review/retry-plan";
import type { SliceManifest } from "../review/slice";

export const LEDGER_FLAGS = ["--package", "--mode", "--findings", "--dispositions", "--out", "--dry-run", "--json", "--help", "-h"] as const;
const VALUE_FLAGS = new Set(["--package", "--mode", "--findings", "--dispositions", "--out"]);

export function printLedgerHelp(): void {
  console.log(`keryx review ledger build — usage:

  keryx review ledger build <input-dir> [--package <review-dir>] [--mode all|diff]
                            [--findings <findings.json>] [--dispositions <file>]
                            [--out <research.json>] [--dry-run] [--json]

Builds the research ledger \`keryx review ingest --research\` and \`complete\` demand, from
files only. <input-dir> holds raw/*.txt (reviewer replies), drivers/*.json and
slices/manifest.json; --package (default: <input-dir> when it holds scope-files.json) holds
scope-files.json, findings.json and retry-state.json. Writes research.json there (--out).

Per required reviewer: the latest raw result decides. DONE / DONE_WITH_CONCERNS with no open
needs_context and every slice its path gate requires covered by its dispatched payloads is a
complete run (source-only, executionRequired false); anything else — NEEDS_CONTEXT, BLOCKED,
INCOMPLETE, missing slices, no result — stays incomplete or not-run, never declared complete.
Each raw finding becomes an obligation, closed only by a matching canonical finding or a
valid --dispositions entry ({id, status finding|refuted|out-of-scope, evidence, reason,
finding?}; default: the obligations already in research.json). scopeReviewed and rawReconciled
are true only when established.

Slices are dispatched in waves bounded by the manifest's wave budget; a reviewer that covered
new slices is not penalised for the rest (retry-state.json keeps what it covered).

Prints READY, or NOT READY with each gap and its next step (the exact retry-plan command,
the uncovered slices and how many waves remain, or the disposition to add). Exit 1 when NOT READY, so
\`ledger build && ingest --research\` stops. The gate's own validators decide READY.
`);
}

function positional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n)) : [];
}

async function loadRaws(inputDir: string): Promise<{ raws: RawFile[]; ignored: string[] }> {
  const raws: RawFile[] = [];
  const ignored: string[] = [];
  const dir = path.join(inputDir, "raw");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".txt")).sort()) {
    const file = path.join(dir, name);
    const body = await readFile(file, "utf8");
    const result = isEmptyOutput(body) ? undefined : parseReviewResult(body);
    if (result !== undefined && result.reviewer === undefined && !Array.isArray(result.findings)) {
      ignored.push(`raw/${name}`);
      continue;
    }
    raws.push({ name: `raw/${name}`, hash: sha(body), mtimeMs: (await stat(file)).mtimeMs, empty: isEmptyOutput(body), ...(result === undefined ? {} : { result }) });
  }
  return { raws, ignored };
}

async function loadRetry(fingerprint: string | undefined, ...files: string[]): Promise<RetryState> {
  const merged = emptyRetryState();
  for (const file of files) {
    const state = await readJson<RetryState>(file);
    if (fingerprint === undefined || state?.scopeFingerprint !== fingerprint) continue;
    merged.scopeFingerprint = fingerprint;
    for (const [reviewer, entry] of Object.entries(state?.reviewers ?? {})) {
      const known = merged.reviewers[reviewer];
      const covered = [...new Set([...(known?.covered ?? []), ...(entry.covered ?? [])])].sort();
      const stalls = Math.max(known?.stalls ?? known?.attempt ?? 0, entry.stalls ?? entry.attempt);
      merged.reviewers[reviewer] = { attempt: Math.max(known?.attempt ?? 0, entry.attempt), status: entry.status, notRun: known?.notRun === true || entry.notRun === true, stalls, covered };
    }
  }
  return merged;
}

export function renderLedgerReport(ready: boolean, gaps: LedgerGap[], blockers: string[], out: string, ignored: string[], dryRun = false): string {
  const verb = dryRun ? "would be written" : "written";
  const lines = [ready ? `READY: ${out} ${verb} and satisfies the completion gate.` : `NOT READY: ${out} ${verb}, but the completion gate would refuse it.`];
  for (const gap of gaps) lines.push(`- gap${gap.reviewer ? ` [${gap.reviewer}]` : ""}: ${gap.detail}\n    next: ${gap.next}`);
  const waves = gaps.filter((gap) => gap.reviewer !== undefined && gap.waves !== undefined && gap.waves > 0);
  if (waves.length > 0) lines.push(`remaining waves: ${waves.map((gap) => `${gap.reviewer} ${gap.waves}`).join(", ")}`);
  if (!ready) for (const blocker of blockers.slice(0, 10)) lines.push(`- gate: ${blocker}`);
  if (blockers.length > 10) lines.push(`- gate: … and ${blockers.length - 10} more`);
  if (ignored.length > 0) lines.push(`ignored (not reviewer results): ${ignored.join(", ")}`);
  return lines.join("\n");
}

/** Ambiguous raw-to-dispatch references never contribute implicit coverage. */
export function assignRawDispatch(raws: RawFile[], assignments: ReadonlyMap<string, readonly string[][]>): void {
  for (const raw of raws) {
    const matches = assignments.get(`${raw.result?.reviewer}\0${raw.name}`);
    if (matches !== undefined) raw.assignedSlices = matches.length === 1 ? [...matches[0]!] : [];
  }
}

export async function runLedger(args: string[], deps: { rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void }): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args[0] === undefined) return printLedgerHelp();
  if (args[0] !== "build") throw new Error(`Unknown ledger subcommand "${args[0]}". See \`keryx review ledger --help\`.`);
  const rest = args.slice(1);
  deps.rejectUnknownFlags(rest, LEDGER_FLAGS, "ledger build");
  const target = positional(rest);
  if (target === undefined) throw new Error("Missing <input-dir>. See `keryx review ledger --help`.");
  const inputDir = path.resolve(target);
  if (!existsSync(path.join(inputDir, "raw"))) throw new Error(`${inputDir} has no raw/ directory; pass the review input directory.`);
  const packageArg = optionValue(rest, "--package");
  const packageDir = path.resolve(packageArg ?? inputDir);
  if (packageArg === undefined && !existsSync(path.join(inputDir, "scope-files.json"))) throw new Error("Pass --package <review-dir> (the managed package with scope-files.json and findings.json).");
  const mode = (optionValue(rest, "--mode") ?? "all") as ReviewMode;
  if (mode !== "all" && mode !== "diff") throw new Error('--mode must be "all" or "diff".');

  const root = projectRootOfPackage(packageDir);
  const files = await packageScopeFiles(packageDir);
  const manifestPath = path.join(inputDir, "slices", "manifest.json");
  const manifest = await readJson<SliceManifest>(manifestPath);
  if (manifest !== undefined) for (const entry of manifest.slices) {
    const hash = await readFile(path.resolve(path.dirname(manifestPath), entry.path))
      .then((body) => createHash("sha256").update(body).digest("hex")).catch(() => undefined);
    if (hash === undefined) delete entry.contentHash;
    else entry.contentHash = hash;
  }
  const { raws, ignored } = await loadRaws(inputDir);
  const canonical = (await readJson<Array<Record<string, unknown>>>(path.resolve(optionValue(rest, "--findings") ?? path.join(packageDir, "findings.json")))) ?? [];
  const out = path.resolve(optionValue(rest, "--out") ?? path.join(packageDir, "research.json"));
  const dispositionSource = optionValue(rest, "--dispositions");
  const given = await readJson<Disposition[] | { obligations?: Disposition[] }>(path.resolve(dispositionSource ?? out));
  const dispositions = (Array.isArray(given) ? given : given?.obligations) ?? [];

  const payloadSlices: Record<string, string[]> = {};
  const payloadDispatchCounts: Record<string, number> = {};
  const ruleFiles: Record<string, string> = {};
  const assignments = new Map<string, string[][]>();
  for (const file of await jsonFiles(path.join(inputDir, "drivers"))) {
    const driver = await readJson<{ reviewer?: unknown; slices?: unknown; definition?: unknown; result?: unknown }>(file);
    if (typeof driver?.reviewer !== "string") continue;
    payloadDispatchCounts[driver.reviewer] = (payloadDispatchCounts[driver.reviewer] ?? 0) + 1;
    if (Array.isArray(driver.slices) && driver.slices.every((s) => typeof s === "string")) (payloadSlices[driver.reviewer] ??= []).push(...(driver.slices as string[]));
    if (typeof driver.result === "string" && Array.isArray(driver.slices) && driver.slices.every((s) => typeof s === "string")) {
      const key = `${driver.reviewer}\0${driver.result}`;
      const matches = assignments.get(key) ?? [];
      matches.push(driver.slices as string[]);
      assignments.set(key, matches);
    }
    if (typeof driver.definition === "string") {
      const definition = path.resolve(root, driver.definition);
      if (existsSync(definition)) ruleFiles[driver.reviewer] = path.relative(root, definition);
    }
  }

  assignRawDispatch(raws, assignments);
  const required = await requiredReviewers(root, mode, files);
  const { ledger, gaps } = buildLedger({
    mode,
    selected: required.required,
    manifest,
    payloadSlices,
    payloadDispatchCounts,
    ruleFiles,
    raws,
    retry: await loadRetry(manifest === undefined ? undefined : scopeFingerprint(manifest), path.join(inputDir, "slices", "retry-state.json"), path.join(packageDir, "retry-state.json")),
    canonical,
    dispositions,
    manifestPath: path.relative(process.cwd(), manifestPath),
  });
  const blockers = await ledgerBlockers(ledger, canonical, { root, files });
  const ready = blockers.length === 0;
  if (!rest.includes("--dry-run")) await writeFileAtomic(out, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(rest.includes("--json") ? JSON.stringify({ ready, out, gaps, blockers, ignored, ledger }, null, 2) : renderLedgerReport(ready, gaps, blockers, path.relative(process.cwd(), out) || out, ignored, rest.includes("--dry-run")));
  if (!ready) process.exitCode = 1;
}
