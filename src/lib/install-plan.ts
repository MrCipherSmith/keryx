import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { isNotFound, writeFileAtomic } from "./fs";

/**
 * The install/update/rules-sync lifecycle plan (AFC-21 / flow 236 AC2).
 *
 * This module deliberately delivers LESS than a transaction, because the norm
 * explicitly refuses one: `artifact-lifecycle.md` §"Init/update/rules lifecycle"
 * says the lifecycle promises "честный partial report и safe resume, **не общий
 * rollback всех файлов**". So there is no undo here, and nothing in this module
 * ever claims one. What it delivers instead:
 *
 * 1. **Preview.** {@link buildInstallPlan} touches nothing on disk; it reports
 *    create / update / skip / conflict per step with the expected base digest,
 *    so a caller can see what would change before anything changes.
 * 2. **Resume.** {@link applyInstallPlan} makes the record that a step BEGAN
 *    durable *before* the step runs. This is the same reasoning the SAC lane
 *    reached in `src/sac/proposal-lifecycle.ts` (`OwnerWriteAttempt`): the
 *    receipt is written after the bytes, so "no receipt" cannot distinguish
 *    "never started" from "already applied" — only a marker written first can.
 *    A restart therefore reads `begun` and reports honestly that the step
 *    happened, or may have, and was not rolled back.
 * 3. **Divergence.** A step whose target was published by a different writer
 *    version, and whose bytes that version's own record can no longer account
 *    for, is a `conflict`: the ambiguity is un-resolvable from here (did the
 *    other version write those bytes, or did a human?), so it is named, both
 *    versions are printed, and two explicit resolutions are offered.
 *
 * Scope, stated plainly: a version transition whose bytes *are* accounted for
 * (on-disk digest still equals the digest the previous version recorded) is not
 * a conflict — it is announced as a version transition and applied, because
 * upgrading a file this tool provably wrote is the entire point of `update`.
 * Byte drift under the *same* version is likewise announced and re-applied,
 * because the running version can reproduce its own output deterministically.
 * Only cross-version ambiguity blocks.
 */

/** Machine-local resume state. Under `runtime/`, so the managed metaproject .gitignore already excludes it. */
export const INSTALL_JOURNAL_RELATIVE_PATH = path.join("runtime", "install", "journal.json");

/** `managed` is republished whenever it drifts; `create-if-absent` is written once and then owned by the user. */
export type InstallStepMode = "managed" | "create-if-absent";

export type InstallStep = Readonly<{
  /** Stable step ID. Stable across runs and releases — it is the journal key. */
  id: string;
  /** Absolute target path. */
  path: string;
  /** Fully rendered bytes. Steps are content-addressed; nothing is rendered lazily. */
  content: string;
  mode: InstallStepMode;
}>;

export type PlannedOutcome = "create" | "update" | "skip" | "conflict";

export type PlannedReason =
  | "already-current"
  | "present-create-if-absent"
  | "version-divergence"
  | "version-transition"
  | "base-drift";

export type PlannedStep = Readonly<{
  id: string;
  path: string;
  mode: InstallStepMode;
  content: string;
  outcome: PlannedOutcome;
  /** Digest of the bytes currently on disk, or null when the target is absent. */
  expectedBaseDigest: string | null;
  plannedDigest: string;
  /** Writer version recorded for this step by an earlier run, when there is one. */
  recordedWriterVersion: string | null;
  /** Digest an earlier run recorded for this step, when there is one. */
  recordedDigest: string | null;
  versionTransition: Readonly<{ from: string; to: string }> | null;
  reason: PlannedReason | null;
  /** An earlier run durably recorded this step as begun and never recorded an outcome. */
  previouslyBegun: boolean;
}>;

export type InstallPlan = Readonly<{
  metaprojectRoot: string;
  journalPath: string;
  intent: string;
  planId: string;
  inputFingerprint: string;
  writerVersion: string;
  steps: readonly PlannedStep[];
  /** Step IDs an earlier run began and did not finish. Never rolled back. */
  carriedOver: readonly string[];
  previous: InstallJournal | null;
}>;

export type InstallJournalStep = Readonly<{
  status: "begun" | "completed" | "failed" | "kept";
  writerVersion: string;
  planId: string;
  intent: string;
  startedAt: string;
  completedAt?: string;
  /** Digest this run wrote (completed) or intended to write (begun). */
  digest: string;
  /** Digest observed on disk immediately before the write. */
  baseDigest: string | null;
  error?: string;
}>;

export type InstallJournal = Readonly<{
  schemaVersion: "1.0";
  writerVersion: string;
  intent: string;
  planId: string;
  inputFingerprint: string;
  startedAt: string;
  updatedAt: string;
  steps: Record<string, InstallJournalStep>;
}>;

export type DivergenceResolution = "accept-version" | "keep-existing";

export type BlockedStep = Readonly<{
  id: string;
  path: string;
  recordedWriterVersion: string | null;
  writerVersion: string;
  expectedBaseDigest: string | null;
  recordedDigest: string | null;
}>;

export type InstallApplyReport = Readonly<{
  intent: string;
  planId: string;
  writerVersion: string;
  completed: readonly string[];
  skipped: readonly string[];
  kept: readonly string[];
  failed: readonly Readonly<{ id: string; error: string }>[];
  blocked: readonly BlockedStep[];
  pending: readonly string[];
  carriedOver: readonly string[];
  notices: readonly string[];
}>;

/**
 * Test-only seam marker. Thrown from `beforeStepMutation` to simulate a process
 * death between the durable `begun` record and the write it protects. Apply
 * leaves the journal exactly as a real crash would — it does NOT downgrade the
 * record to `failed`, because a dead process records nothing.
 */
export class InstallCrashSignal extends Error {
  constructor(message = "simulated crash") {
    super(message);
    this.name = "InstallCrashSignal";
  }
}

export class InstallPlanBlockedError extends Error {
  constructor(
    message: string,
    readonly conflicts: readonly BlockedStep[],
  ) {
    super(message);
    this.name = "InstallPlanBlockedError";
  }
}

export function currentWriterVersion(): string {
  return packageJson.version;
}

/**
 * A preview is a flag on the existing commands, not a separate step.
 * `init`, `update`, `rules sync` and `rules distill` are four intents on one
 * writer, and each plan is a function of that intent's own option parsing and
 * interactive answers; a standalone `keryx plan` command would have to
 * re-derive every `--no-<module>` flag and every prompt default, and would
 * drift from them the first time one changed. `--dry-run` is accepted as an
 * alias because `orient install-hook` already spells it that way.
 */
export function isPreviewRequested(args: readonly string[]): boolean {
  return args.includes("--preview") || args.includes("--dry-run");
}

/** Reads `--accept-version` / `--keep-existing`. Passing both is a user error, not a silent pick. */
export function parseDivergenceResolution(args: readonly string[]): DivergenceResolution | undefined {
  const accept = args.includes("--accept-version");
  const keep = args.includes("--keep-existing");
  if (accept && keep) {
    throw new Error("--accept-version and --keep-existing contradict each other; pass one.");
  }
  if (accept) return "accept-version";
  if (keep) return "keep-existing";
  return undefined;
}

export function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function installJournalPath(metaprojectRoot: string): string {
  return path.join(metaprojectRoot, INSTALL_JOURNAL_RELATIVE_PATH);
}

export async function readInstallJournal(metaprojectRoot: string): Promise<InstallJournal | undefined> {
  try {
    const parsed = JSON.parse(await readFile(installJournalPath(metaprojectRoot), "utf8")) as InstallJournal;
    return parsed && typeof parsed === "object" && parsed.steps ? parsed : undefined;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    // A corrupt journal is not a reason to refuse the run: it is resume state,
    // not the record of truth. The run proceeds as if it were the first one.
    return undefined;
  }
}

/**
 * Read-only. Computes what each step would do, without writing anything —
 * including the journal.
 */
export async function buildInstallPlan(input: {
  metaprojectRoot: string;
  intent: string;
  steps: readonly InstallStep[];
  writerVersion?: string;
}): Promise<InstallPlan> {
  const writerVersion = input.writerVersion ?? currentWriterVersion();
  const previous = (await readInstallJournal(input.metaprojectRoot)) ?? null;
  const inputFingerprint = fingerprint(input.steps);
  const planId = `${input.intent}:${inputFingerprint.slice(7, 19)}`;

  const steps: PlannedStep[] = [];
  const carriedOver: string[] = [];
  for (const step of input.steps) {
    const onDisk = await readIfPresent(step.path);
    const expectedBaseDigest = onDisk === undefined ? null : digestOf(onDisk);
    const plannedDigest = digestOf(step.content);
    const record = previous?.steps[step.id] ?? null;
    const recordedWriterVersion = record?.writerVersion ?? null;
    const previouslyBegun = record?.status === "begun";
    if (previouslyBegun) {
      carriedOver.push(step.id);
    }
    const versionTransition =
      recordedWriterVersion !== null && recordedWriterVersion !== writerVersion
        ? { from: recordedWriterVersion, to: writerVersion }
        : null;

    const base = {
      id: step.id,
      path: step.path,
      mode: step.mode,
      content: step.content,
      expectedBaseDigest,
      plannedDigest,
      recordedWriterVersion,
      recordedDigest: record?.digest ?? null,
      versionTransition,
      previouslyBegun,
    };

    if (onDisk === undefined) {
      steps.push({ ...base, outcome: "create", reason: null });
      continue;
    }
    if (onDisk === step.content) {
      steps.push({ ...base, outcome: "skip", reason: "already-current" });
      continue;
    }
    if (step.mode === "create-if-absent") {
      steps.push({ ...base, outcome: "skip", reason: "present-create-if-absent" });
      continue;
    }
    // Bytes differ. Whether that is safe to replace depends on whether the
    // recorded writer can account for what is there now.
    const accountedFor = record !== null && record.digest === expectedBaseDigest;
    if (versionTransition !== null && !accountedFor) {
      steps.push({ ...base, outcome: "conflict", reason: "version-divergence" });
      continue;
    }
    steps.push({
      ...base,
      outcome: "update",
      reason: versionTransition !== null ? "version-transition" : record !== null && !accountedFor ? "base-drift" : null,
    });
  }

  return {
    metaprojectRoot: input.metaprojectRoot,
    journalPath: installJournalPath(input.metaprojectRoot),
    intent: input.intent,
    planId,
    inputFingerprint,
    writerVersion,
    steps,
    carriedOver,
    previous,
  };
}

/**
 * Applies the plan in order. A conflict without a resolution publishes nothing
 * at all — the routing pair is a joint invariant, so a half-new pair is worse
 * than an untouched one.
 */
export async function applyInstallPlan(input: {
  plan: InstallPlan;
  resolution?: DivergenceResolution;
  now?: () => Date;
  /** Test seam: fires after the durable `begun` record and before the write. */
  beforeStepMutation?: (stepId: string) => void | Promise<void>;
}): Promise<InstallApplyReport> {
  const { plan } = input;
  const now = input.now ?? (() => new Date());
  const conflicts = plan.steps.filter((step) => step.outcome === "conflict");
  const notices: string[] = [];

  for (const id of plan.carriedOver) {
    const record = plan.previous?.steps[id];
    notices.push(
      `${id}: an earlier run began this step at ${record?.startedAt ?? "an unrecorded time"} and never recorded an outcome. ` +
        `It is not rolled back; this run re-applies the same content.`,
    );
  }

  if (conflicts.length > 0 && input.resolution === undefined) {
    const blocked = conflicts.map((step) => toBlockedStep(step, plan));
    return {
      intent: plan.intent,
      planId: plan.planId,
      writerVersion: plan.writerVersion,
      completed: [],
      skipped: [],
      kept: [],
      failed: [],
      blocked,
      pending: plan.steps.filter((step) => step.outcome !== "conflict").map((step) => step.id),
      carriedOver: plan.carriedOver,
      notices: [...notices, ...conflicts.map((step) => formatConflictLine(step, plan.writerVersion))],
    };
  }

  const startedAt = now().toISOString();
  const journal: {
    schemaVersion: "1.0";
    writerVersion: string;
    intent: string;
    planId: string;
    inputFingerprint: string;
    startedAt: string;
    updatedAt: string;
    steps: Record<string, InstallJournalStep>;
  } = {
    schemaVersion: "1.0",
    writerVersion: plan.writerVersion,
    intent: plan.intent,
    planId: plan.planId,
    inputFingerprint: plan.inputFingerprint,
    startedAt: plan.previous?.planId === plan.planId ? (plan.previous?.startedAt ?? startedAt) : startedAt,
    updatedAt: startedAt,
    steps: { ...(plan.previous?.steps ?? {}) },
  };

  const completed: string[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const pending: string[] = [];

  const writeJournal = async (): Promise<void> => {
    journal.updatedAt = now().toISOString();
    await writeFileAtomic(plan.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  };

  for (const [index, step] of plan.steps.entries()) {
    if (step.outcome === "conflict") {
      if (input.resolution === "keep-existing") {
        kept.push(step.id);
        // Deliberately keep the PREVIOUS writer's version and digest as the
        // record of record. Stamping this run's version here would launder the
        // divergence into "ours" and let the very next plain run overwrite it
        // silently — the exact thing the conflict exists to prevent. Keeping is
        // "not now", not "resolved".
        const previousRecord = plan.previous?.steps[step.id];
        journal.steps[step.id] = {
          status: "kept",
          writerVersion: step.recordedWriterVersion ?? plan.writerVersion,
          planId: previousRecord?.planId ?? plan.planId,
          intent: previousRecord?.intent ?? plan.intent,
          startedAt: previousRecord?.startedAt ?? now().toISOString(),
          completedAt: now().toISOString(),
          digest: step.recordedDigest ?? step.plannedDigest,
          baseDigest: step.expectedBaseDigest,
        };
        await writeJournal();
        notices.push(
          `${step.id}: kept the bytes on disk unchanged (--keep-existing). ` +
            `They were last accounted for by writer ${step.recordedWriterVersion ?? "unknown"}; ` +
            `${plan.writerVersion} did not publish this target. The divergence stays unresolved and ` +
            `every later run reports it again until --accept-version is used or the file is restored.`,
        );
        continue;
      }
      notices.push(
        `${step.id}: replaced bytes that writer ${step.recordedWriterVersion ?? "unknown"} last accounted for ` +
          `(--accept-version). The replacement happened and is not undoable.`,
      );
    } else if (step.outcome === "skip") {
      skipped.push(step.id);
      if (step.reason === "already-current" && step.expectedBaseDigest !== null) {
        // Re-stamp ownership so a later run knows which version's bytes these are.
        journal.steps[step.id] = {
          status: "completed",
          writerVersion: plan.writerVersion,
          planId: plan.planId,
          intent: plan.intent,
          startedAt: journal.steps[step.id]?.startedAt ?? now().toISOString(),
          completedAt: now().toISOString(),
          digest: step.expectedBaseDigest,
          baseDigest: step.expectedBaseDigest,
        };
        await writeJournal();
      }
      continue;
    }

    if (step.versionTransition !== null && step.outcome !== "conflict") {
      notices.push(
        `${step.id}: last published by writer ${step.versionTransition.from}; ${step.versionTransition.to} is republishing it.`,
      );
    } else if (step.reason === "base-drift") {
      notices.push(`${step.id}: on-disk bytes drifted from this writer's own record and are being republished.`);
    }

    // The record that this step BEGAN is durable before the step runs. Without
    // it a restart cannot tell "never started" from "already applied".
    journal.steps[step.id] = {
      status: "begun",
      writerVersion: plan.writerVersion,
      planId: plan.planId,
      intent: plan.intent,
      startedAt: now().toISOString(),
      digest: step.plannedDigest,
      baseDigest: step.expectedBaseDigest,
    };
    await writeJournal();

    try {
      await input.beforeStepMutation?.(step.id);
      await writeFileAtomic(step.path, step.content);
    } catch (error) {
      if (error instanceof InstallCrashSignal) {
        // A dead process records nothing. Leave `begun` exactly as it stands.
        throw error;
      }
      const previousRecord = journal.steps[step.id];
      journal.steps[step.id] = {
        status: "failed",
        writerVersion: plan.writerVersion,
        planId: plan.planId,
        intent: plan.intent,
        startedAt: previousRecord?.startedAt ?? now().toISOString(),
        completedAt: now().toISOString(),
        digest: step.plannedDigest,
        baseDigest: step.expectedBaseDigest,
        error: error instanceof Error ? error.message : String(error),
      };
      await writeJournal().catch(() => {});
      failed.push({ id: step.id, error: error instanceof Error ? error.message : String(error) });
      pending.push(...plan.steps.slice(index + 1).map((rest) => rest.id));
      throw error;
    }

    journal.steps[step.id] = {
      status: "completed",
      writerVersion: plan.writerVersion,
      planId: plan.planId,
      intent: plan.intent,
      startedAt: journal.steps[step.id]?.startedAt ?? now().toISOString(),
      completedAt: now().toISOString(),
      digest: step.plannedDigest,
      baseDigest: step.expectedBaseDigest,
    };
    await writeJournal();
    completed.push(step.id);
  }

  return {
    intent: plan.intent,
    planId: plan.planId,
    writerVersion: plan.writerVersion,
    completed,
    skipped,
    kept,
    failed,
    blocked: [],
    pending,
    carriedOver: plan.carriedOver,
    notices,
  };
}

/** Human preview. Never called for its side effects — it has none. */
export function formatInstallPlan(
  plan: InstallPlan,
  options: { resolution?: DivergenceResolution; notes?: readonly string[]; relativeTo?: string } = {},
): string {
  const relativeTo = options.relativeTo ?? path.dirname(plan.metaprojectRoot);
  const lines: string[] = [];
  lines.push(`# keryx ${plan.intent} preview`);
  lines.push("");
  lines.push(`plan ${plan.planId} · writer ${plan.writerVersion} · fingerprint ${plan.inputFingerprint}`);
  lines.push("This preview writes nothing: no target, no journal.");
  lines.push("");

  for (const step of plan.steps) {
    const target = path.relative(relativeTo, step.path);
    const suffix =
      step.outcome === "conflict"
        ? ` (written by ${step.recordedWriterVersion ?? "unknown"}, running ${plan.writerVersion})`
        : step.reason !== null
          ? ` (${step.reason})`
          : "";
    lines.push(`  ${step.outcome.padEnd(8)} ${step.id.padEnd(22)} ${target}${suffix}`);
    lines.push(`           base    ${step.expectedBaseDigest ?? "absent"}`);
    lines.push(`           planned ${step.plannedDigest}`);
  }

  const counts = countOutcomes(plan);
  lines.push("");
  lines.push(
    `summary: create ${counts.create}, update ${counts.update}, skip ${counts.skip}, conflict ${counts.conflict}`,
  );

  if (plan.carriedOver.length > 0) {
    lines.push("");
    lines.push("Interrupted by an earlier run:");
    for (const id of plan.carriedOver) {
      const record = plan.previous?.steps[id];
      lines.push(
        `  ${id} was begun at ${record?.startedAt ?? "an unrecorded time"} and never recorded an outcome. ` +
          `It is not rolled back; this run re-applies the same content.`,
      );
    }
  }

  if (counts.conflict > 0) {
    lines.push("");
    lines.push("Conflicts need a resolution before anything is published:");
    for (const step of plan.steps.filter((entry) => entry.outcome === "conflict")) {
      lines.push(`  ${formatConflictLine(step, plan.writerVersion)}`);
    }
    lines.push("  --accept-version   publish this version's content over the divergent bytes (not undoable)");
    lines.push("  --keep-existing    leave the divergent bytes in place and record that this run did not publish them");
  }

  if (options.resolution !== undefined) {
    lines.push("");
    lines.push(`resolution: --${options.resolution}`);
  }

  lines.push("");
  lines.push(
    "Scope: this plan covers the digest-planned lifecycle artifacts listed above. " +
      "It reports a truthful partial state and resumes; it never promises a rollback.",
  );
  for (const note of options.notes ?? []) {
    lines.push(`  ${note}`);
  }
  return lines.join("\n");
}

/**
 * True when the run has something a reader has to know: an interrupted step it
 * did not roll back, a version transition, a kept divergence, or a failure.
 * A clean, fully idempotent run stays silent, so the default install/update
 * output is unchanged from before the plan existed.
 */
export function applyReportIsNoteworthy(report: InstallApplyReport): boolean {
  return (
    report.notices.length > 0 ||
    report.failed.length > 0 ||
    report.kept.length > 0 ||
    report.blocked.length > 0 ||
    report.carriedOver.length > 0
  );
}

export function formatApplyReport(report: InstallApplyReport): string {
  const lines: string[] = [];
  lines.push(
    `lifecycle: completed ${report.completed.length}, skipped ${report.skipped.length}, ` +
      `kept ${report.kept.length}, failed ${report.failed.length}, blocked ${report.blocked.length}, pending ${report.pending.length}`,
  );
  for (const notice of report.notices) {
    lines.push(`  ${notice}`);
  }
  for (const entry of report.failed) {
    lines.push(`  ${entry.id}: failed after it began — ${entry.error}. It is not rolled back.`);
  }
  return lines.join("\n");
}

export function blockedMessage(report: InstallApplyReport): string {
  const lines = [
    `keryx ${report.intent} published nothing: ${report.blocked.length} lifecycle target(s) diverged from what this writer recorded.`,
  ];
  for (const notice of report.notices) {
    lines.push(`  ${notice}`);
  }
  lines.push("  --accept-version   publish this version's content over the divergent bytes (not undoable)");
  lines.push("  --keep-existing    leave the divergent bytes in place and record that this run did not publish them");
  return lines.join("\n");
}

function toBlockedStep(step: PlannedStep, plan: InstallPlan): BlockedStep {
  return {
    id: step.id,
    path: step.path,
    recordedWriterVersion: step.recordedWriterVersion,
    writerVersion: plan.writerVersion,
    expectedBaseDigest: step.expectedBaseDigest,
    recordedDigest: plan.previous?.steps[step.id]?.digest ?? null,
  };
}

function formatConflictLine(step: PlannedStep, writerVersion: string): string {
  return (
    `${step.id}: on disk is ${step.expectedBaseDigest ?? "absent"}, but writer ` +
    `${step.recordedWriterVersion ?? "unknown"} last published ${step.recordedDigest ?? "nothing recorded"} ` +
    `and ${writerVersion} is now running. Those bytes are accounted for by neither version.`
  );
}

function countOutcomes(plan: InstallPlan): Record<PlannedOutcome, number> {
  const counts: Record<PlannedOutcome, number> = { create: 0, update: 0, skip: 0, conflict: 0 };
  for (const step of plan.steps) {
    counts[step.outcome] += 1;
  }
  return counts;
}

function fingerprint(steps: readonly InstallStep[]): string {
  return digestOf(JSON.stringify(steps.map((step) => [step.id, step.mode, digestOf(step.content)])));
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    // A target that exists but cannot be read as text (a directory, say) is not
    // "absent": treat it as present-and-unreadable so the write path — not the
    // planner — reports the real failure, exactly as it does today.
    return undefined;
  }
}
