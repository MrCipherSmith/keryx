// W3 spec, "Design: stage pipeline" > "Extract" + "Deterministic extraction
// signals" + "Optional model-backed extractor". A separate, human- or
// schedule-triggered process (never a hook) that reads the observation
// window and existing durable artifacts, runs the deterministic signals
// (T7's `src/learning/signals/*.ts`), then optionally the capability-gated
// model-backed extractor, producing/reinforcing `status: candidate` records.
// Never produces `status: "accepted"` — that remains `keryx learn accept`'s
// (T8) exclusive job.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { applyDecay, applyEvidence, confidenceLevelFor, SEED_DETERMINISTIC, SEED_MODEL_BACKED } from "./confidence";
import { loadLearningConfig } from "./config";
import { resolveProjectIdentity } from "./identity";
import { observationsDir } from "./paths";
import { pruneObservationFilesPass } from "./prune";
import { scanLearnedText } from "./scan";
import { validateObservationEvent } from "./schema";
import { FAILING_TO_PASSING_TEST_SIGNAL } from "./signals/failing-to-passing-test";
import { HEALTH_REGRESSION_SIGNAL } from "./signals/health-regression";
import { REPEATED_CORRECTION_SIGNAL } from "./signals/repeated-correction";
import { REVERTED_EDIT_SIGNAL } from "./signals/reverted-edit";
import { REVIEWER_COMMENT_SIGNAL } from "./signals/reviewer-comment";
import type { ObservationLine, SignalDraft, SignalRunner } from "./signals/types";
import { listPatterns, readPattern, writePattern, type StoreEnvOptions } from "./store";
import type { EvidenceItem, LearnedPattern, LearningDomain, ObservationEvent } from "./types";

export class LearningExtractError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningExtractError";
  }
}

/** The optional, capability-gated model-backed extractor port (W3 spec: "no implementation ships"). */
export interface ModelExtractor {
  id: string;
  extract(window: ObservationLine[]): Promise<SignalDraft[]>;
}

export interface RunExtractOptions extends StoreEnvOptions {
  /** UTC `YYYY-MM-DD`. Defaults to 30 days before `now`. */
  since?: string;
  /** Restricts which signal(s) run to the one matching this domain. */
  domain?: LearningDomain;
  now?: Date;
  modelExtractor?: ModelExtractor;
}

export interface ExtractReport {
  /** Ids of newly created `status: candidate` records. */
  created: string[];
  /** Ids of existing records that gained at least one new evidence item. */
  reinforced: string[];
  /** Ids a signal drafted for, but whose stored record is rejected/superseded/expired — extract never touches these. */
  skippedDecided: string[];
  /** A draft refused by `scanLearnedText` before it could be written; category names only, never text. */
  refused: { signal: string; categories: string[] }[];
  /** Ids whose confidence was decayed this run. */
  decayed: string[];
  /** Draft count per signal name (deterministic signals always present at 0+; `"model-backed"` present only when it ran). */
  signals: Record<string, number>;
}

const DETERMINISTIC_SIGNALS: readonly SignalRunner[] = [
  FAILING_TO_PASSING_TEST_SIGNAL,
  REVERTED_EDIT_SIGNAL,
  REPEATED_CORRECTION_SIGNAL,
  REVIEWER_COMMENT_SIGNAL,
  HEALTH_REGRESSION_SIGNAL,
];

const CANDIDATE_TTL_DAYS = 30; // plan decision D4
const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultSince(now: Date): string {
  return utcDateString(new Date(now.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY));
}

function addDaysIso(date: Date, days: number): string {
  return new Date(date.getTime() + days * MS_PER_DAY).toISOString();
}

/** Whole UTC days elapsed between `iso` and `now` — matches `applyDecay`'s own whole-day floor (confidence.ts). */
function wholeUtcDaysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "pattern";
}

/** `<domain>.<slug>-<sha8>` — deterministic, never random (W3 spec + plan). */
export function deterministicPatternId(domain: LearningDomain, trigger: string): string {
  const normalized = normalizeText(trigger);
  const hash = createHash("sha256").update(`${domain}\n${normalized}`).digest("hex").slice(0, 8);
  return `${domain}.${slugify(trigger)}-${hash}`;
}

/** Reads every `.metaproject/data/learning/observations/<date>.jsonl` file with `date >= since`, parsing valid lines only (a malformed line is skipped, not thrown). */
export async function loadObservationWindow(root: string, since: string): Promise<ObservationLine[]> {
  const dir = observationsDir(root);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }

  const lines: ObservationLine[] = [];
  for (const file of files) {
    const date = file.slice(0, -".jsonl".length);
    if (date < since) continue;
    let raw: string;
    try {
      raw = await readFile(`${dir}/${file}`, "utf8");
    } catch {
      continue;
    }
    raw.split("\n").forEach((rawLine, index) => {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!validateObservationEvent(parsed).ok) return;
      lines.push({
        event: parsed as ObservationEvent,
        sourceRef: `.metaproject/data/learning/observations/${file}#L${index + 1}`,
      });
    });
  }
  return lines;
}

async function decayExistingRecords(
  root: string,
  now: Date,
  storeOptions: StoreEnvOptions,
  report: ExtractReport,
): Promise<void> {
  const records = await listPatterns(root, { scope: "project" }, storeOptions);
  for (const record of records) {
    if (record.status !== "candidate" && record.status !== "accepted") continue;
    const days = wholeUtcDaysSince(record.updatedAt, now);
    if (days < 1) continue;
    const nextConfidence = applyDecay(record.confidence, days);
    if (nextConfidence === record.confidence) continue;

    const scan = await scanLearnedText(root, [record.trigger, record.action]);
    if (scan.findings.length > 0) {
      report.refused.push({ signal: "decay", categories: scan.findings });
      continue;
    }

    const updated: LearnedPattern = {
      ...record,
      confidence: nextConfidence,
      confidenceLevel: confidenceLevelFor(nextConfidence),
      updatedAt: now.toISOString(),
    };
    await writePattern(root, updated, storeOptions);
    report.decayed.push(updated.id);
  }
}

async function upsertDraft(
  root: string,
  draft: SignalDraft,
  projectIdentity: ReturnType<typeof resolveProjectIdentity>,
  now: Date,
  storeOptions: StoreEnvOptions,
  report: ExtractReport,
): Promise<void> {
  const id = deterministicPatternId(draft.domain, draft.trigger);
  let existing: LearnedPattern | undefined;
  try {
    existing = await readPattern(root, id, "project", storeOptions);
  } catch {
    // A corrupt stored record: skip it, do not overwrite silently.
    report.skippedDecided.push(id);
    return;
  }

  if (existing && (existing.status === "rejected" || existing.status === "superseded" || existing.status === "expired")) {
    report.skippedDecided.push(id);
    return;
  }

  const newEvidence: EvidenceItem[] = existing
    ? draft.evidence.filter((item) => !existing!.evidence.some((existingItem) => existingItem.sourceRef === item.sourceRef))
    : draft.evidence;
  if (existing && newEvidence.length === 0) return; // nothing new to reinforce with; dedup by sourceRef.
  if (newEvidence.length === 0) return; // a draft with zero evidence never reaches the store.

  const scan = await scanLearnedText(root, [draft.trigger, draft.action]);
  if (scan.findings.length > 0) {
    report.refused.push({ signal: draft.extractor, categories: scan.findings });
    return;
  }

  if (!existing) {
    const seed = draft.extractorKind === "model-backed" ? SEED_MODEL_BACKED : SEED_DETERMINISTIC;
    const nowIso = now.toISOString();
    const record: LearnedPattern = {
      schemaVersion: 1,
      id,
      trigger: draft.trigger,
      action: draft.action,
      domain: draft.domain,
      scope: "project",
      project: projectIdentity,
      confidence: seed,
      confidenceLevel: confidenceLevelFor(seed),
      status: "candidate",
      supersededBy: null,
      evidence: newEvidence,
      reviewerProfile: draft.reviewerProfile ?? null,
      redaction: { scanned: true, findings: [] },
      graduation: null,
      provenance: { extractor: draft.extractor, extractorKind: draft.extractorKind ?? "deterministic" },
      ttl: { expiresAt: addDaysIso(now, CANDIDATE_TTL_DAYS) },
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await writePattern(root, record, storeOptions);
    report.created.push(id);
    return;
  }

  let confidence = existing.confidence;
  for (const item of newEvidence) {
    confidence = applyEvidence(confidence, item.kind, item.weight ?? 1);
  }
  const updated: LearnedPattern = {
    ...existing,
    evidence: [...existing.evidence, ...newEvidence],
    confidence,
    confidenceLevel: confidenceLevelFor(confidence),
    updatedAt: now.toISOString(),
  };
  await writePattern(root, updated, storeOptions);
  report.reinforced.push(id);
}

/**
 * Runs the deterministic signals (and, only when no deterministic signal
 * fired and the capability is enabled, the model-backed extractor) over the
 * observation window, upserting `status: candidate` records. Also runs one
 * decay pass over every existing `candidate`/`accepted` project record. Never
 * writes `status: "accepted"`.
 */
export async function runExtract(root: string, opts: RunExtractOptions = {}): Promise<ExtractReport> {
  const now = opts.now ?? new Date();
  // O-7: the observation-file TTL pass used to run only under `keryx learn
  // prune`, which nothing ever called automatically — so a daily file could
  // sit well past its 30-day TTL until a human happened to run `prune`
  // directly. `extract` is the one human-triggered command guaranteed to run
  // on a normal cadence (it is the step that makes observations useful at
  // all), so it carries the observation-file pass with it. Never a hook
  // (W3 spec) and never throws into this call — failures are swallowed here
  // (each is still collected internally) since a prune failure must not
  // block extraction itself.
  await pruneObservationFilesPass(root, now);
  const storeOptions: StoreEnvOptions = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
  const report: ExtractReport = {
    created: [],
    reinforced: [],
    skippedDecided: [],
    refused: [],
    decayed: [],
    signals: {},
  };

  await decayExistingRecords(root, now, storeOptions, report);

  const since = opts.since ?? defaultSince(now);
  const window = await loadObservationWindow(root, since);

  const signalsToRun = DETERMINISTIC_SIGNALS.filter((signal) => opts.domain === undefined || signal.domain === opts.domain);
  const drafts: SignalDraft[] = [];
  let anyDeterministicFired = false;
  for (const signal of signalsToRun) {
    const result = await signal.run(root, window, storeOptions);
    report.signals[signal.name] = result.length;
    if (result.length > 0) anyDeterministicFired = true;
    drafts.push(...result);
  }

  if (opts.modelExtractor) {
    const config = opts.modelExtractor ? await loadLearningConfig(root) : undefined;
    if (!config?.capabilities.modelExtractor) {
      throw new LearningExtractError(
        "model-extractor-capability-disabled",
        "the model-backed extractor is not enabled (.metaproject/learning.config.json capabilities.modelExtractor)",
      );
    }
    if (!anyDeterministicFired) {
      const modelDrafts = await opts.modelExtractor.extract(window);
      report.signals["model-backed"] = modelDrafts.length;
      for (const draft of modelDrafts) {
        drafts.push({
          ...draft,
          extractorKind: "model-backed",
          evidence: draft.evidence.map((item) => ({ ...item, weight: Math.min(item.weight ?? 0.5, 0.5) })),
        });
      }
    }
  }

  const projectIdentity = resolveProjectIdentity(root);
  for (const draft of drafts) {
    await upsertDraft(root, draft, projectIdentity, now, storeOptions, report);
  }

  return report;
}
