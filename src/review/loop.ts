/**
 * Loop *detection*, not loop counting (AC9).
 *
 * # The defect
 *
 * The round bound fires on attempt count alone. An agent that produces the
 * identical failing output three times spends the entire budget before anything
 * notices, and the only thing the bound then reports is that the budget ran out
 * — which is indistinguishable from a hard problem that needed all three rounds.
 *
 * A counter cannot tell "making progress slowly" from "stuck". Repetition can.
 * OpenHands ships a stuck detector with five patterns, on by default, for
 * exactly this reason.
 *
 * # What fires
 *
 * - **The same finding recurring in two rounds.** A fix round exists to remove a
 *   finding; the same finding surviving into the next round is the fix failing,
 *   and the second occurrence is enough — waiting for a third spends a round to
 *   learn something already known.
 * - **Two consecutive rounds producing identical review output.** Nothing
 *   changed. Not "little changed": the same bytes, after whitespace and
 *   timestamp normalisation.
 *
 * # Regardless of remaining budget
 *
 * {@link detectReviewLoop} does not take a budget, a round bound, or an attempt
 * limit as an input, and this is deliberate. A detector that is handed the
 * remaining budget is a detector that can be argued out of firing — "two rounds
 * left, keep going" — and the whole point is that the repetition is decisive on
 * its own. The attempt count is carried on the result as CONTEXT for the report,
 * never as a condition on `escalate`.
 *
 * The counts it reads are the persisted ones: review packages on disk, and
 * `tasks[].attempts.count` from `flow.json`, which flow 201 put there precisely
 * so a bound survives a session restart. A resumed session's own context starts
 * at zero while the real count does not.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { flowsRoot, readFlow, resolveFlowDir } from "../flow/store";
import { pathExists } from "../lib/fs";
import type { ManagedReviewManifest, StructuredReviewFinding } from "./types";

/** One review round, as the detector needs it. */
export type ReviewRound = {
  /** How the round is named in the report. A package id, or "round 2". */
  label: string;
  findings: ReadonlyArray<Partial<StructuredReviewFinding>>;
  /** The round's review output — `report.md`. Absent when it was not read. */
  output?: string | undefined;
};

export const LOOP_SIGNAL_KINDS = ["repeated-finding", "identical-output"] as const;
export type LoopSignalKind = (typeof LOOP_SIGNAL_KINDS)[number];

export type LoopSignal = {
  kind: LoopSignalKind;
  /** The finding identity, or the pair of round labels for identical output. */
  key: string;
  /** Rounds the signal spans, by label, in order. */
  rounds: string[];
  /** What fired, in words. Rendered verbatim into the record. */
  detail: string;
};

export type LoopDetection = {
  escalate: boolean;
  signals: LoopSignal[];
  roundsSeen: number;
  /**
   * `tasks[].attempts.count` from `flow.json`, when a task was named.
   * `undefined` means nobody looked it up — NOT zero attempts.
   *
   * Context for the report only. It is never a condition on `escalate`.
   */
  attempts: number | undefined;
};

/**
 * The identity two occurrences of "the same finding" must share.
 *
 * Resolution order, and the reason for each:
 *
 * 1. `dedupe_key` — the field that exists to say "these are the same finding".
 *    When a producer sets it, nothing here should second-guess it.
 * 2. `global_id` — `<reviewId>#<id>`, minted per package. A freshly minted one
 *    can never collide across rounds, so including it is free: it matches only
 *    when a producer deliberately carried round N's key into round N+1, which
 *    is that producer stating the finding is the same one.
 * 3. A derived content key — reviewer, file, symbol, line and the normalised
 *    problem text.
 *
 * `id` is deliberately NOT in this list. It is per-report: `F-001` denotes a
 * different finding in every round of every review in the corpus, so a detector
 * keyed on it fires on the second round of every flow whatever happened. A
 * detector that always fires is one that gets turned off.
 */
export function findingIdentity(finding: Partial<StructuredReviewFinding>): string {
  const dedupe = finding.dedupe_key;
  if (typeof dedupe === "string" && dedupe.trim() !== "") {
    return `dedupe:${dedupe.trim()}`;
  }
  const global = finding.global_id;
  if (typeof global === "string" && global.trim() !== "") {
    return `global:${global.trim()}`;
  }
  const parts = [
    finding.reviewer ?? "?",
    finding.file ?? "?",
    finding.symbol ?? "?",
    finding.line === undefined || finding.line === null ? "?" : String(finding.line),
    normalizeText(finding.problem ?? ""),
  ];
  return `derived:${parts.join("|")}`;
}

/**
 * Whitespace- and timestamp-normalised output, for the identical-output test.
 *
 * Timestamps are stripped because a report that differs only by the second it
 * was written is the same report, and leaving them in would make the second
 * signal unable to fire at all. Nothing else is normalised: two rounds that
 * differ by one word differ, and the signal is meant to be decisive rather than
 * approximate.
 */
export function normalizeReviewOutput(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<timestamp>")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Fire on repetition across `rounds`, which must be in chronological order.
 *
 * Two occurrences is the threshold for a repeated finding, and *consecutive* is
 * the requirement for identical output: two identical rounds with a different
 * one between them is a round that changed something and then changed it back,
 * which is a different (and rarer) pathology than being stuck.
 */
export function detectReviewLoop(input: {
  rounds: readonly ReviewRound[];
  /** Context for the report. Never a condition on `escalate`. */
  attempts?: number | undefined;
}): LoopDetection {
  const rounds = input.rounds;
  const signals: LoopSignal[] = [];

  // 1. The same finding identity in two or more distinct rounds.
  const seen = new Map<string, { rounds: string[]; sample: Partial<StructuredReviewFinding> }>();
  for (const round of rounds) {
    const inThisRound = new Set<string>();
    for (const finding of round.findings) {
      const identity = findingIdentity(finding);
      if (inThisRound.has(identity)) {
        // A repeat WITHIN one round is a deduplication problem, not a loop.
        continue;
      }
      inThisRound.add(identity);
      const entry = seen.get(identity);
      if (entry === undefined) {
        seen.set(identity, { rounds: [round.label], sample: finding });
      } else {
        entry.rounds.push(round.label);
      }
    }
  }
  for (const [identity, entry] of seen) {
    if (entry.rounds.length < 2) {
      continue;
    }
    const where = entry.sample.file ? ` at ${entry.sample.file}` : "";
    signals.push({
      kind: "repeated-finding",
      key: identity,
      rounds: [...entry.rounds],
      detail: `\`${entry.sample.reviewer ?? "unknown reviewer"}\`${where} raised the same finding in ${
        entry.rounds.length
      } rounds (${entry.rounds.join(" -> ")}): ${truncate(entry.sample.problem ?? "(no problem text)")}. A fix round that leaves its finding standing is the fix failing.`,
    });
  }

  // 2. Two CONSECUTIVE rounds whose output is byte-identical after normalisation.
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1] as ReviewRound;
    const current = rounds[index] as ReviewRound;
    if (previous.output === undefined || current.output === undefined) {
      continue;
    }
    const before = normalizeReviewOutput(previous.output);
    const after = normalizeReviewOutput(current.output);
    if (before === "" || before !== after) {
      continue;
    }
    signals.push({
      kind: "identical-output",
      key: `${previous.label}==${current.label}`,
      rounds: [previous.label, current.label],
      detail: `${previous.label} and ${current.label} produced identical review output (${before.length} chars, whitespace and timestamps normalised). Nothing changed between the two rounds.`,
    });
  }

  return {
    // From the signals alone. No budget, no round bound, no attempt limit.
    escalate: signals.length > 0,
    signals,
    roundsSeen: rounds.length,
    attempts: input.attempts,
  };
}

/**
 * The rounds a flow already has on disk, oldest first.
 *
 * Reads real persisted state — `.metaproject/flows/<dir>/reviews/*` — rather
 * than the orchestrator's context, which is the whole reason flow 201 put the
 * attempt counter in `flow.json`: a resumed session remembers nothing it tried,
 * and a bound computed from what it remembers is not a bound.
 *
 * Ordering is by `manifest.createdAt` and falls back to the directory name,
 * which begins with the ISO date. A package with neither sorts last rather than
 * being dropped: a round with no timestamp is still a round.
 */
export async function readFlowReviewRounds(cwd: string, flowRef: string): Promise<ReviewRound[]> {
  const dir = await resolveFlowDir(cwd, flowRef);
  const reviewsDir = path.join(flowsRoot(cwd), dir, "reviews");
  if (!(await pathExists(reviewsDir))) {
    return [];
  }
  const entries = (await readdir(reviewsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const rounds: Array<{ sortKey: string; round: ReviewRound }> = [];
  for (const entry of entries) {
    const packageDir = path.join(reviewsDir, entry.name);
    const manifest = await readJson<ManagedReviewManifest>(path.join(packageDir, "manifest.json"));
    const findings = (await readJson<ReadonlyArray<Partial<StructuredReviewFinding>>>(
      path.join(packageDir, "findings.json"),
    )) ?? [];
    const reportPath = path.join(packageDir, "report.md");
    const output = (await pathExists(reportPath)) ? await readFile(reportPath, "utf8") : undefined;
    rounds.push({
      sortKey: manifest?.createdAt ?? entry.name,
      round: {
        label: manifest?.reviewId ?? entry.name,
        findings: Array.isArray(findings) ? findings : [],
        output,
      },
    });
  }
  rounds.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return rounds.map((entry) => entry.round);
}

/**
 * `tasks[].attempts.count` for one task, or `undefined` when the task is not
 * there. `undefined` is not zero — see {@link LoopDetection.attempts}.
 */
export async function readTaskAttemptCount(cwd: string, flowRef: string, taskId: string): Promise<number | undefined> {
  const dir = await resolveFlowDir(cwd, flowRef);
  const flow = await readFlow(cwd, dir);
  const task = flow.tasks.find((item) => item.id.toUpperCase() === taskId.toUpperCase());
  return task?.attempts?.count;
}

async function readJson<T>(file: string): Promise<T | null> {
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    // A package with an unreadable artifact is still a round; refusing the whole
    // detection because one file is malformed would turn a partial answer into
    // no answer, and no answer reads as "no loop".
    return null;
  }
}

function truncate(value: string, limit = 120): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/**
 * `## Loop detection` — what repeated, and across which rounds.
 *
 * Written whether or not anything fired, because "no repetition across 3 rounds"
 * is only worth reading if it comes from something that would have said
 * otherwise.
 */
export function renderLoopDetectionMarkdown(detection: LoopDetection): string {
  const lines: string[] = [];
  lines.push("## Loop detection");
  lines.push("");
  lines.push(`rounds_seen: ${detection.roundsSeen}`);
  lines.push(`attempts_recorded: ${detection.attempts === undefined ? "not recorded" : detection.attempts}`);
  lines.push(`escalate: ${detection.escalate ? "yes" : "no"}`);
  lines.push("");
  if (detection.signals.length === 0) {
    lines.push(
      detection.roundsSeen < 2
        ? "_fewer than two rounds: repetition cannot be observed yet. This is not `no loop`._"
        : "_no repeated finding and no identical consecutive output across the rounds on disk._",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| signal | rounds | why |");
  lines.push("|---|---|---|");
  for (const signal of detection.signals) {
    lines.push(`| ${signal.kind} | ${escapePipes(signal.rounds.join(" -> "))} | ${escapePipes(signal.detail)} |`);
  }
  lines.push("");
  lines.push("Escalated on repetition ALONE. The remaining round budget was not consulted:");
  lines.push("a detector that can be argued out of firing by an unspent budget is a counter.");
  lines.push("");
  return lines.join("\n");
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}
