import { redactSensitiveText } from "../../security/service";
import { writeContained } from "../../lib/contained-write";
import type { ProbeSession } from "../../learning/probe";
import type { ProbeTask, ProbeComparison, ProbeFinalization } from "../../learning/probe-schema";
import { scoreProbe, type ProbeArmCounts } from "../../learning/service";

export type ProbeArm = "base" | "probe";
export interface ProbeTurnInput {
  root: string; arm: ProbeArm; seed: number; instructions: string; prompt: string;
  checkpointPath: string; signal?: AbortSignal;
}
export interface ProbeTurnResult { answer: string; chargedUsd?: number; events: unknown[] }
/** Side effects stay outside the durable execution policy; implementations must be read-only. */
export interface ProbeRunnerPort {
  reconcile(): Promise<void>;
  prepare(task: ProbeTask): Promise<{ goldClean: boolean; environmentMatches: boolean; roots: Record<ProbeArm, string> }>;
  turn(input: ProbeTurnInput): Promise<ProbeTurnResult>;
  cleanup(): Promise<void>;
}
export function probeInstructions(baseline: string, pattern: { id: string; trigger: string; action: string }, arm: ProbeArm): string {
  return arm === "base" ? baseline : `${baseline}\n<learned-pattern id="${pattern.id}">\nWhen ${pattern.trigger}, ${pattern.action}.\n</learned-pattern>`;
}
function answeredCorrectly(task: ProbeTask, answer: string): { answered: boolean; success: boolean } {
  const match = /^FILE:\s*(.+?)\s+SYMBOL:\s*(\S+)\s*$/i.exec(answer.trim());
  return { answered: answer.trim().length > 0, success: !!match
    && match[1]!.replace(/^\.\//, "") === task.expect.file.replace(/^\.\//, "")
    && match[2]! === task.expect.symbol };
}
/** Scrub every durable string, including raw tool results, errors and object keys. */
function redactTranscript(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactTranscript);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redactSensitiveText(key), redactTranscript(item)]),
  );
  return value;
}
async function executeSeed(s: ProbeSession, task: ProbeTask, port: ProbeRunnerPort,
  input: ProbeTurnInput, reservation: number): Promise<boolean> {
  await s.reserve(input.arm, input.seed, reservation);
  let result: ProbeTurnResult;
  let failed = false;
  try { result = await port.turn(input); }
  catch (error) { failed = true; result = { answer: "", events: [{ type: "probe-error", message: error instanceof Error ? error.message : String(error) }] }; }
  const outcome = answeredCorrectly(task, result.answer);
  const chargedUsd = result.chargedUsd === undefined ? reservation : result.chargedUsd;
  if (!Number.isFinite(chargedUsd) || chargedUsd < 0) {
    // An invalid receipt cannot make an uncertain paid call free.
    await s.recover(); return false;
  }
  const transcript = [...result.events, { type: "probe-answer", content: result.answer }, { type: "probe-result", ...outcome }]
    .map((event) => JSON.stringify(redactTranscript(event))).join("\n") + "\n";
  await writeContained(s.root, s.transcriptPath(input.arm, input.seed), transcript);
  await s.complete(input.arm, input.seed, { ...outcome, chargedUsd });
  return !failed && outcome.answered;
}
export async function executeProbe(s: ProbeSession, task: ProbeTask | undefined, port: ProbeRunnerPort,
  options: { baseline: string; reservationUsd: number; signal?: AbortSignal }): Promise<{ comparison: ProbeComparison; finalization: ProbeFinalization }> {
  if (s.comparison) return { comparison: s.comparison, finalization: await s.finalize() };
  let goldClean = true; let environmentMatches = true; let failed = s.checkpoint.seeds.some((v) => v.state === "failed");
  const ceiling = s.plan.request.maxUsd!;
  let budgetExceeded = s.checkpoint.spendUsd > ceiling;
  const powered = task && s.plan.request.runs >= (task.kind === "stochastic" ? 3 : 1);
  try {
    await port.reconcile();
    if (powered && !failed && !budgetExceeded) {
      const prepared = await port.prepare(task); goldClean = prepared.goldClean; environmentMatches = prepared.environmentMatches;
      if (goldClean && environmentMatches) outer: for (const arm of ["base", "probe"] as const) {
        for (let seed = 0; seed < s.plan.request.runs; seed++) {
          if (s.checkpoint.seeds.some((v) => v.arm === arm && v.seed === seed && v.state === "completed")) continue;
          if (options.signal?.aborted) { failed = true; break outer; }
          const remaining = ceiling - s.checkpoint.spendUsd - s.checkpoint.reservedUsd;
          if (!(remaining >= options.reservationUsd) || !(options.reservationUsd > 0) || !Number.isFinite(options.reservationUsd)) { budgetExceeded = true; break outer; }
          const ok = await executeSeed(s, task, port, { arm, seed, root: prepared.roots[arm],
            instructions: probeInstructions(options.baseline, { id: s.plan.patternId, ...s.plan.snapshot }, arm),
            prompt: task.prompt, checkpointPath: `${s.directory}/checkpoint.json`, ...(options.signal ? { signal: options.signal } : {}) }, options.reservationUsd);
          if (s.checkpoint.spendUsd > ceiling) { budgetExceeded = true; break outer; }
          if (!ok) { failed = true; break outer; }
        }
      }
    }
  } catch {
    failed = true;
    // Recover any persisted reservation; I/O errors remain visible if recovery fails.
    await s.recover();
  } finally {
    try { await port.cleanup(); } catch { failed = true; }
  }
  const counts = (arm: ProbeArm): ProbeArmCounts => {
    const entries = s.checkpoint.seeds.filter((v) => v.arm === arm);
    return { seeds: entries.length, successes: entries.filter((v) => v.success).length,
      answered: entries.filter((v) => v.answered).length, failed: entries.filter((v) => v.state !== "completed").length + (failed ? 1 : 0) };
  };
  await s.publish(scoreProbe({ taskKind: task?.kind ?? null, seeds: s.plan.request.runs, goldClean,
    environmentMatches, budgetExceeded, arms: { base: counts("base"), probe: counts("probe") } }));
  return { comparison: s.comparison!, finalization: await s.finalize() };
}
