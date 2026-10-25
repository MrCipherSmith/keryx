import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertWritableContained, writeContained } from "../lib/contained-write";
import { isNotFound, withFileLock } from "../lib/fs";
import { applyEvidence, confidenceLevelFor } from "./confidence";
import { assertValidLearningId } from "./paths";
import { updatePattern, withPatternSnapshot } from "./store";
import { validateProbeCheckpoint, validateProbeComparison, validateProbePlan } from "./probe-schema";
import type { ProbeCheckpoint, ProbeComparison, ProbeEnvironment, ProbeFinalization, ProbePlan, ProbeSeedCheckpoint } from "./probe-schema";
import type { ProbeScore } from "./probe-score";
import type { LearnedPattern } from "./types";

export { retainProbeRuns } from "./probe-retention";

/** Read-only discovery; the session lock revalidates every recovery artifact. */
export async function findPublishedProbePlan(root: string, patternId: string, taskId: string,
  environment: ProbeEnvironment, request: ProbePlan["request"]): Promise<ProbeSessionResult<ProbePlan | undefined>> {
  try {
    assertValidLearningId(patternId);
    const directory = `.metaproject/data/learning/probes/${patternId}`;
    await assertWritableContained(root, `${directory}/discovery.json`);
    const { readdir } = await import("node:fs/promises");
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
    catch (error) { if (isNotFound(error)) return { ok: true, value: undefined }; throw error; }
    const candidates: ProbePlan[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{12}$/.test(entry.name)) continue;
      const prefix = `${directory}/${entry.name}`;
      await assertWritableContained(root, `${prefix}/plan.json`);
      await assertWritableContained(root, `${prefix}/comparison.json`);
      if (await optionalBytes(path.join(root, prefix, "comparison.json")) === undefined) continue;
      const bytes = await optionalBytes(path.join(root, prefix, "plan.json"));
      const plan = JSON.parse(bytes ?? "null") as ProbePlan;
      check(validateProbePlan(plan, { persisted: true }));
      if (plan.patternId !== patternId || plan.probeId !== entry.name || identity(plan) !== plan.identityDigest)
        throw new ProbeError("probe-environment-mismatch", "invalid recovery identity");
      if (plan.taskId === taskId && JSON.stringify(plan.environment) === JSON.stringify(environment)
        && JSON.stringify(plan.request) === JSON.stringify(request)) candidates.push(plan);
    }
    if (candidates.length > 1) throw new ProbeError("probe-environment-mismatch", "ambiguous published recovery");
    return { ok: true, value: candidates[0] };
  } catch (error) {
    return { ok: false, reason: "probe-environment-mismatch", message: error instanceof Error ? error.message : String(error) };
  }
}


export function hashProbeBytes(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function probePatternDigest(trigger: string, action: string): string { return hashProbeBytes(JSON.stringify([trigger, action])); }
export interface ProbePlanInput {
  pattern: LearnedPattern; taskId: string; environment: ProbeEnvironment; runs: number;
  maxUsd: number | null; estimateUsd: number | null; createdAt: string;
}
function identity(p: Pick<ProbePlan, "patternId" | "patternDigest" | "taskId" | "environment" | "request">): string {
  const fields = [p.patternId, p.patternDigest, p.taskId, p.environment.model, p.environment.provider,
    p.environment.commit, p.environment.taskSetDigest, String(p.request.runs)];
  if (fields.some((v) => v.includes("\0"))) throw new Error("probe identity contains NUL");
  return hashProbeBytes(fields.join("\0"));
}
export function buildProbePlan(input: ProbePlanInput): ProbePlan {
  const { pattern: p } = input;
  if (p.scope !== "project" || (p.status !== "candidate" && p.status !== "accepted")) throw new Error("probe requires eligible project pattern");
  const body = { patternId: p.id, patternDigest: probePatternDigest(p.trigger, p.action), taskId: input.taskId,
    environment: input.environment, request: { runs: input.runs, maxUsd: input.maxUsd } };
  const digest = identity(body);
  const plan: ProbePlan = { schemaVersion: 1, ...body, identityDigest: digest, probeId: digest.slice(0, 12),
    snapshot: { status: p.status, trigger: p.trigger, action: p.action }, createdAt: input.createdAt, estimateUsd: input.estimateUsd };
  check(validateProbePlan(plan)); return plan;
}
function check(result: { ok: boolean; errors: string[] }): void {
  if (!result.ok) throw new ProbeError("probe-environment-mismatch", result.errors.join("; "));
}
class ProbeError extends Error { constructor(readonly reason: string, message: string) { super(message); } }
export type ProbeWriteBoundary = "plan" | "checkpoint" | "comparison" | "finalizing" | "record" | "marker";
export interface ProbeSessionOptions { afterWrite?: (boundary: ProbeWriteBoundary) => Promise<void> }
export type ProbeSessionResult<T> = { ok: true; value: T } | { ok: false; reason: string; message: string };
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function optionalBytes(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
}
function matches(record: LearnedPattern | undefined, plan: ProbePlan): boolean {
  return record?.scope === "project" && record.status === plan.snapshot.status
    && record.trigger === plan.snapshot.trigger && record.action === plan.snapshot.action;
}
export class ProbeSession {
  comparison: ProbeComparison | undefined;
  readonly planDigest: string;
  readonly directory: string;
  constructor(readonly root: string, readonly plan: ProbePlan, readonly checkpoint: ProbeCheckpoint,
    readonly resumed: boolean, planBytes: string, private readonly options: ProbeSessionOptions) {
    this.planDigest = hashProbeBytes(planBytes);
    this.directory = `.metaproject/data/learning/probes/${plan.patternId}/${plan.probeId}`;
  }
  transcriptPath(arm: "base" | "probe", seed: number): string {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed >= this.plan.request.runs) throw new Error("invalid seed");
    return `${this.directory}/runs/${arm}/${seed}.ndjson`;
  }
  private async save(boundary: ProbeWriteBoundary = "checkpoint"): Promise<void> {
    this.checkpoint.updatedAt = new Date().toISOString(); check(validateProbeCheckpoint(this.checkpoint));
    await writeContained(this.root, `${this.directory}/checkpoint.json`, encode(this.checkpoint));
    await this.options.afterWrite?.(boundary);
  }
  async recover(): Promise<void> {
    let changed = false;
    for (const seed of this.checkpoint.seeds) {
      if (seed.transcript !== this.transcriptPath(seed.arm, seed.seed)) throw new ProbeError("probe-environment-mismatch", "transcript path mismatch");
      if (seed.state === "completed") await this.verifyTranscript(seed);
      if (seed.state === "running") {
        this.checkpoint.spendUsd += seed.reservedUsd;
        seed.chargedUsd += seed.reservedUsd; seed.reservedUsd = 0; seed.state = "failed";
        seed.answered = false; seed.success = false; changed = true;
      }
    }
    if (changed) { this.checkpoint.reservedUsd = 0; await this.save(); }
  }
  async reserve(arm: "base" | "probe", seed: number, reservedUsd: number): Promise<void> {
    if (this.comparison || this.checkpoint.phase !== "running") throw new Error("probe already published");
    const transcript = this.transcriptPath(arm, seed);
    if (this.checkpoint.seeds.some((s) => s.arm === arm && s.seed === seed)) throw new Error("seed already attempted");
    const ceiling = this.plan.request.maxUsd;
    if (ceiling === null || !Number.isFinite(reservedUsd) || reservedUsd <= 0
      || this.checkpoint.spendUsd + this.checkpoint.reservedUsd + reservedUsd > ceiling) throw new ProbeError("probe-budget-exceeded", "reservation exceeds ceiling");
    this.checkpoint.seeds.push({ arm, seed, transcript, planDigest: this.planDigest, state: "running",
      answered: false, success: false, chargedUsd: 0, reservedUsd });
    this.checkpoint.reservedUsd += reservedUsd; await this.save();
  }
  private async verifyTranscript(seed: ProbeSeedCheckpoint): Promise<void> {
    const bytes = await optionalBytes(path.join(this.root, seed.transcript));
    if (!bytes || !bytes.endsWith("\n")) throw new ProbeError("probe-environment-mismatch", "incomplete transcript");
    const events = bytes.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = events.at(-1);
    if (last?.type !== "probe-result" || last.answered !== seed.answered || last.success !== seed.success)
      throw new ProbeError("probe-environment-mismatch", "transcript result mismatch");
  }
  async complete(arm: "base" | "probe", seed: number, result: { answered: boolean; success: boolean; chargedUsd: number }): Promise<void> {
    const entry = this.checkpoint.seeds.find((s) => s.arm === arm && s.seed === seed);
    if (!entry || entry.state !== "running" || !Number.isFinite(result.chargedUsd) || result.chargedUsd < 0) throw new Error("invalid seed completion");
    const next = { ...entry, ...result, state: "completed" as const, reservedUsd: 0 };
    await this.verifyTranscript(next);
    this.checkpoint.reservedUsd = Math.max(0, this.checkpoint.reservedUsd - entry.reservedUsd);
    this.checkpoint.spendUsd += result.chargedUsd; Object.assign(entry, next); await this.save();
  }
  async publish(score: ProbeScore): Promise<void> {
    if (this.comparison) return;
    if (this.checkpoint.seeds.some((s) => s.state === "running")) throw new Error("cannot publish running seeds");
    await withPatternSnapshot(this.root, this.plan.patternId, "project", async (record) => {
      const finalScore: ProbeScore = matches(record, this.plan) ? score : {
        verdict: "unmeasurable", reason: "environment-drift", arms: { base: null, probe: null }, delta: null };
      const { probeId, identityDigest, patternId, patternDigest, taskId, environment } = this.plan;
      const comparison: ProbeComparison = { schemaVersion: 1, probeId, identityDigest, patternId, patternDigest, taskId,
        environment, createdAt: new Date().toISOString(), resumed: this.resumed, ...finalScore,
        runs: this.checkpoint.seeds.map(({ arm, seed, answered, success, transcript }) => ({ arm, seed, answered, success, transcript })) };
      check(validateProbeComparison(comparison));
      await writeContained(this.root, `${this.directory}/comparison.json`, encode(comparison)); this.comparison = comparison;
      await this.options.afterWrite?.("comparison");
    });
  }
  async finalize(): Promise<ProbeFinalization> {
    const comparison = this.comparison;
    if (!comparison) throw new Error("comparison must be published before finalization");
    this.checkpoint.phase = "finalizing"; await this.save("finalizing");
    let outcome: ProbeFinalization = { evidence: "not-needed" };
    if (comparison.verdict === "improved" || comparison.verdict === "regressed") {
      const sourceRef = `${this.directory}/comparison.json`;
      // Throwing the local sentinel deliberately prevents a redundant record write.
      const noWrite = new Error("no record write required");
      try {
        await updatePattern(this.root, this.plan.patternId, "project", (current) => {
          if (current.evidence.some((e) => e.sourceType === "probe" && e.sourceRef === sourceRef)) {
            outcome = { evidence: "applied" }; throw noWrite;
          }
          if (!matches(current, this.plan)) { outcome = { evidence: "skipped", reason: "environment-drift" }; throw noWrite; }
          const kind = comparison.verdict === "improved" ? "reinforcement" : "contradiction";
          const weight = kind === "reinforcement" ? 1 : 1.5;
          const confidence = applyEvidence(current.confidence, kind, weight);
          outcome = { evidence: "applied" };
          return { ...current, confidence, confidenceLevel: confidenceLevelFor(confidence), updatedAt: new Date().toISOString(),
            evidence: [...current.evidence, { kind, weight, sourceType: "probe", sourceRef, observedAt: comparison.createdAt }] };
        });
      } catch (error) { if (error !== noWrite) throw error; }
      await this.options.afterWrite?.("record");
    }
    this.checkpoint.phase = "finalized"; this.checkpoint.finalization = outcome; await this.save("marker"); return outcome;
  }
}
/** One lock spans validation, paid calls and finalization; scope locks are short and nested only in this direction. */
export async function runProbeSession<T>(root: string, intent: ProbePlan,
  work: (session: ProbeSession) => Promise<T>, options: ProbeSessionOptions = {}): Promise<ProbeSessionResult<T>> {
  try {
    check(validateProbePlan(intent, { persisted: true })); assertValidLearningId(intent.patternId);
    if (identity(intent) !== intent.identityDigest || probePatternDigest(intent.snapshot.trigger, intent.snapshot.action) !== intent.patternDigest)
      throw new ProbeError("probe-environment-mismatch", "identity mismatch");
    const directory = `.metaproject/data/learning/probes/${intent.patternId}/${intent.probeId}`;
    await assertWritableContained(root, `${directory}/probe.lock`, "directory");
    for (const artifact of ["plan.json", "checkpoint.json", "comparison.json"]) {
      await assertWritableContained(root, `${directory}/${artifact}`);
    }
    return await withFileLock(path.join(root, directory, "probe.lock"), async () => {
      let planBytes = await optionalBytes(path.join(root, directory, "plan.json"));
      const resumed = planBytes !== undefined;
      if (planBytes === undefined) {
        planBytes = encode(intent); await writeContained(root, `${directory}/plan.json`, planBytes); await options.afterWrite?.("plan");
      }
      const plan = JSON.parse(planBytes) as ProbePlan; check(validateProbePlan(plan, { persisted: true }));
      if (identity(plan) !== plan.identityDigest || probePatternDigest(plan.snapshot.trigger, plan.snapshot.action) !== plan.patternDigest
        || plan.identityDigest !== intent.identityDigest || JSON.stringify(plan.environment) !== JSON.stringify(intent.environment)
        || JSON.stringify(plan.request) !== JSON.stringify(intent.request) || JSON.stringify(plan.snapshot) !== JSON.stringify(intent.snapshot))
        throw new ProbeError("probe-environment-mismatch", "persisted plan does not match invocation");
      const planDigest = hashProbeBytes(planBytes);
      const cpBytes = await optionalBytes(path.join(root, directory, "checkpoint.json"));
      const checkpoint: ProbeCheckpoint = cpBytes === undefined ? { schemaVersion: 1, probeId: plan.probeId,
        planDigest, updatedAt: new Date().toISOString(), phase: "running", spendUsd: 0, reservedUsd: 0, seeds: [], finalization: null }
        : JSON.parse(cpBytes) as ProbeCheckpoint;
      check(validateProbeCheckpoint(checkpoint));
      if (checkpoint.probeId !== plan.probeId || checkpoint.planDigest !== planDigest
        || Math.abs(checkpoint.reservedUsd - checkpoint.seeds.reduce((n, s) => n + s.reservedUsd, 0)) > 1e-9
        || Math.abs(checkpoint.spendUsd - checkpoint.seeds.reduce((n, s) => n + s.chargedUsd, 0)) > 1e-9)
        throw new ProbeError("probe-environment-mismatch", "checkpoint linkage or accounting mismatch");
      const session = new ProbeSession(root, plan, checkpoint, resumed, planBytes, options);
      for (const seed of checkpoint.seeds) {
        if (seed.seed >= plan.request.runs || seed.transcript !== session.transcriptPath(seed.arm, seed.seed))
          throw new ProbeError("probe-environment-mismatch", "seed linkage mismatch");
        await assertWritableContained(root, seed.transcript);
      }
      const comparisonBytes = await optionalBytes(path.join(root, directory, "comparison.json"));
      if (comparisonBytes !== undefined) {
        const c = JSON.parse(comparisonBytes) as ProbeComparison; check(validateProbeComparison(c));
        if (c.identityDigest !== plan.identityDigest || c.patternDigest !== plan.patternDigest || c.patternId !== plan.patternId
          || c.taskId !== plan.taskId || JSON.stringify(c.environment) !== JSON.stringify(plan.environment))
          throw new ProbeError("probe-environment-mismatch", "comparison linkage mismatch");
        const runs = checkpoint.seeds.map(({ arm, seed, answered, success, transcript }) => ({ arm, seed, answered, success, transcript }));
        if (JSON.stringify(c.runs) !== JSON.stringify(runs) || checkpoint.seeds.some((seed) => seed.state === "running"))
          throw new ProbeError("probe-environment-mismatch", "comparison runs mismatch");
        session.comparison = c;
      }
      if (checkpoint.phase === "finalized") {
        if (!session.comparison || checkpoint.finalization === null) throw new ProbeError("probe-environment-mismatch", "missing finalization artifact");
        throw new ProbeError("probe-already-completed", "probe has already completed");
      }
      if (cpBytes === undefined) {
        await writeContained(root, `${directory}/checkpoint.json`, encode(checkpoint)); await options.afterWrite?.("checkpoint");
      }
      if (checkpoint.phase !== "running" && !session.comparison)
        throw new ProbeError("probe-environment-mismatch", "missing comparison");
      if (!session.comparison) await session.recover();
      return { ok: true as const, value: await work(session) };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof ProbeError ? error.reason : error instanceof SyntaxError ? "probe-environment-mismatch" : "probe-run-failed",
      message: error instanceof Error ? error.message : String(error) };
  }
}
