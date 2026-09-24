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
import { gateReviewerText } from "./reviewer-id";
import { scanLearnedText } from "./scan";
import { validateObservationEvent } from "./schema";
import { FAILING_TO_PASSING_TEST_SIGNAL } from "./signals/failing-to-passing-test";
import { HEALTH_REGRESSION_SIGNAL } from "./signals/health-regression";
import { REPEATED_CORRECTION_SIGNAL } from "./signals/repeated-correction";
import { REVERTED_EDIT_SIGNAL } from "./signals/reverted-edit";
import { REVIEWER_COMMENT_SIGNAL } from "./signals/reviewer-comment";
import type { ObservationLine, SignalDraft, SignalRunner } from "./signals/types";
import { createPattern, listPatterns, readPattern, updatePattern, type StoreEnvOptions } from "./store";
import type { EvidenceItem, LearnedPattern, LearningDomain, ObservationEvent } from "./types";
import { loadReviewLearningConfigSafe } from "../review/review-learning";

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

    // R1-F1/R1-F7: read-modify-write through the store's choke point, under
    // the project lock, so a concurrent accept/reject/extract cannot land
    // between this pass's read and write — and re-derive the decay from the
    // record `updatePattern` actually reads under the lock, not the `record`
    // snapshot read before it.
    let changed = false;
    await updatePattern(
      root,
      record.id,
      record.scope,
      (current) => {
        if (current.status !== "candidate" && current.status !== "accepted") return current;
        const currentDays = wholeUtcDaysSince(current.updatedAt, now);
        if (currentDays < 1) return current;
        const decayedConfidence = applyDecay(current.confidence, currentDays);
        if (decayedConfidence === current.confidence) return current;
        changed = true;
        return {
          ...current,
          confidence: decayedConfidence,
          confidenceLevel: confidenceLevelFor(decayedConfidence),
          // R1-F8: advance the anchor by exactly the whole days just applied
          // to `current.updatedAt` — never reset it to `now`. Resetting to
          // `now` discards whatever fraction of a day was left over each
          // run, so two runs 36h apart (1 whole day counted each time) would
          // under-decay compared to one run 72h later (3 whole days counted
          // once): 0.4 -> two 36h runs would previously land at
          // `0.4 * 0.98^1 * 0.98^1`, not the `0.4 * 0.98^3` one 72h run
          // produces, even though both cover the same 72 elapsed hours.
          // Anchoring on `current.updatedAt + currentDays` instead carries
          // the leftover 12h forward each time, so the two cadences agree.
          updatedAt: addDaysIso(new Date(current.updatedAt), currentDays),
        };
      },
      storeOptions,
    );
    if (changed) report.decayed.push(record.id);
  }
}

/**
 * `config.authors` + `config.reviewerProfiles`, deduped — `[]` when the
 * project has no review-learning config OR when it is malformed (R3-F3: the
 * caller decides how to report the malformed case; this helper never
 * throws).
 */
function configuredReviewLoginsFrom(config: { authors: readonly string[]; reviewerProfiles?: readonly string[] } | null): string[] {
  if (config === null) return [];
  return [...new Set([...config.authors, ...(config.reviewerProfiles ?? [])])];
}

async function upsertDraft(
  root: string,
  draft: SignalDraft,
  projectIdentity: ReturnType<typeof resolveProjectIdentity>,
  now: Date,
  storeOptions: StoreEnvOptions,
  report: ExtractReport,
  configuredLogins: readonly string[],
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

  // R2-F6/R6-F4/R8-F3: a `reviewer-comment` draft's trigger/action never
  // reaches the store carrying any configured reviewer login at an
  // identifier boundary — this is the same check `generalizeLesson` already
  // applies to its own output, run again here via `gateReviewerText` as
  // extract's own choke point for the one signal that actually reads review
  // text.
  //
  // `gateReviewerText` itself scopes by `mayCarryReviewerText` (R6-F4/R7-F3)
  // — the deterministic `reviewer-comment` signal, OR any model-backed draft
  // (`draft.extractorKind === "model-backed"`, regardless of its
  // self-declared `extractor` label). The other deterministic signals
  // (reverted-edit, repeated-correction, failing-to-passing-test,
  // health-regression) never read review comment text at all — their
  // trigger/action come from fixed templates plus observation data (file
  // paths, test names, commit messages), so a configured login that happens
  // to equal one of those template words (`edit`, `check`, `project`,
  // `when`, ...) would otherwise refuse every draft of a signal that could
  // never have carried that login in the first place. A model-backed draft
  // is gated regardless of its `extractor` label (R7-F3): a model-backed
  // extractor picks that label itself and sees the whole observation window,
  // so scoping by the literal string `"reviewer-comment"` let a
  // differently-labeled model-backed draft carry an unchecked login through.
  //
  // R4-F1: `gateReviewerText` strips `REVIEWER_COMMENT_TRIGGER_PREFIX` from
  // `trigger` before checking it (a no-op for a draft whose trigger never
  // had that prefix, i.e. every model-backed draft), leaving only the
  // keyword hint a login could actually appear in.
  if (gateReviewerText({ provenance: { extractor: draft.extractor, extractorKind: draft.extractorKind }, trigger: draft.trigger, action: draft.action }, configuredLogins).refused) {
    report.refused.push({ signal: draft.extractor, categories: ["attribution"] });
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
    try {
      // R1-F1/R1-F7: `createPattern` re-checks, under the lock, that nothing
      // active has landed at this id since the `readPattern` above — a
      // concurrent extract pass (or a human accept racing the same
      // deterministic id) is refused rather than silently overwritten.
      await createPattern(root, record, storeOptions);
      report.created.push(id);
    } catch {
      report.skippedDecided.push(id);
    }
    return;
  }

  // R1-F1/R1-F7: reinforce through the choke point, under the project lock —
  // re-derive the evidence dedup and the confidence delta from the record
  // `updatePattern` reads UNDER the lock (`current`), not the `existing`
  // snapshot read before it, so a concurrent writer that already added one
  // of `draft.evidence`'s sourceRefs (or changed status to something terminal)
  // is not double-applied or overwritten.
  let reinforced = false;
  try {
    await updatePattern(
      root,
      id,
      "project",
      (current) => {
        if (current.status !== "candidate" && current.status !== "accepted") return current;
        const freshNewEvidence = draft.evidence.filter(
          (item) => !current.evidence.some((existingItem) => existingItem.sourceRef === item.sourceRef),
        );
        if (freshNewEvidence.length === 0) return current;
        let confidence = current.confidence;
        for (const item of freshNewEvidence) {
          confidence = applyEvidence(confidence, item.kind, item.weight ?? 1);
        }
        reinforced = true;
        return {
          ...current,
          evidence: [...current.evidence, ...freshNewEvidence],
          confidence,
          confidenceLevel: confidenceLevelFor(confidence),
          updatedAt: now.toISOString(),
        };
      },
      storeOptions,
    );
  } catch {
    report.skippedDecided.push(id);
    return;
  }
  if (reinforced) report.reinforced.push(id);
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

  // R3-F3: load (and validate) the review-learning config BEFORE any write —
  // decay included — so one run is all-or-nothing. This used to be read
  // lazily, well after decay had already run, so a malformed config threw
  // straight out of this function with decay's writes already on disk (a
  // half-done run). A malformed config no longer throws: it degrades every
  // OTHER domain's login gate to "no configured logins" (harmless — those
  // signals never draft attribution text in the first place) and skips ONLY
  // the `reviewer-comment` signal (the one signal that actually reads this
  // config), reporting the error under that signal's name rather than
  // aborting the whole pass.
  const configResult = await loadReviewLearningConfigSafe(root);
  const configuredLogins = configResult.ok ? configuredReviewLoginsFrom(configResult.config) : [];
  if (!configResult.ok) {
    report.refused.push({ signal: "reviewer-comment", categories: ["review-learning-config-invalid"] });
  }

  await decayExistingRecords(root, now, storeOptions, report);

  const since = opts.since ?? defaultSince(now);
  const window = await loadObservationWindow(root, since);

  const signalsToRun = DETERMINISTIC_SIGNALS.filter(
    (signal) =>
      (opts.domain === undefined || signal.domain === opts.domain) &&
      (configResult.ok || signal !== REVIEWER_COMMENT_SIGNAL),
  );
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
    await upsertDraft(root, draft, projectIdentity, now, storeOptions, report, configuredLogins);
  }

  return report;
}
