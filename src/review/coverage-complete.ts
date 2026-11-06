import { withCompletionLock } from "./completion-lock";
import type { CompletionWriter } from "./completion-write";
// Which in-scope files a review actually looked at. In scope is scope A (the changed files) together with scope B (the
// blast radius, including the files the cap dropped). Every file ends up covered, omitted under a named reason, or
// uncovered; `keryx review complete` refuses while any is uncovered unless the operator waives them in their own words.

import path from "node:path";
import { shellWord } from "../lib/shell-quote";
import { writeFileAtomic } from "../lib/fs";
import { type ChunkPass, computeChunkPass, hasChunkPlan } from "./chunks";
import { BLAST_RADIUS_SCOPE_REVIEWER, isCapDrop, isReasonedDrop } from "./blast-radius";
import { packageScopeFiles } from "./coverage";
import type { SliceManifest } from "./slice";
import { cardPressFields, type CardPress, type ConfirmedVia, type HostQuestion, hostQuestionFields, isHostQuestion } from "./types";
import { readJsonFileOr } from "../lib/json";
import { asRecord as record, dispatchRunRecords } from "./record";

export const COVERAGE_FILE = "coverage.json";
/** Where the ledger build leaves a copy of the slice manifest when the input directory is not the package. */
export const SLICE_MANIFEST_COPY = "slice-manifest.json";

export type CoverageStatus = "covered" | "omitted" | "uncovered";

export type CoverageFile = {
  file: string;
  scope: "A" | "B";
  status: CoverageStatus;
  /** What covered it: a slice id, a chunk id, or the scope-B reviewer run. */
  by?: string;
  /** Why an omitted file was left out, or why an uncovered one is not covered. */
  reason?: string;
};

export type CoverageWaiver = { hostQuestion?: HostQuestion; operatorQuote: string; time: string; files: string[]; confirmedVia?: ConfirmedVia | undefined } & CardPress;

export type CoverageReport = {
  schemaVersion: 1;
  /** False when the package holds no slice manifest, no blast radius with dropped files and no chunk plan: there is nothing to account against. */
  tracked: boolean;
  counts: { inScope: number; covered: number; omitted: number; uncovered: number };
  omissionReasons: Record<string, number>;
  files: CoverageFile[];
  omissions: Array<{ file: string; reason: string }>;
  waiver?: CoverageWaiver;
  /** True when a valid waiver names every uncovered file. */
  waived: boolean;
};

const readJson = <T>(file: string): Promise<T | undefined> => readJsonFileOr<T | undefined>(file, undefined);

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

type Radius = { files?: Array<{ file?: unknown }>; dropped?: Array<{ file?: unknown; reason?: unknown; detail?: unknown }> };

async function readManifest(packageDir: string): Promise<SliceManifest | undefined> {
  for (const candidate of [path.join(packageDir, "slices", "manifest.json"), path.join(packageDir, SLICE_MANIFEST_COPY)]) {
    const found = await readJson<SliceManifest>(candidate);
    if (found !== undefined && Array.isArray(found.slices)) return found;
  }
  return undefined;
}

function coveredSliceIds(dispatch: Record<string, unknown> | undefined, retry: unknown): Set<string> {
  const ids = new Set<string>();
  for (const run of dispatchRunRecords(dispatch)) {
    if (run.status === "not-run" || !Array.isArray(run.coveredSlices)) continue;
    for (const id of run.coveredSlices) if (typeof id === "string") ids.add(id);
  }
  // Delta round (flow 458): fix slices whose attached findings all have a disposition.
  if (Array.isArray(dispatch?.fixSlicesCovered)) for (const id of dispatch.fixSlicesCovered) if (typeof id === "string") ids.add(id);
  const reviewers = record(record(retry)?.reviewers);
  for (const entry of Object.values(reviewers ?? {})) {
    const covered = record(entry)?.covered;
    if (Array.isArray(covered)) for (const id of covered) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function scopeBRunComplete(dispatch: Record<string, unknown> | undefined): boolean {
  return dispatchRunRecords(dispatch).some((run) => run.reviewer === BLAST_RADIUS_SCOPE_REVIEWER && run.status === "complete" && run.scopeComplete !== false);
}

/**
 * True when the package carries any record written by the coverage accounting: a chunk plan, `coverage.json`, or a
 * dispatch run that names `coveredSlices`. A package cut before that accounting existed holds none of them, and the
 * completeness gate has nothing to hold it against.
 */
export async function packageRecordsCoverage(packageDir: string, research?: unknown): Promise<boolean> {
  if (hasChunkPlan(packageDir)) return true;
  if ((await readJson<unknown>(path.join(packageDir, COVERAGE_FILE))) !== undefined) return true;
  const ledger = research ?? (await readJson<unknown>(path.join(packageDir, "research.json")));
  return dispatchRunRecords(record(ledger)?.dispatch).some((run) => Array.isArray(run.coveredSlices));
}

export function readCoverageWaiver(dispatch: unknown): CoverageWaiver | undefined {
  const waiver = record(record(dispatch)?.coverageWaiver);
  if (waiver === undefined || !text(waiver.operatorQuote) || !text(waiver.time)) return undefined;
  const files = Array.isArray(waiver.files) ? waiver.files.filter(text) : [];
  const via = waiver.confirmedVia === "tui-card" || waiver.confirmedVia === "remote-card" || waiver.confirmedVia === "host-question" ? waiver.confirmedVia : undefined;
  const pressedBy = typeof waiver.pressedBy === "number" && Number.isSafeInteger(waiver.pressedBy) ? waiver.pressedBy : undefined;
  const pressedAt = text(waiver.pressedAt) ? waiver.pressedAt : undefined;
  return { operatorQuote: waiver.operatorQuote, time: waiver.time, files, ...(via === undefined ? {} : { confirmedVia: via }), ...cardPressFields({ pressedBy, pressedAt }), ...(via === "host-question" && isHostQuestion(waiver.hostQuestion) ? { hostQuestion: waiver.hostQuestion } : {}) };
}

export type ComputeCoverageOptions = {
  /** The parsed `research.json`, when the caller already holds it. */
  research?: unknown;
};

/** The coverage of one package, computed from what it holds. Writes nothing. */
export async function computeCoverage(packageDir: string, options: ComputeCoverageOptions = {}): Promise<CoverageReport> {
  const research = options.research ?? (await readJson<unknown>(path.join(packageDir, "research.json")));
  const dispatch = record(record(research)?.dispatch);
  const radius = await readJson<Radius>(path.join(packageDir, "blast-radius.json"));
  const manifest = await readManifest(packageDir);
  const retry = await readJson<unknown>(path.join(packageDir, "retry-state.json"));
  const scopeA = (await packageScopeFiles(packageDir)) ?? [];
  const chunkPass: ChunkPass | null = hasChunkPlan(packageDir) ? await computeChunkPass(packageDir) : null;

  const radiusFiles = (radius?.files ?? []).map((entry) => entry.file).filter(text);
  const dropped = (radius?.dropped ?? []).filter((entry) => text(entry.file));
  const capDropped = dropped.filter((entry) => isCapDrop(entry.reason)).map((entry) => entry.file as string);
  const preFiltered = new Map(dropped.filter((entry) => entry.reason === "pre-filter").map((entry) => [entry.file as string, text(entry.detail) ? `pre-filter: ${entry.detail}` : "pre-filter"]));
  // Reasoned omissions (flow 457): not consumers of the changed contract, so omitted under their reason, never owed a pass.
  const reasonedDrops = new Map(
    dropped.filter((entry) => isReasonedDrop(entry.reason)).map((entry) => [entry.file as string, text(entry.detail) ? `${String(entry.reason)}: ${entry.detail}` : String(entry.reason)]),
  );

  const tracked = manifest !== undefined || capDropped.length > 0 || chunkPass !== null;
  const files: CoverageFile[] = [];
  const claimed = new Set<string>();

  const sliceCover = new Map<string, string>();
  const omitted = new Map<string, string>();
  if (manifest !== undefined) {
    const covered = coveredSliceIds(dispatch, retry);
    for (const slice of manifest.slices) {
      if (!covered.has(slice.id)) continue;
      for (const file of slice.files) if (!sliceCover.has(file)) sliceCover.set(file, slice.id);
    }
    for (const omission of manifest.omissions ?? []) omitted.set(omission.path, text(omission.reason) ? omission.reason : "omitted");
  }
  const inManifest = new Set<string>(manifest === undefined ? [] : manifest.slices.flatMap((slice) => slice.files));
  const doneChunks = new Map<string, string>();
  for (const chunk of chunkPass?.chunks ?? []) if (chunk.state === "done") for (const file of chunk.files) doneChunks.set(file, chunk.id);
  const planned = new Set((chunkPass?.chunks ?? []).flatMap((chunk) => chunk.files));
  const bRun = scopeBRunComplete(dispatch);

  const add = (entry: CoverageFile): void => {
    if (claimed.has(entry.file)) return;
    claimed.add(entry.file);
    files.push(entry);
  };
  const place = (file: string, scope: "A" | "B", by: string | undefined, omission: string | undefined, whyNot: string): void => {
    if (by !== undefined) add({ file, scope, status: "covered", by });
    else if (omission !== undefined) add({ file, scope, status: "omitted", reason: omission });
    else add({ file, scope, status: "uncovered", reason: whyNot });
  };

  for (const file of [...new Set(scopeA)].sort()) {
    if (manifest === undefined) {
      add({ file, scope: "A", status: "covered", by: "dispatch" });
      continue;
    }
    const whyNot = inManifest.has(file) || omitted.has(file) ? "its slice has no finished reviewer result" : "in no slice and under no named omission";
    place(file, "A", sliceCover.get(file), omitted.get(file), whyNot);
  }
  for (const file of [...new Set(radiusFiles)].sort()) {
    if (!tracked) {
      add({ file, scope: "B", status: "covered", by: "dispatch" });
      continue;
    }
    place(file, "B", sliceCover.get(file) ?? doneChunks.get(file) ?? (bRun ? BLAST_RADIUS_SCOPE_REVIEWER : undefined), omitted.get(file), `${BLAST_RADIUS_SCOPE_REVIEWER} has no complete run`);
  }
  for (const file of [...new Set(capDropped)].sort()) {
    const whyNot = planned.has(file) ? "its chunk has not finished" : "dropped by the cap and in no chunk plan";
    place(file, "B", doneChunks.get(file) ?? sliceCover.get(file), omitted.get(file), whyNot);
  }
  for (const [file, reason] of [...preFiltered].sort(([a], [b]) => a.localeCompare(b))) add({ file, scope: "B", status: "omitted", reason });
  for (const [file, reason] of [...reasonedDrops].sort(([a], [b]) => a.localeCompare(b))) add({ file, scope: "B", status: "omitted", reason });

  const omissions = files.filter((entry) => entry.status === "omitted").map((entry) => ({ file: entry.file, reason: entry.reason ?? "omitted" }));
  const omissionReasons: Record<string, number> = {};
  for (const entry of omissions) omissionReasons[entry.reason] = (omissionReasons[entry.reason] ?? 0) + 1;
  const uncovered = files.filter((entry) => entry.status === "uncovered");
  const waiver = readCoverageWaiver(dispatch);
  const waived = waiver !== undefined && uncovered.every((entry) => waiver.files.includes(entry.file));
  const counts = { inScope: files.length, covered: files.filter((entry) => entry.status === "covered").length, omitted: omissions.length, uncovered: uncovered.length };
  return { schemaVersion: 1, tracked, counts, omissionReasons, files, omissions, ...(waiver === undefined ? {} : { waiver }), waived };
}

export async function writeCoverage(packageDir: string): Promise<CoverageReport> {
  const report = await computeCoverage(packageDir);
  await writeFileAtomic(path.join(packageDir, COVERAGE_FILE), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function readCoverage(packageDir: string): Promise<CoverageReport | undefined> {
  return readJson<CoverageReport>(path.join(packageDir, COVERAGE_FILE));
}

/** The four counts, as the one line the CLI, `layers status` and the panel print. */
export function coverageLine(report: Pick<CoverageReport, "counts" | "omissionReasons" | "tracked">): string {
  if (!report.tracked) return "coverage: not tracked (no slice manifest, no dropped blast-radius files)";
  const reasons = Object.entries(report.omissionReasons).sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason} ${count}`).join(", ");
  const { inScope, covered, omitted, uncovered } = report.counts;
  return `coverage: in scope ${inScope}, covered ${covered}, omitted ${omitted}${reasons === "" ? "" : ` (${reasons})`}, uncovered ${uncovered}`;
}

/** Characters, not words, of the operator's own text (the flag's name does not count). */
const MIN_WAIVER_QUOTE_CHARS = 8;

/**
 * Records the operator's waiver of every file uncovered right now in `research.json` (`dispatch.coverageWaiver`, the shape
 * of the mutation waiver: their quote, the time, and the waived file list). Nothing uncovered means nothing to waive.
 */
export async function recordCoverageWaiver(packageDir: string, operatorQuote: string, now: Date = new Date(), confirmedVia?: ConfirmedVia, press?: CardPress & { hostQuestion?: HostQuestion }, write: CompletionWriter = writeFileAtomic): Promise<CoverageWaiver | undefined> {
  return withCompletionLock(packageDir, () => recordCoverageWaiverLocked(packageDir, operatorQuote, now, confirmedVia, press, write));
}

async function recordCoverageWaiverLocked(packageDir: string, operatorQuote: string, now: Date = new Date(), confirmedVia?: ConfirmedVia, press?: CardPress & { hostQuestion?: HostQuestion }, write: CompletionWriter = writeFileAtomic): Promise<CoverageWaiver | undefined> {
  // A flag name or a one-word "ok" is not the operator's words; the flag is also a human-confirmation command (see command-risk).
  const quote = operatorQuote.replace(/-{0,2}waive[- ]?coverage/gi, "").trim();
  if (quote.length < MIN_WAIVER_QUOTE_CHARS || !/[\p{L}\p{N}]/u.test(quote)) {
    throw new Error(`--waive-coverage needs the operator's own words as its value: at least ${MIN_WAIVER_QUOTE_CHARS} characters, with letters or digits in them.`);
  }
  const file = path.join(packageDir, "research.json");
  const research = record(await readJson<unknown>(file));
  const dispatch = record(research?.dispatch);
  if (research === undefined || dispatch === undefined) return undefined;
  const report = await computeCoverage(packageDir, { research });
  const uncovered = report.files.filter((entry) => entry.status === "uncovered").map((entry) => entry.file);
  if (!report.tracked || uncovered.length === 0) return undefined;
  const waiver: CoverageWaiver = { operatorQuote: quote, time: now.toISOString(), files: uncovered, ...(confirmedVia === undefined ? {} : { confirmedVia }), ...cardPressFields(press), ...hostQuestionFields(press) };
  await write(file, `${JSON.stringify({ ...research, dispatch: { ...dispatch, coverageWaiver: waiver } }, null, 2)}\n`);
  return waiver;
}

export const FIRST_FILES = 5;

/** What stops `review complete`: empty when nothing is uncovered, or a valid waiver names every uncovered file. */
export async function coverageGateErrors(packageDir: string, research?: unknown): Promise<string[]> {
  const report = await computeCoverage(packageDir, research === undefined ? {} : { research });
  if (!report.tracked || report.counts.uncovered === 0 || report.waived) return [];
  const uncovered = report.files.filter((entry) => entry.status === "uncovered");
  const first = uncovered.slice(0, FIRST_FILES).map((entry) => entry.file);
  const more = uncovered.length > FIRST_FILES ? `, … (+${uncovered.length - FIRST_FILES})` : "";
  const dir = shellWord(path.relative(process.cwd(), packageDir) || ".");
  const chunkWork = uncovered.some((entry) => entry.scope === "B");
  const sliceWork = uncovered.some((entry) => entry.scope === "A");
  const commands = [
    ...(chunkWork ? [`keryx review chunks next --package ${dir}`] : []),
    ...(sliceWork ? [`keryx review ledger build <input-dir> --package ${dir}`] : []),
  ].join(" ; ");
  const stale = report.waiver !== undefined ? " The recorded waiver does not name every uncovered file." : "";
  return [
    `${uncovered.length} in-scope file(s) are uncovered: ${first.join(", ")}${more}. Run the missing work with \`${commands}\`, or pass \`keryx review complete --waive-coverage "<operator quote>"\` with the operator's own words.${stale}`,
  ];
}
