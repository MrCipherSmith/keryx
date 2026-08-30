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
 *
 * # What this could not detect, and why (flow 203, second pass)
 *
 * Reading persisted state was necessary and was not sufficient. Both signals
 * were inert against the state `createManagedReviewPackage` actually writes,
 * and the record said so as a positive fact — "no repeated finding and no
 * identical consecutive output" — which is the silent-cap failure AC10 exists
 * to end, stated as an observation.
 *
 * - **`repeated-finding` could not fire.** Identity was a RANKING with
 *   `global_id` above the content key, and `assignGlobalIds` mints a fresh
 *   `<reviewId>#<id>` on every finding before it is persisted. The top-ranked
 *   key therefore differed between any two rounds by construction. Identity is
 *   now a SET and matching is intersection — see {@link findingIdentities}.
 * - **Two rounds shared one directory.** `defaultReviewId` is date-keyed and the
 *   documented invocation passes no `--review-id`, so a second round of the same
 *   branch on the same day overwrote the first: one package, `rounds_seen: 1`,
 *   nothing to compare. Fixed in `managed.ts` (`allocatePackage`), which is
 *   where the naming lives.
 * - **`identical-output` was the only thing left, and one changed word in the
 *   Summary defeats it.** It still does — the signal is deliberately exact. What
 *   changed is that the record no longer reports an unrun comparison as a clean
 *   one: `outputPairsCompared` counts the pairs that could be compared at all.
 *
 * The tests that hold this down go through `createManagedReviewPackage` twice
 * and assert on what came back off disk. Hand-built round fixtures are what let
 * the ranked identity ship green — `loop.test.ts` passed 18/18 while the
 * detector was inert in production, because no fixture carried a `global_id`.
 *
 * # What is NOT a loop: an external comment (flow 204)
 *
 * `repeated-finding` reads `findings.json`, and since flow 204 that file also
 * holds the PR's external comments — `source: "external"`, one per collected
 * comment, carrying `dedupe_key: external:<comment id>` which is *deliberately*
 * stable across rounds. Collection runs every round (AC8) while replies are
 * posted once after the final round (AC11), so an unanswered comment is
 * re-collected and re-persisted every round BY DESIGN.
 *
 * Fed to a detector that treats `dedupe:<key>` as an identity, that design makes
 * every flow with one outstanding comment escalate from round 2 — naming the
 * human or bot who left the comment as the reviewer stuck in a loop, and telling
 * the orchestrator to change strategy over a comment nobody has answered yet.
 * The signal means "a fix round left its finding standing"; a comment awaiting
 * its deferred reply is not that, and no threshold makes it that.
 *
 * So external findings are excluded from `repeated-finding` — and counted, not
 * dropped in silence: see {@link LoopDetection.externalFindingsExcluded} and
 * {@link LoopDetection.externalFindingsRecurring}, both rendered into the record.
 * Whether an outstanding comment was answered is the completion gate's question
 * (AC5/AC13), which is where it can be asked without accusing the commenter of
 * looping.
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
   * Consecutive round pairs where BOTH sides carried a report, so the
   * identical-output check could actually run. `0` with
   * {@link LoopDetection.outputPairsPossible} above zero means that half of the
   * detection was unobserved — which is not the same fact as "nothing repeated",
   * and the record must not print it as one.
   */
  outputPairsCompared: number;
  /** Consecutive round pairs that existed at all: `max(roundsSeen - 1, 0)`. */
  outputPairsPossible: number;
  /**
   * External findings (`source: "external"`) held out of the repeated-finding
   * pass, counted across every round.
   *
   * Reported rather than assumed, on the same rule as
   * {@link LoopDetection.outputPairsCompared}: a detector that quietly ignores
   * part of its input is indistinguishable from one that examined it and found
   * nothing.
   */
  externalFindingsExcluded: number;
  /**
   * Distinct external findings seen in two or more rounds — the ones that WOULD
   * have escalated before flow 204 fixed this.
   *
   * It is a count of collected comments still awaiting their end-of-flow reply,
   * not a defect signal, and it never touches `escalate`.
   */
  externalFindingsRecurring: number;
  /**
   * `tasks[].attempts.count` from `flow.json`, when a task was named.
   * `undefined` means nobody looked it up — NOT zero attempts.
   *
   * Context for the report only. It is never a condition on `escalate`.
   */
  attempts: number | undefined;
};

/**
 * EVERY key a finding can be recognised by — a set, not a ranking.
 *
 * The ranking was the defect, and it made the whole detector inert on the state
 * this pipeline actually persists. `assignGlobalIds` in `managed.ts` mints
 * `<reviewId>#<id>` on every finding *before* it is written, so a
 * highest-ranked `global_id` is guaranteed to differ between any two rounds:
 *
 *     round 1: global_id = "2026-08-30-ingest-demo#F-001"
 *     round 2: global_id = "round-2#F-001"
 *
 * Same finding, same file, same problem text — and under a ranked resolution
 * the content key that would have matched was never reached. `repeated-finding`
 * could not fire on anything the writer produced, and the record then printed
 * "no repeated finding" as a positive fact.
 *
 * So a finding contributes every key it has, and two findings are the same one
 * when their key sets INTERSECT:
 *
 * 1. `dedupe:<dedupe_key>` — the field that exists to say "these are the same
 *    finding". When a producer sets it, nothing here second-guesses it.
 * 2. `global:<global_id>` — kept as an identity, and now it earns its place
 *    rather than shadowing the content key. A freshly minted key never collides
 *    across rounds, so it costs nothing; a key a producer deliberately CARRIED
 *    from round N into round N+1 matches even when the problem text was
 *    reworded, which is the one thing the content key cannot do.
 * 3. `derived:...` — reviewer, file, symbol, line and normalised problem text.
 *    Omitted entirely when there is no content to compare; see
 *    {@link derivedContentKey}.
 *
 * `id` is deliberately NOT a key. It is per-report: `F-001` denotes a different
 * finding in every round of every review in the corpus, so a detector keyed on
 * it fires on the second round of every flow whatever happened. A detector that
 * always fires is one that gets turned off.
 */
export function findingIdentities(finding: Partial<StructuredReviewFinding>): string[] {
  const keys: string[] = [];
  const dedupe = finding.dedupe_key;
  if (typeof dedupe === "string" && dedupe.trim() !== "") {
    keys.push(`dedupe:${dedupe.trim()}`);
  }
  const global = finding.global_id;
  if (typeof global === "string" && global.trim() !== "") {
    keys.push(`global:${global.trim()}`);
  }
  const derived = derivedContentKey(finding);
  if (derived !== undefined) {
    keys.push(derived);
  }
  return keys;
}

/**
 * The content key, or `undefined` when the finding carries no content to
 * compare.
 *
 * `reviewer` and `line` are in the key but cannot justify it on their own:
 * `derived:review-style|?|?|?|` would make every contentless finding identical
 * to every other one from the same reviewer, and a detector that fires on that
 * is worse than one that stays quiet. A finding with no `problem`, no `file` and
 * no `symbol` therefore contributes no derived key at all — it is compared on
 * `dedupe_key` and `global_id` or not compared.
 */
function derivedContentKey(finding: Partial<StructuredReviewFinding>): string | undefined {
  const problem = normalizeText(finding.problem ?? "");
  const file = (finding.file ?? "").trim();
  const symbol = (finding.symbol ?? "").trim();
  if (problem === "" && file === "" && symbol === "") {
    return undefined;
  }
  const parts = [
    finding.reviewer ?? "?",
    file === "" ? "?" : file,
    symbol === "" ? "?" : symbol,
    finding.line === undefined || finding.line === null ? "?" : String(finding.line),
    problem,
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

  // 1. The same finding in two or more distinct rounds.
  //
  // Reviewer findings only. An external comment is re-collected every round
  // while its reply is deferred to the last one, so it repeats by design — see
  // the module header. It is counted below and never signalled.
  const externalFindingsExcluded = rounds.reduce(
    (total, round) => total + round.findings.filter(isExternalFinding).length,
    0,
  );
  const externalFindingsRecurring = [
    ...repeatedIdentities(rounds, (finding) => isExternalFinding(finding)).values(),
  ].filter((entry) => entry.rounds.length >= 2).length;

  const seen = repeatedIdentities(rounds, (finding) => !isExternalFinding(finding));
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
  //
  // `comparedPairs` is counted rather than assumed, because this check needs BOTH
  // rounds' `report.md` and a package whose report is missing contributes nothing
  // — silently, while the record went on printing "no identical consecutive
  // output". A negative you cannot observe is not a negative (AC10).
  let comparedPairs = 0;
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1] as ReviewRound;
    const current = rounds[index] as ReviewRound;
    if (previous.output === undefined || current.output === undefined) {
      continue;
    }
    const before = normalizeReviewOutput(previous.output);
    const after = normalizeReviewOutput(current.output);
    if (before === "" && after === "") {
      // Two reports that normalise to nothing were not compared; they were both
      // absent in all but name.
      continue;
    }
    comparedPairs += 1;
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
    outputPairsCompared: comparedPairs,
    outputPairsPossible: Math.max(rounds.length - 1, 0),
    externalFindingsExcluded,
    externalFindingsRecurring,
    attempts: input.attempts,
  };
}

/**
 * A finding that came off the pull request rather than out of a reviewer.
 *
 * The one property that decides it is `source`, which `toContractFinding`
 * preserves precisely so the three behaviours AC5/AC9/AC10 attach to an external
 * comment cannot be lost by a projection. This is the fourth.
 */
function isExternalFinding(finding: Partial<StructuredReviewFinding>): boolean {
  return finding.source === "external";
}

/**
 * Which rounds each finding identity appears in, over the findings `select`
 * admits.
 *
 * Two passes, because identity is a SET of keys and "the same finding" is
 * therefore an intersection rather than an equality. Pass one unions every key a
 * finding carries into one group, so a `global_id` carried forward and a content
 * key that matches independently name the SAME finding rather than two. Pass two
 * buckets the findings by that group.
 *
 * `select` runs BEFORE the union, not after: an excluded finding must not link
 * two keys together either, or an external comment sharing a file and a line
 * with a reviewer finding would merge the two identities and make the reviewer's
 * one unresolvable.
 */
function repeatedIdentities(
  rounds: readonly ReviewRound[],
  select: (finding: Partial<StructuredReviewFinding>) => boolean,
): Map<string, { rounds: string[]; sample: Partial<StructuredReviewFinding> }> {
  const groups = new KeyGroups();
  for (const round of rounds) {
    for (const finding of round.findings) {
      if (select(finding)) {
        groups.link(findingIdentities(finding));
      }
    }
  }
  const seen = new Map<string, { rounds: string[]; sample: Partial<StructuredReviewFinding> }>();
  for (const round of rounds) {
    const inThisRound = new Set<string>();
    for (const finding of round.findings) {
      if (!select(finding)) {
        continue;
      }
      const identity = groups.representative(findingIdentities(finding));
      if (identity === undefined) {
        // Nothing to compare it by. Silence here is honest: the alternative is a
        // shared placeholder key that makes every such finding a repeat.
        continue;
      }
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
  return seen;
}

/**
 * Union-find over identity keys.
 *
 * Needed because identity is a set: a finding carrying `global:r1#F-001` and
 * `derived:...` binds those two keys together for good, so a later finding
 * matching EITHER of them is the same finding. Without the union, one finding
 * would be counted under two identities and a repetition spanning the two would
 * be split into two groups of one — and neither would reach the threshold.
 */
class KeyGroups {
  private readonly parent = new Map<string, string>();

  link(keys: readonly string[]): void {
    const first = keys[0];
    if (first === undefined) {
      return;
    }
    for (const key of keys) {
      this.union(first, key);
    }
  }

  /** The group id shared by these keys, or `undefined` when there are none. */
  representative(keys: readonly string[]): string | undefined {
    const first = keys[0];
    return first === undefined ? undefined : this.find(first);
  }

  private find(key: string): string {
    let current = key;
    let next = this.parent.get(current);
    while (next !== undefined && next !== current) {
      current = next;
      next = this.parent.get(current);
    }
    this.parent.set(key, current);
    return current;
  }

  private union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) {
      return;
    }
    // Lexicographically smallest root wins, so the group id is deterministic
    // whatever order the rounds were read in.
    const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(drop, keep);
  }
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
  lines.push(`output_pairs_compared: ${detection.outputPairsCompared} of ${detection.outputPairsPossible}`);
  lines.push(
    `external_findings_excluded: ${detection.externalFindingsExcluded} (recurring across rounds: ${detection.externalFindingsRecurring})`,
  );
  lines.push(`escalate: ${detection.escalate ? "yes" : "no"}`);
  lines.push("");
  if (detection.externalFindingsRecurring > 0) {
    lines.push(
      `${detection.externalFindingsRecurring} collected PR comment(s) appear in more than one round. That is collection`,
    );
    lines.push("working as specified — comments are collected every round and answered once, after the");
    lines.push("final one — and not a reviewer repeating itself, so it does not escalate here. Whether");
    lines.push("each one was answered is the completion gate's question.");
    lines.push("");
  }
  if (detection.signals.length === 0) {
    lines.push(negativeFinding(detection));
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

/**
 * What "nothing fired" is allowed to claim.
 *
 * Three different facts, and collapsing them is the silent-cap failure AC10
 * exists to end. `_no repeated finding and no identical consecutive output_` was
 * printed unconditionally, including when there was one round (nothing to
 * repeat) and when no round pair carried a report on both sides (the second
 * check never ran). Both read as "we looked and it was clean".
 */
function negativeFinding(detection: LoopDetection): string {
  if (detection.roundsSeen < 2) {
    return "_fewer than two rounds: repetition cannot be observed yet. This is not `no loop`._";
  }
  if (detection.outputPairsCompared === 0) {
    return (
      `_no repeated reviewer finding across the ${detection.roundsSeen} rounds on disk. ` +
      `The output check did NOT run: no round pair could be compared, because all ` +
      `${detection.outputPairsPossible} pair(s) were missing a report on one or both sides. ` +
      "That half is unobserved, not clean._"
    );
  }
  const partial =
    detection.outputPairsCompared < detection.outputPairsPossible
      ? ` (${detection.outputPairsPossible - detection.outputPairsCompared} pair(s) could not be compared and are unobserved)`
      : "";
  return `_no repeated reviewer finding, and no identical consecutive output, across the ${detection.roundsSeen} rounds on disk${partial}._`;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}
