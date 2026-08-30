/**
 * The review gate (flow 204, AC5-AC7 / specification §2).
 *
 * # Why a sixth gate
 *
 * `flow complete` gated on acceptance criteria, PR-or-merge, tasks, health and
 * security. Nothing checked that the last review round came back clean, so a
 * flow could close with open findings — which is the opposite of what the review
 * loop exists to produce.
 *
 * # The one rule everything here is built on
 *
 * **A finding disappearing from round N+1 is not evidence it was fixed.** It is
 * equally consistent with the reviewer not looking, the context being fuller, or
 * the sampling differing. Flow 202 measured exactly this shape: the review
 * corpus reported 100% precision because nothing in it could record a finding as
 * wrong — a corpus of survivors from an unlogged triage. The number was refused
 * as a baseline for that reason (see the flow 202 package's `baseline.md`).
 *
 * Two consequences run through this whole file:
 *
 * 1. **"Clean" is defined positively, per finding.** Each terminal disposition
 *    names the evidence it requires, and a disposition without that evidence is
 *    NOT terminal. See {@link findingVerdict}.
 * 2. **A condition that could not be observed fails the gate.** `unobserved` is
 *    a distinct status from `violated` so the operator is told which one it is,
 *    but both fail. A gate that passes because nothing was recorded is the
 *    failure mode this gate was added to remove; it does not become acceptable
 *    by being spelled "we could not check".
 *
 * # Absence across rounds, specifically
 *
 * §2.2 condition 2 says "the latest round", and §2.1 says "every finding ever
 * raised in this flow's review history". Those are not the same set and the
 * difference is the whole criterion: a blocker raised in round 1 that is simply
 * absent from round 2 satisfies "the latest round has no open findings" while
 * satisfying nothing at all. So the evaluation is over the union of every
 * ingested round, taking the LATEST record of each finding identity — which is
 * "the latest round" read as "the latest state of each finding" rather than as
 * "the last file written". See {@link latestFindingStates}.
 *
 * # Opt-in per package
 *
 * `gates.review` is written by `flow init`, exactly like `gates.tasks` in flow
 * 201, and for the same reason: turning a new gate on retroactively would
 * invalidate every package that completed before it existed. A package without
 * the flag reports `skipped` — visible in the gate list rather than silently
 * absent.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { findingIdentities } from "../review/loop";
import { prCommentsStatePath, readPrCommentState, unansweredComments } from "../review/pr-comments";
import { flowsRoot } from "./store";
import type { FlowState, TrackerAdapter } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The severities that can block a completion.
 *
 * `info` is deliberately not a member: specification §2.2 says "`info` never
 * blocks", so it is not expressible as a floor rather than merely discouraged as
 * one. A configuration file that names it is clamped to `minor` and says so.
 */
export const BLOCKING_SEVERITY_FLOORS = ["blocker", "major", "minor"] as const;
export type BlockingSeverityFloor = (typeof BLOCKING_SEVERITY_FLOORS)[number];

export const REVIEW_GATE_SEVERITY_FLOOR_DEFAULT: BlockingSeverityFloor = "minor";

/**
 * The round bound (flow 203 / roadmap §2.5), as this gate needs to READ it.
 *
 * It is a number here and a sentence in the three orchestrator skills
 * (`Allow at most **three** review/fix attempts`, pinned by
 * `src/gdskills/round-bound.test.ts`). This constant does not enforce the bound
 * — nothing in `flow complete` dispatches a round — it only lets the gate say
 * "the cap is reached AND the gate is unsatisfied", which is the conflict AC7
 * resolves. Duplicating the number is the lesser evil against editing a skill
 * file this flow does not own.
 */
export const REVIEW_ROUND_CAP = 3;

/** Where a per-project override lives. Absent is normal; absence is not an error. */
export const REVIEW_GATE_CONFIG_PATH = ".metaproject/tasks.config.json";

export type ReviewGateConfig = {
  severityFloor: BlockingSeverityFloor;
  /** `completion.require_clean_round`. False disables the gate, visibly. */
  requireCleanRound: boolean;
  /** Anything wrong with the configuration file. Reported, never swallowed. */
  notes: string[];
};

export const DEFAULT_REVIEW_GATE_CONFIG: ReviewGateConfig = {
  severityFloor: REVIEW_GATE_SEVERITY_FLOOR_DEFAULT,
  requireCleanRound: true,
  notes: [],
};

/**
 * Read `.metaproject/tasks.config.json`, if it is there.
 *
 * A malformed file yields the defaults PLUS a note, and the note is rendered
 * into the gate detail. Silently falling back to the defaults would make a typo
 * in the floor indistinguishable from not having configured one, and a
 * misconfiguration that reads as a deliberate setting is the same class of
 * defect as an unrecorded dismissal.
 */
export async function readReviewGateConfig(cwd: string): Promise<ReviewGateConfig> {
  const file = path.join(cwd, REVIEW_GATE_CONFIG_PATH);
  if (!(await pathExists(file))) {
    return { ...DEFAULT_REVIEW_GATE_CONFIG, notes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return {
      ...DEFAULT_REVIEW_GATE_CONFIG,
      notes: [
        `${REVIEW_GATE_CONFIG_PATH} could not be parsed (${
          error instanceof Error ? error.message : String(error)
        }); the built-in defaults were used`,
      ],
    };
  }
  const completion = readRecord(readRecord(parsed)?.["completion"]);
  const notes: string[] = [];
  let severityFloor = REVIEW_GATE_SEVERITY_FLOOR_DEFAULT;
  const rawFloor = completion?.["severity_floor"];
  if (typeof rawFloor === "string") {
    if ((BLOCKING_SEVERITY_FLOORS as readonly string[]).includes(rawFloor)) {
      severityFloor = rawFloor as BlockingSeverityFloor;
    } else if (rawFloor === "info") {
      notes.push("completion.severity_floor is `info`, which never blocks; clamped to `minor`");
    } else {
      notes.push(`completion.severity_floor \`${rawFloor}\` is not a severity; \`minor\` was used`);
    }
  } else if (rawFloor !== undefined) {
    notes.push("completion.severity_floor is not a string; `minor` was used");
  }
  const rawRequire = completion?.["require_clean_round"];
  let requireCleanRound = true;
  if (typeof rawRequire === "boolean") {
    requireCleanRound = rawRequire;
  } else if (rawRequire !== undefined) {
    notes.push("completion.require_clean_round is not a boolean; `true` was used");
  }
  return { severityFloor, requireCleanRound, notes };
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { blocker: 3, major: 2, minor: 1, info: 0 };

/**
 * Whether a finding's severity is at or above the floor.
 *
 * An unrecognised severity ranks as `blocker`. The alternative — treating an
 * unknown word as below the floor — is a one-typo bypass of the whole gate, the
 * same shape as `--disposition skiped` walking past the task gate in flow 201.
 */
export function blocksAtFloor(severity: string, floor: BlockingSeverityFloor): boolean {
  const rank = SEVERITY_RANK[severity] ?? SEVERITY_RANK["blocker"] ?? 3;
  const floorRank = SEVERITY_RANK[floor] ?? 1;
  return rank >= floorRank;
}

// ---------------------------------------------------------------------------
// What is on disk
// ---------------------------------------------------------------------------

/** One finding, as this gate reads it out of `findings.json`. */
export type GateFinding = {
  id: string;
  globalId?: string | undefined;
  reviewer?: string | undefined;
  severity: string;
  problem?: string | undefined;
  file?: string | null | undefined;
  symbol?: string | null | undefined;
  line?: number | null | undefined;
  dedupeKey?: string | null | undefined;
  disposition?: { state?: string | undefined; evidence?: string | undefined } | undefined;
  verification?:
    | {
        verdict?: string | undefined;
        method?: string | undefined;
        evidence?: string | undefined;
        verifier?: string | undefined;
      }
    | undefined;
  /**
   * `external` when the finding came from a comment somebody else left on the PR
   * (specification §3.1 / AC9).
   *
   * Read defensively because the field does not exist yet: the external-comment
   * collection is being built alongside this gate, and this reader must not
   * require its shape before it lands, nor break when it does.
   */
  source?: string | undefined;
  externalRef?: Record<string, unknown> | undefined;
  /** Where it was read from, for the failure message. */
  round: string;
};

export type VerificationStats = {
  mode: string;
  claimsReceived: number | null;
  claimsApplied: number | null;
  refuted: number | null;
  findingsIn: number | null;
  findingsRetained: number | null;
  findingsRemoved: number | null;
};

export type ReviewRoundRecord = {
  reviewId: string;
  /** Package directory, relative to `cwd`. */
  dir: string;
  sortKey: string;
  /**
   * Whether the round is INGESTED: a durable record of what it found exists.
   *
   * Read as "manifest.json and findings.json are both on disk and readable",
   * not as `manifest.mode === "ingest"`. What §2.2 condition 1 is protecting
   * against is a round that "cannot be cited — nothing durable records what it
   * found", and a `review-flow` package records exactly as durably as an
   * `ingest` one. Keying on the mode string would reject a real record and
   * accept an empty directory written by the right verb.
   */
  ingested: boolean;
  /** Why it is not ingested. Empty when it is. */
  problems: string[];
  /** `manifest.target.head` — the commit the round ran against. */
  head: string | null;
  mode: string | null;
  coverage: Array<{ reviewer: string; status: string; reason: string }>;
  findings: GateFinding[];
  /** Parsed out of `scope.md`. `null` when the round recorded none. */
  verification: VerificationStats | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function toGateFinding(raw: unknown, round: string, index: number): GateFinding {
  const record = readRecord(raw) ?? {};
  const disposition = readRecord(record["disposition"]);
  const verification = readRecord(record["verification"]);
  return {
    id: readString(record["id"]) ?? `#${index + 1}`,
    globalId: readString(record["global_id"]),
    reviewer: readString(record["reviewer"]),
    severity: readString(record["severity"]) ?? "blocker",
    problem: readString(record["problem"]),
    file: typeof record["file"] === "string" ? record["file"] : null,
    symbol: typeof record["symbol"] === "string" ? record["symbol"] : null,
    line: typeof record["line"] === "number" ? record["line"] : null,
    dedupeKey: typeof record["dedupe_key"] === "string" ? record["dedupe_key"] : null,
    ...(disposition
      ? {
          disposition: {
            state: readString(disposition["state"]),
            evidence: readString(disposition["evidence"]),
          },
        }
      : {}),
    ...(verification
      ? {
          verification: {
            verdict: readString(verification["verdict"]),
            method: readString(verification["method"]),
            evidence: readString(verification["evidence"]),
            verifier: readString(verification["verifier"]),
          },
        }
      : {}),
    ...(readString(record["source"]) ? { source: readString(record["source"]) } : {}),
    ...(readRecord(record["external_ref"]) ? { externalRef: readRecord(record["external_ref"]) as Record<string, unknown> } : {}),
    round,
  };
}

/**
 * The verification stage counts, out of the `### Refuted by the verifier` and
 * `### Retained` blocks of `scope.md`.
 *
 * Parsed rather than read from a JSON field because `scope.md` is where
 * `createManagedReviewPackage` writes them and this flow does not own
 * `src/review/`. The parse is deliberately tolerant of everything except
 * `verification_mode`: that line is the one that says whether a verifier ran at
 * all, and a record without it is `null` rather than a zeroed stat block —
 * "the verifier removed nothing" and "no verifier ran" are different facts.
 */
export function parseVerificationStats(scopeMarkdown: string): VerificationStats | null {
  const mode = matchLine(scopeMarkdown, "verification_mode");
  if (mode === null) {
    return null;
  }
  return {
    mode,
    claimsReceived: matchNumber(scopeMarkdown, "claims_received"),
    claimsApplied: matchNumber(scopeMarkdown, "claims_applied"),
    refuted: matchNumber(scopeMarkdown, "refuted"),
    findingsIn: matchNumber(scopeMarkdown, "findings_in"),
    findingsRetained: matchNumber(scopeMarkdown, "findings_retained"),
    findingsRemoved: matchNumber(scopeMarkdown, "findings_removed_by_verifier"),
  };
}

function matchLine(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text);
  return match?.[1]?.trim() ?? null;
}

function matchNumber(text: string, key: string): number | null {
  const raw = matchLine(text, key);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every review package in the flow's directory, oldest first.
 *
 * Deliberately parallel to `readFlowReviewRounds` in `review/loop.ts` and not
 * shared with it: that reader answers "what did the rounds report" for loop
 * detection and drops the manifest, the coverage and the stage counts, all three
 * of which are conditions here. Widening it would put gate concerns into a
 * module this flow does not own.
 */
export async function readReviewRounds(cwd: string, flowDir: string): Promise<ReviewRoundRecord[]> {
  const reviewsDir = path.join(flowsRoot(cwd), flowDir, "reviews");
  if (!(await pathExists(reviewsDir))) {
    return [];
  }
  const entries = (await readdir(reviewsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const rounds: ReviewRoundRecord[] = [];
  for (const entry of entries) {
    const packageDir = path.join(reviewsDir, entry.name);
    const problems: string[] = [];

    const manifest = readRecord(await readJson(path.join(packageDir, "manifest.json")));
    if (manifest === null) {
      problems.push("manifest.json is missing or unreadable");
    }
    const rawFindings = await readJson(path.join(packageDir, "findings.json"));
    if (!Array.isArray(rawFindings)) {
      problems.push("findings.json is missing, unreadable, or not an array");
    }

    const reviewId = readString(manifest?.["reviewId"]) ?? entry.name;
    const target = readRecord(manifest?.["target"]);
    const coverageRaw = manifest?.["coverage"];
    const coverage = Array.isArray(coverageRaw)
      ? coverageRaw.flatMap((item) => {
          const record = readRecord(item);
          const reviewer = readString(record?.["reviewer"]);
          return reviewer === undefined
            ? []
            : [
                {
                  reviewer,
                  status: readString(record?.["status"]) ?? "",
                  reason: readString(record?.["reason"]) ?? "",
                },
              ];
        })
      : [];

    const scopePath = path.join(packageDir, "scope.md");
    const scope = (await pathExists(scopePath)) ? await readFile(scopePath, "utf8") : null;

    rounds.push({
      reviewId,
      dir: path.relative(cwd, packageDir),
      sortKey: readString(manifest?.["createdAt"]) ?? entry.name,
      ingested: problems.length === 0,
      problems,
      head: readString(target?.["head"]) ?? null,
      mode: readString(manifest?.["mode"]) ?? null,
      coverage,
      findings: Array.isArray(rawFindings)
        ? rawFindings.map((item, index) => toGateFinding(item, reviewId, index))
        : [],
      verification: scope === null ? null : parseVerificationStats(scope),
    });
  }
  rounds.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return rounds;
}

async function readJson(file: string): Promise<unknown> {
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Clean", defined positively, per finding (AC6 / §2.1)
// ---------------------------------------------------------------------------

/**
 * A hexadecimal Git object id, standing alone.
 *
 * Two constraints beyond "hex characters", both learned from what the loose
 * version accepted. `\b[0-9a-f]{7,40}\b` matches ENGLISH WORDS: `effaced`,
 * `defaced`, `deface`, `decade`, `facade`, `deadbeef`. A disposition whose
 * evidence read "the debug banner was effaced" and a verification citing the
 * same word therefore satisfied "a commit SHA **and** a verifier verdict citing
 * that SHA", and the gate passed on a finding nobody had fixed.
 *
 * So: at least eight characters (git's own default abbreviation is seven, but
 * seven is exactly the length of the words above, and nothing writes a
 * seven-character SHA by hand into evidence that could not write eight), and at
 * least one DIGIT. A digit is what no English word has. The residue — a real
 * SHA that happens to be all letters — is one in roughly 10^6 for eight
 * characters, and the cost of the miss is a gate that refuses and asks for a
 * longer SHA, which is the safe direction.
 *
 * The alternative considered and not taken was `git cat-file -e <sha>`, which
 * proves existence rather than shape. It was rejected here because this
 * function is pure and is applied to packages written on other machines, in
 * other clones, and to commits that may not have been fetched — a gate that
 * fails because the object is not local would fail honest records.
 */
const SHA_PATTERN = /\b(?=[0-9a-f]{8,40}\b)[0-9a-f]*\d[0-9a-f]*\b/gi;

/**
 * What a recorded human decision looks like.
 *
 * §2.1 says the orchestrator may not dismiss on its own authority, so a
 * dismissal must name who decided. This is an attribution requirement, not an
 * identity proof: nothing here can stop an orchestrator from writing
 * `human: alice` about a decision alice never made. What it does guarantee is
 * that dismissing requires naming a person, in a form an auditor can grep for
 * and alice can contradict — which is strictly more than the previous state,
 * where a dismissal required nothing at all.
 */
const HUMAN_DECISION_PATTERN = /\b(human|operator|reviewer|decided[-\s]?by|approved[-\s]?by|owner)\s*[:=]\s*\S/i;

/** The three dismissal states §2.1 calls `dismissed` — "correct, but not now". */
const CORRECT_BUT_DISMISSED = new Set([
  "dismissed-wont-fix",
  "dismissed-out-of-scope",
  "dismissed-deprioritised",
]);

/**
 * What counts as "a reply was written" inside a disposition's evidence.
 *
 * The `external_ref.reply_url` is the durable proof and is checked first; this
 * is the fallback for a record whose reply is described rather than linked — a
 * hand-written disposition, or a package written before `reply_url` existed. It
 * requires the evidence to NAME the reply (a URL, or the word) rather than
 * merely to disagree, because "the reviewer is wrong" with no reply is exactly
 * the silence AC10 forbids.
 */
const REPLY_EVIDENCE_PATTERN = /(https?:\/\/\S+|#(issue|discussion)comment[-_]?\d+|\breplied\b|\breply\b|\banswered\b)/i;

export type FindingVerdict =
  | { terminal: true; kind: "fixed" | "refuted" | "dismissed" | "answered" }
  | { terminal: false; reason: string };

function shasIn(text: string | undefined): string[] {
  return text === undefined ? [] : (text.match(SHA_PATTERN) ?? []).map((sha) => sha.toLowerCase());
}

/**
 * Whether one finding is terminal, and if not, exactly why not.
 *
 * The six persisted states (flow 202) map onto the three the specification names,
 * and each mapping carries the evidence requirement §2.1 attaches to it:
 *
 * | persisted | §2.1 | requires |
 * |---|---|---|
 * | `acted-on` | `fixed` | a commit SHA in the disposition evidence AND a verifier `refuted` verdict whose own evidence cites that SHA |
 * | `dismissed-incorrect` | `refuted` | a verifier `refuted` verdict with a method and evidence |
 * | `dismissed-wont-fix` / `-out-of-scope` / `-deprioritised` | `dismissed` | evidence naming a human decision |
 * | `answered-disagree` | (AC10) | a reply: `external_ref.reply_url`, or evidence naming one |
 * | `unknown`, absent, anything else | — | not terminal |
 *
 * `answered-disagree` was missing from this table and from the code, and the
 * omission was not cosmetic: it is the state AC10 REQUIRES the pipeline to
 * produce when the verifier refutes an external comment, `managed.ts` writes it
 * on exactly that path, and eight other files know it. Reaching it therefore
 * left the finding permanently non-terminal, failing conditions 2 and 4 forever
 * — the gate refused every flow whose review worked as designed. What makes it
 * terminal is the reply, not the disagreement: a machine deciding a human's
 * question was invalid is not an answer to the human, so the obligation this
 * state carries is discharged by having spoken, not by having been right.
 *
 * The `fixed` rule is the strict one and it is strict on purpose: AC-C3 says a
 * finding marked `fixed` without a verifier verdict against the fixing commit is
 * rejected at gate time. Since `ReviewFindingVerification` carries no SHA field,
 * "against that SHA" is checked by requiring the SHA to appear in the
 * verification's own evidence — the only durable link between the two records
 * that exists today. A `refuted` verdict can never have been reached by
 * reasoning alone (`mergeVerifications` caps reasoning at `unverifiable`), so
 * this also inherits that floor without restating it.
 */
export function findingVerdict(finding: GateFinding): FindingVerdict {
  const state = finding.disposition?.state;
  const evidence = finding.disposition?.evidence;
  if (state === undefined || state === "unknown") {
    return {
      terminal: false,
      reason:
        state === "unknown"
          ? "disposition is `unknown` — nothing was recorded about what became of it"
          : "no disposition recorded",
    };
  }
  if (evidence === undefined) {
    return { terminal: false, reason: `disposition \`${state}\` carries no evidence` };
  }

  if (state === "acted-on") {
    const shas = shasIn(evidence);
    if (shas.length === 0) {
      return {
        terminal: false,
        reason: "marked fixed (`acted-on`) but its evidence names no commit SHA",
      };
    }
    const verification = finding.verification;
    if (verification?.verdict !== "refuted") {
      return {
        terminal: false,
        reason:
          "marked fixed (`acted-on`) with no verifier verdict of `refuted` — a finding that is not " +
          "re-checked after the fix is a finding nobody showed had stopped reproducing",
      };
    }
    const verified = shasIn(verification.evidence);
    if (!verified.some((sha) => shas.some((fix) => sha.startsWith(fix) || fix.startsWith(sha)))) {
      return {
        terminal: false,
        reason:
          `marked fixed at ${shas.join(", ")} but the verifier's \`refuted\` evidence does not cite that commit — ` +
          "a refutation against some other tree says nothing about what will merge",
      };
    }
    return { terminal: true, kind: "fixed" };
  }

  if (state === "dismissed-incorrect") {
    const verification = finding.verification;
    if (verification?.verdict !== "refuted") {
      return {
        terminal: false,
        reason:
          "dismissed as incorrect with no verifier `refuted` verdict — `refuted` requires a method and " +
          "evidence, not an assertion that the finding was never real",
      };
    }
    if (verification.method === undefined || verification.evidence === undefined) {
      return {
        terminal: false,
        reason: "dismissed as incorrect, but the verification records no method and/or no evidence",
      };
    }
    return { terminal: true, kind: "refuted" };
  }

  if (state === "answered-disagree") {
    if (externalReplyUrl(finding) !== undefined || REPLY_EVIDENCE_PATTERN.test(evidence)) {
      return { terminal: true, kind: "answered" };
    }
    return {
      terminal: false,
      reason:
        "`answered-disagree` with no reply on the record — this state exists precisely because our verifier " +
        "refuted somebody else's comment, and refuting it is not answering it. Record the reply " +
        "(`external_ref.reply_url`) or say in the evidence where it was posted.",
    };
  }

  if (CORRECT_BUT_DISMISSED.has(state)) {
    if (!HUMAN_DECISION_PATTERN.test(evidence)) {
      return {
        terminal: false,
        reason:
          `\`${state}\` with no recorded human decision — the orchestrator may not dismiss on its own ` +
          "authority; the evidence must name who decided (e.g. `human: <who>` or `decided-by: <who>`)",
      };
    }
    return { terminal: true, kind: "dismissed" };
  }

  return { terminal: false, reason: `disposition \`${state}\` is not a state this build recognises` };
}

// ---------------------------------------------------------------------------
// The latest state of every finding ever raised
// ---------------------------------------------------------------------------

/** Union-find over the identity keys a finding can be recognised by. */
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
    const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(drop, keep);
  }
}

/**
 * One record per finding identity, taking the most recent round that carried it.
 *
 * This is the mechanism that stops absence from reading as a fix. A finding
 * raised in round 1 and simply not re-reported in round 2 keeps its round-1
 * record — which has no terminal disposition — so it still blocks. To clear it
 * somebody has to WRITE something: a disposition with evidence, in some round.
 *
 * Identity comes from `review/loop.ts` so a finding is recognised across rounds
 * by the same rule the loop detector uses. A finding carrying no identity key at
 * all (no dedupe key, no global id, no problem/file/symbol) is kept under a
 * per-round synthetic key rather than dropped: an unidentifiable finding is
 * still a finding, and dropping it here would be absence-as-clean again.
 *
 * # Every round, not only the ingested ones
 *
 * This used to filter to `round.ingested`, and that filter was the same defect
 * one level up. A round is "not ingested" when its `manifest.json` or its
 * `findings.json` could not be read — and when it is the MANIFEST that is
 * unreadable, `findings.json` is still right there and still says a blocker was
 * raised. Filtering the round out deleted that blocker from the evaluation, so
 * truncating a manifest turned a failing gate into a passing one. A round that
 * cannot be read is not a round that found nothing; whatever of it CAN be read
 * still counts, and condition 1 fails separately on the part that could not.
 */
export function latestFindingStates(rounds: readonly ReviewRoundRecord[]): GateFinding[] {
  const groups = new KeyGroups();
  for (const round of rounds) {
    for (const finding of round.findings) {
      groups.link(identityKeys(finding));
    }
  }
  const latest = new Map<string, GateFinding>();
  const order: string[] = [];
  for (const round of rounds) {
    for (const [index, finding] of round.findings.entries()) {
      const keys = identityKeys(finding);
      const identity = groups.representative(keys) ?? `unidentified:${round.reviewId}:${index}`;
      if (!latest.has(identity)) {
        order.push(identity);
      }
      latest.set(identity, finding);
    }
  }
  return order.flatMap((identity) => {
    const finding = latest.get(identity);
    return finding === undefined ? [] : [finding];
  });
}

function identityKeys(finding: GateFinding): string[] {
  return findingIdentities({
    ...(finding.dedupeKey === null ? {} : { dedupe_key: finding.dedupeKey }),
    ...(finding.globalId === undefined ? {} : { global_id: finding.globalId }),
    ...(finding.reviewer === undefined ? {} : { reviewer: finding.reviewer }),
    ...(finding.file === null ? {} : { file: finding.file }),
    ...(finding.symbol === null ? {} : { symbol: finding.symbol }),
    ...(finding.line === null ? {} : { line: finding.line }),
    ...(finding.problem === undefined ? {} : { problem: finding.problem }),
  });
}

// ---------------------------------------------------------------------------
// Resolving the pull request's head commit
// ---------------------------------------------------------------------------

/**
 * How the attempt to resolve the pull request's head commit ended.
 *
 * This replaces a `string | null`, and it replaces it because that `null` was
 * read by two conditions and described wrongly by both. FIVE different facts
 * produced it:
 *
 * 1. the flow records no pull request at all;
 * 2. no tracker is wired into this process;
 * 3. a tracker is wired and `detect()` refused — `gh` is not on `PATH`, or
 *    `gh auth status` exited non-zero (`src/flow/tracker/github.ts`);
 * 4. the tracker ran and the pull request does not exist or is not visible;
 * 5. the tracker ran, the pull request exists, and it reported no head SHA (a
 *    `gh` too old for `headRefOid`).
 *
 * Condition 3 called 3, 4 and 5 alike "the tracker did not report a head SHA —
 * an older `gh`, or an inaccessible PR", which is a statement about a tracker
 * that in case 3 was never asked anything. Condition 4 was worse: it called all
 * five "the pull request's own head could not be resolved, so nothing
 * establishes that the collection is current", which reads as *your comment
 * record is stale*. An operator on a CI runner with no authenticated `gh` was
 * told to re-run a collection that was already current, and could not tell from
 * the message that the problem was their `gh` rather than their record.
 *
 * **"We could not look" is a third fact, beside "the record is fresh" and "the
 * record is stale."** This type is what makes it sayable, and
 * {@link prHeadResolutionSummary} / {@link prHeadResolutionRemedy} are what make
 * it say the same thing in both conditions.
 */
export type PrHeadResolution =
  | { state: "resolved"; sha: string }
  | { state: "no-pr" }
  | { state: "no-tracker" }
  | { state: "tracker-unavailable" }
  | { state: "pr-unreachable" }
  | { state: "head-unreported" };

/** The SHA when there is one, `null` for every way there is not. */
export function prHeadOf(resolution: PrHeadResolution): string | null {
  return resolution.state === "resolved" ? resolution.sha : null;
}

/** Which of the five non-answers happened, in the operator's words. */
export function prHeadResolutionSummary(resolution: PrHeadResolution): string {
  switch (resolution.state) {
    case "resolved":
      return `the pull request's head is ${resolution.sha}`;
    case "no-pr":
      return "no PR is recorded on this flow";
    case "no-tracker":
      return "no tracker is configured, so nothing could be asked";
    case "tracker-unavailable":
      return (
        "the tracker could not be reached, so the pull request was never asked about — " +
        "`gh` is not on `PATH`, or `gh auth status` exits non-zero"
      );
    case "pr-unreachable":
      return "the tracker ran and the pull request is not there, or this account cannot see it";
    case "head-unreported":
      return "the tracker was reached and did not report a head SHA (a `gh` older than the `headRefOid` field)";
  }
}

/** What to actually do about it. One remedy per state, none of them "inject a dependency". */
export function prHeadResolutionRemedy(resolution: PrHeadResolution, prUrl: string | null): string {
  switch (resolution.state) {
    case "resolved":
      return "";
    case "no-pr":
      return "Record the pull request with `keryx flow implemented <id> --pr <url>`, or complete with `--merged <sha>`.";
    case "no-tracker":
      return "Wire a tracker into the flow service, or inject `FlowServiceDeps.externalCommentsGate`.";
    case "tracker-unavailable":
      return (
        "Install `gh` and run `gh auth login` — the head is read with `gh pr view`, and `gh auth status` is " +
        "currently failing here."
      );
    case "pr-unreachable":
      return `Check that ${prUrl ?? "the recorded pull request"} still exists and that this \`gh\` account can see it.`;
    case "head-unreported":
      return "Upgrade `gh`: this one does not report `headRefOid`, which is the field the head is read from.";
  }
}

/**
 * Ask the tracker for the pull request's head, and record how the asking went.
 *
 * Every `null` this used to return is now a named state. Note the ORDER, which
 * is the whole point: `detect()` is asked before `prStatus`, so "the tracker
 * cannot run" is distinguishable from "the tracker ran and found nothing" —
 * they were indistinguishable when both produced `null`.
 */
export async function resolvePrHead(input: {
  flow: FlowState;
  tracker: TrackerAdapter | null;
}): Promise<PrHeadResolution> {
  const url = input.flow.pr.url;
  if (url === null || url === "") {
    return { state: "no-pr" };
  }
  if (input.tracker === null) {
    return { state: "no-tracker" };
  }
  if (!(await input.tracker.detect())) {
    return { state: "tracker-unavailable" };
  }
  const status = await input.tracker.prStatus(url);
  if (!status.exists) {
    return { state: "pr-unreachable" };
  }
  return status.headSha === null || status.headSha === undefined
    ? { state: "head-unreported" }
    : { state: "resolved", sha: status.headSha };
}

// ---------------------------------------------------------------------------
// External comments (§2.2 condition 4, depending on §3)
// ---------------------------------------------------------------------------

/**
 * What the external-comment collection reports, when it is wired in.
 *
 * This is a SEAM, not an implementation. The collection itself (specification
 * §3, AC8-AC13) is being built alongside this gate; the gate needs one fact from
 * it — is anything unanswered — and must neither guess its file format nor
 * pretend the answer is "no" while nothing is there to ask.
 */
export type ExternalCommentsReport = {
  /** Whether a collection pass actually ran against the PR head under review. */
  collected: boolean;
  /**
   * When `collected` is false, WHICH kind of false it is.
   *
   * `unobserved` (the default, and what every older collector means) is
   * "nothing established whether anyone commented". `violated` is "the head was
   * resolved and the record on disk demonstrably does not answer for the pull
   * request as it stands" — a fact we went and got, not a question we failed to
   * ask. Both fail the gate; the operator is told which, because the fixes are
   * different and one of them is not about the review at all.
   */
  status?: "unobserved" | "violated" | undefined;
  /** Comment references with no reply and/or no disposition. */
  unanswered: string[];
  /** Free text for the gate detail; e.g. how many were collected. */
  detail?: string | undefined;
};

export type ExternalCommentsGate = (input: {
  cwd: string;
  flowDir: string;
  flow: FlowState;
  rounds: readonly ReviewRoundRecord[];
  /**
   * How the gate's own attempt to resolve the PR head ended.
   *
   * A {@link PrHeadResolution} rather than a `string | null`, because a
   * collector that gets `null` cannot tell "the record is stale" from "nobody
   * could reach the tracker", and the message it writes is read by an operator
   * who has to act on exactly that difference. See the type's own comment for
   * the defect that forced it.
   */
  prHead: PrHeadResolution;
}) => Promise<ExternalCommentsReport | null>;

/**
 * Coverage reviewer names that DESCRIBE an external-comment collection.
 *
 * Kept for the failure message and for `keryx review status`, and deliberately
 * NOT a way to satisfy condition 4 any more. It was one, and it was a one-flag
 * bypass: `manifest.coverage` is written by `normalizeCoverage` straight from
 * `keryx review ingest --reviewers …`, with `status: "run"` and the reason
 * "selected for managed review package". Nothing collected anything.
 * `--reviewers pr-comments` therefore completed a flow with thirty unanswered
 * comments on its pull request, and the gate said so in the passing detail.
 *
 * What replaced it is {@link durableExternalCommentsGate}, which reads the
 * record the collector actually writes.
 */
export const EXTERNAL_COMMENT_COVERAGE_REVIEWERS: readonly string[] = [
  "external-comments",
  "pr-comments",
  "review-comment-collector",
];

/** `https://github.com/<owner>/<repo>/pull/<n>` -> the key the collector files under. */
export function parsePrRef(url: string): { repo: string; number: number } | null {
  const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
  const repo = match?.[1];
  const number = match?.[2];
  return repo === undefined || number === undefined ? null : { repo, number: Number(number) };
}

/**
 * Condition 4, answered from the record the collector writes.
 *
 * `.metaproject/reviews/pr-comments/<owner>__<repo>__<n>.json` is written after
 * EVERY post (`src/review/pr-comments.ts`), which is what makes it the right
 * thing to ask: it survives a session restart, it is keyed by the pull request
 * rather than by the flow or the round, and `unansweredComments` is the exact
 * question this condition asks. Both functions were exported for this and had
 * no caller.
 *
 * Absence is reported as `collected: false`, never as "nothing unanswered". A
 * pull request nobody has run the collector against and a pull request nobody
 * has commented on produce the same empty set and are different facts.
 *
 * # A stale collection is an absent one
 *
 * `rounds_collected > 0` was read as proof the collection was CURRENT, and it
 * proves nothing of the kind. Nothing in `PrCommentState` used to be datable:
 * `SeenComment` carries `first_seen_round`/`last_seen_round` and no timestamp,
 * and `keryx review comments collect` defaults `--round` to 1, so the counter
 * sat at 1 however many times collection ran. Run collect at the start of round
 * 1 against a pull request nobody had commented on — the state file is written
 * unconditionally, `seen: []` — then let a human post five CHANGES_REQUESTED
 * comments, and `flow complete` found the file, saw `rounds_collected !== 0`,
 * and passed condition 4 with the detail "0 comment(s) collected over 1
 * round(s), 0 answered, 0 outstanding". Five unanswered reviewer comments, and
 * the passing sentence said so.
 *
 * So the record now carries `collected_sha`, and it is compared against the PR
 * head the same way condition 3 compares the ROUND's head. Note the asymmetry
 * that removes: the round was checked against the pull request and the
 * collection was checked against nothing at all.
 *
 * A record with no `collected_sha` was written by an older keryx. It reads as
 * `collected: false` — never as fresh. It has exactly the property an absent
 * file has, which is that nothing in it can say when anybody last looked.
 *
 * # Three states, not two
 *
 * The freshness check shipped collapsing two of them. Once a record exists and
 * carries a `collected_sha`, exactly one of these holds:
 *
 * 1. **the head resolved and the collection matches it** — `collected: true`,
 *    the condition passes;
 * 2. **the head resolved and the collection is against a different commit**
 *    (or carries none) — `violated`: we looked, and the record demonstrably
 *    does not answer for the pull request as it stands. Re-run the collector;
 * 3. **the head could not be resolved at all** — `unobserved`: nothing was
 *    established about the record either way. This is NOT state 2, and the
 *    first version of the check reported it as state 2, so an operator whose
 *    `gh` was logged out was told their comment record was stale and sent to
 *    re-run a collection that was already current.
 *
 * State 3 still FAILS, and deliberately: rule 2 of this module's header says a
 * condition that could not be observed does not pass, and "nobody could ask the
 * pull request whether anyone commented on it" is that rule's exact subject. It
 * does not become acceptable by being spelled "we could not check". What state 3
 * gets instead of a pass is a message that names the tracker as the thing that
 * failed, names the remedy for the specific way it failed, and names the visible
 * opt-out (`completion.require_clean_round: false`) for an environment that will
 * never have one — an opt-out that reports the whole gate as `skipped` in the
 * gate list, so the waiver is on the record rather than inside a green tick.
 */
export const durableExternalCommentsGate: ExternalCommentsGate = async (input) => {
  const url = input.flow.pr.url;
  if (url === null) {
    return null;
  }
  const ref = parsePrRef(url);
  if (ref === null) {
    return {
      collected: false,
      unanswered: [],
      detail: `the recorded PR (${url}) is not a GitHub pull request URL, so no comment record can be located`,
    };
  }
  const file = prCommentsStatePath(input.cwd, ref.repo, ref.number);
  if (!(await pathExists(file))) {
    return {
      collected: false,
      unanswered: [],
      detail:
        `nothing records whether anyone commented on ${ref.repo}#${ref.number} ` +
        `(\`${path.relative(input.cwd, file)}\` does not exist). Zero collected comments and no collection at ` +
        "all are different facts, and only one of them is clean. Run " +
        `\`keryx review comments collect --repo ${ref.repo} --pr ${ref.number} --sha <pr-head>\`, or inject ` +
        "`FlowServiceDeps.externalCommentsGate` with a collector of your own.",
    };
  }
  const state = await readPrCommentState(input.cwd, ref.repo, ref.number);
  if (state.rounds_collected === 0) {
    return {
      collected: false,
      unanswered: [],
      detail: `${ref.repo}#${ref.number} has a comment record, but it says no collection round has run yet`,
    };
  }
  const collectCommand = `keryx review comments collect --repo ${ref.repo} --pr ${ref.number} --sha <pr-head>`;
  if (state.collected_sha === null) {
    // State 2, established without asking anybody: an undatable record is
    // undatable whatever the tracker says, so this is checked BEFORE the head is
    // consulted. Sending the operator to fix their `gh` here would be advice
    // about the wrong thing — a working `gh` still cannot date this file.
    return {
      collected: false,
      status: "violated",
      unanswered: [],
      detail:
        `${ref.repo}#${ref.number} has a comment record that does not say which commit it was collected against ` +
        "(no `collected_sha`; written by a keryx older than the field). A collection that cannot be dated cannot be " +
        `shown to be current, and a count of rounds is not a date. Re-run \`${collectCommand}\`.`,
    };
  }
  if (input.prHead.state !== "resolved") {
    // State 3. Note what is NOT said here: nothing about the record being stale,
    // because nothing here knows that. The record may be perfectly current; this
    // run simply could not ask.
    return {
      collected: false,
      status: "unobserved",
      unanswered: [],
      detail:
        `${ref.repo}#${ref.number} has a comment record collected against ${state.collected_sha} (round ` +
        `${state.collected_round ?? "?"}), and this run could not resolve the pull request's own head to compare ` +
        `it with: ${prHeadResolutionSummary(input.prHead)}. So the record is neither shown to be current nor shown ` +
        "to be stale — nobody looked. " +
        `${prHeadResolutionRemedy(input.prHead, url)} ` +
        "If this environment will never reach the tracker, the way past this gate is " +
        `\`completion.require_clean_round: false\` in \`${REVIEW_GATE_CONFIG_PATH}\`, which reports the review gate ` +
        "as `skipped` rather than passing it.",
    };
  }
  if (!shaMatches(state.collected_sha, input.prHead.sha)) {
    // State 2, the datable kind: we resolved the head and the record is against
    // a different commit.
    return {
      collected: false,
      status: "violated",
      unanswered: [],
      detail:
        `${ref.repo}#${ref.number} was last collected against ${state.collected_sha} (round ` +
        `${state.collected_round ?? "?"}), but the PR head is ${input.prHead.sha}. Everything anyone said after ` +
        `${state.collected_sha} is missing from this record, so "nothing outstanding" would be a statement about a ` +
        `pull request that no longer exists. Re-run \`${collectCommand}\`.`,
    };
  }
  const unanswered = unansweredComments(state);
  return {
    collected: true,
    unanswered: unanswered.map((comment) => `${comment.author} ${comment.url}`),
    detail:
      `${ref.repo}#${ref.number}: ${state.seen.length} comment(s) collected over ${state.rounds_collected} round(s) ` +
      `up to the PR head ${state.collected_sha} (round ${state.collected_round ?? "?"}), ` +
      `${state.handled_comments.length} answered, ${unanswered.length} outstanding`,
  };
};

/** A finding that came from somebody else's comment on the PR. */
export function isExternalFinding(finding: GateFinding): boolean {
  return finding.source === "external" || finding.externalRef !== undefined;
}

/**
 * Whether an external finding has been answered.
 *
 * A terminal disposition is not enough: AC13 requires exactly one REPLY per
 * collected comment, and a comment that was dispositioned in the flow package
 * and never answered on the PR is silence from the reviewer's side. The reply is
 * evidenced by a `reply_url` on the `external_ref` — the field specification
 * §3.3 records for exactly this.
 */
export function externalReplyUrl(finding: GateFinding): string | undefined {
  const ref = finding.externalRef;
  if (ref === undefined) {
    return undefined;
  }
  const value = ref["reply_url"] ?? ref["replyUrl"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export const REVIEW_GATE_CONDITIONS = [
  "ingested-round",
  "terminal-dispositions",
  "head-commit",
  "external-comments",
  "verifier-stats",
] as const;
export type ReviewGateConditionId = (typeof REVIEW_GATE_CONDITIONS)[number];

/**
 * `violated` is "we looked and it is false". `unobserved` is "nothing recorded
 * enough for the question to be answerable". Both fail the gate; they are
 * separate so the operator is told which, because the fixes are different.
 */
export type ReviewGateConditionStatus = "pass" | "violated" | "unobserved";

export type ReviewGateCondition = {
  id: ReviewGateConditionId;
  status: ReviewGateConditionStatus;
  detail: string;
};

export type ReviewGateVerdict = {
  status: "pass" | "fail" | "skipped";
  detail: string;
  conditions: ReviewGateCondition[];
  roundsSeen: number;
  ingestedRounds: number;
  capReached: boolean;
};

export type ReviewGateInput = {
  cwd: string;
  flowDir: string;
  flow: FlowState;
  config: ReviewGateConfig;
  rounds: readonly ReviewRoundRecord[];
  /**
   * How {@link resolvePrHead} got on. Required, and a {@link PrHeadResolution}
   * rather than a nullable SHA: conditions 3 and 4 both read it, and both used
   * to describe the same `null` differently and wrongly.
   */
  prHead: PrHeadResolution;
  externalComments?: ExternalCommentsReport | null | undefined;
  /** `flow complete --merged <sha>`, when that path was taken. */
  mergedCommit?: string | undefined;
  /**
   * Whether the latest round's head is CONTAINED in `mergedCommit`, resolved by
   * {@link runReviewGate} so this function stays pure.
   *
   * `unknown` covers no git, no repository, and a commit this clone does not
   * have — none of which is evidence of containment. Only `contains` relaxes
   * condition 3.
   */
  mergedCommitContainment?: MergedCommitContainment | undefined;
};

export type MergedCommitContainment = "contains" | "does-not-contain" | "unknown";

/**
 * Evaluate the five conditions. Pure: everything it reads was already read.
 */
export function evaluateReviewGate(input: ReviewGateInput): ReviewGateVerdict {
  const { rounds, config } = input;
  const ingested = rounds.filter((round) => round.ingested);
  const latestRound = ingested.at(-1);
  const capReached = rounds.length >= REVIEW_ROUND_CAP;
  const conditions: ReviewGateCondition[] = [];

  // 1. A managed review record with at least one ingested round.
  if (rounds.length === 0) {
    conditions.push({
      id: "ingested-round",
      status: "unobserved",
      detail:
        `no managed review package exists under \`.metaproject/flows/${input.flowDir}/reviews/\`. ` +
        "A flow with no recorded review has not been reviewed cleanly; it has not been reviewed.",
    });
  } else if (latestRound === undefined) {
    conditions.push({
      id: "ingested-round",
      status: "unobserved",
      detail:
        `${rounds.length} review package(s) exist and none is ingested: ` +
        rounds.map((round) => `${round.reviewId} (${round.problems.join("; ")})`).join(", ") +
        ". A round that was never ingested cannot be cited — nothing durable records what it found.",
    });
  } else {
    // A round that is present and unreadable is NOT a round that can be passed
    // over. This branch used to report `pass` while naming the lost round in the
    // detail — `1 of 2 round(s) ingested; latest is r2 (not ingested: r1)` — so
    // deleting round 1's manifest took its open blocker with it and the gate
    // went green. The unreadable round's findings are still evaluated by
    // condition 2 (see `latestFindingStates`); what this condition reports is
    // that part of the review history cannot be cited at all, which is exactly
    // the "absence reads as clean" shape this module exists to refuse.
    const unreadable = rounds.filter((round) => !round.ingested);
    conditions.push(
      unreadable.length === 0
        ? {
            id: "ingested-round",
            status: "pass",
            detail: `${ingested.length} of ${rounds.length} round(s) ingested; latest is \`${latestRound.reviewId}\``,
          }
        : {
            id: "ingested-round",
            status: "unobserved",
            detail:
              `${ingested.length} of ${rounds.length} round(s) ingested; ${unreadable.length} cannot be read: ` +
              unreadable.map((round) => `${round.reviewId} (${round.problems.join("; ")})`).join(", ") +
              ". A round that cannot be read is not a round that found nothing — repair or remove the package, " +
              "but do not complete over it.",
          },
    );
  }

  // 2. No finding without a terminal disposition, at or above the floor.
  //
  // Over the LATEST STATE OF EVERY FINDING EVER RAISED, not over the last file
  // written — see `latestFindingStates`.
  if (latestRound === undefined) {
    conditions.push({
      id: "terminal-dispositions",
      status: "unobserved",
      detail: "no ingested round to read findings from",
    });
  } else {
    const states = latestFindingStates(rounds);
    const blocking = states.filter((finding) => blocksAtFloor(finding.severity, config.severityFloor));
    const open = blocking.flatMap((finding) => {
      const verdict = findingVerdict(finding);
      return verdict.terminal
        ? []
        : [`${finding.globalId ?? finding.id} (${finding.severity}, round ${finding.round}): ${verdict.reason}`];
    });
    conditions.push(
      open.length === 0
        ? {
            id: "terminal-dispositions",
            status: "pass",
            detail:
              `${blocking.length} finding(s) at or above \`${config.severityFloor}\` across ${ingested.length} ` +
              `ingested round(s), every one terminal with the evidence its disposition requires ` +
              `(${states.length - blocking.length} below the floor, not blocking)`,
          }
        : {
            id: "terminal-dispositions",
            status: "violated",
            detail:
              `${open.length} finding(s) at or above \`${config.severityFloor}\` are not terminal: ` +
              open.join(" | "),
          },
    );
  }

  // 3. The latest round ran against the PR head commit.
  //
  // On `flow complete --merged <sha>` there IS no pull request head, and the
  // merged commit stands in for it. That comparison is exact only for a merge
  // that preserved the branch commit; a squash or a rebase mints a new one by
  // construction, so an equality test could never hold and the gate refused with
  // advice ("re-run the round") that could not be followed — the next round would
  // record the branch head again. So on this path containment is the question:
  // is the reviewed commit IN what was merged. See `mergedCommitContainment`.
  //
  // # Why the merged commit stands in HERE and not in condition 4
  //
  // Both conditions lose the pull request head when the tracker is unreachable,
  // and only this one has a substitute. That is not an oversight, it is what the
  // two conditions are asking:
  //
  //   - Condition 3 asks *was the reviewed tree the one that merged*. That is a
  //     question about COMMITS, and the merged commit answers it completely and
  //     locally — `git merge-base --is-ancestor`, no network, no `gh`.
  //   - Condition 4 asks *has anyone spoken since the record was written*. That
  //     is a question about the PULL REQUEST, and no commit answers it: a
  //     comment posted after the last round and before the merge is invisible to
  //     every fact in the local repository. Substituting the merged commit there
  //     would not relax the check, it would answer a different question and call
  //     the result clean.
  //
  // So `flow complete --merged <sha>` needs no tracker for condition 3 and still
  // needs one for condition 4 whenever a pull request is recorded on the flow.
  // That precondition is in `docs/docs/guides/review-with-a-record.md`.
  const mergedCommit = input.mergedCommit ?? null;
  const resolvedHead = prHeadOf(input.prHead);
  const onMergedPath = resolvedHead === null && mergedCommit !== null;
  const prHead = resolvedHead ?? mergedCommit;
  if (latestRound === undefined) {
    conditions.push({
      id: "head-commit",
      status: "unobserved",
      detail: "no ingested round to compare against the PR head",
    });
  } else if (latestRound.head === null) {
    conditions.push({
      id: "head-commit",
      status: "unobserved",
      detail:
        `round \`${latestRound.reviewId}\` records no target head commit (\`manifest.target.head\`), ` +
        "so there is nothing to compare with the PR head. A round whose SHA is unknown proves nothing " +
        "about what will merge.",
    });
  } else if (prHead === null) {
    conditions.push({
      id: "head-commit",
      status: "unobserved",
      // The same five states condition 4 reports, in the same words, from the
      // same helper. This branch used to infer the reason from `flow.pr.url` and
      // `tracker !== null` and therefore said "the tracker did not report a head
      // SHA" about a tracker that `detect()` had refused to run at all.
      detail:
        `the PR head commit could not be determined (${prHeadResolutionSummary(input.prHead)})` +
        `; round \`${latestRound.reviewId}\` ran against ${latestRound.head}. ` +
        prHeadResolutionRemedy(input.prHead, input.flow.pr.url),
    });
  } else if (!shaMatches(latestRound.head, prHead) && onMergedPath && input.mergedCommitContainment === "contains") {
    conditions.push({
      id: "head-commit",
      status: "pass",
      detail:
        `round \`${latestRound.reviewId}\` ran against ${latestRound.head}, which is contained in the merged ` +
        `commit ${prHead} — the reviewed tree is part of what merged.`,
    });
  } else if (!shaMatches(latestRound.head, prHead)) {
    conditions.push({
      id: "head-commit",
      status: "violated",
      detail: onMergedPath
        ? `the latest round ran against ${latestRound.head}, but the completion names merged commit ${prHead}, ` +
          `and ${latestRound.head} is not contained in it ` +
          (input.mergedCommitContainment === "unknown"
            ? "(git could not be asked — no repository here, or the commit is not in this clone)"
            : "(git reports it is not an ancestor)") +
          ". A clean round against a stale SHA proves nothing about what will merge. If this was a SQUASH or " +
          "REBASE merge the branch commit was rewritten and can never appear in the merged history, so re-running " +
          `the round against the branch will not help: ingest a round against the merged commit instead ` +
          `(\`keryx review ingest … --head ${prHead}\`), or record the pull request on the flow so the round is ` +
          "compared against the PR head rather than against the merge."
        : `the latest round ran against ${latestRound.head}, but the PR head is ${prHead}. ` +
          "A clean round against a stale SHA proves nothing about what will merge — re-run the round.",
    });
  } else {
    conditions.push({
      id: "head-commit",
      status: "pass",
      detail: `round \`${latestRound.reviewId}\` ran against the PR head ${prHead}`,
    });
  }

  // 4. No unanswered external comments (§3).
  conditions.push(externalCommentsCondition(input));

  // 5. The verifier ran, and its stats are on the record.
  if (latestRound === undefined) {
    conditions.push({
      id: "verifier-stats",
      status: "unobserved",
      detail: "no ingested round to read verification stats from",
    });
  } else if (latestRound.verification === null) {
    conditions.push({
      id: "verifier-stats",
      status: "unobserved",
      detail:
        `round \`${latestRound.reviewId}\` records no verification stats in \`scope.md\` ` +
        "(no `verification_mode:` line). Nothing says whether a verifier ran.",
    });
  } else if (latestRound.verification.mode === "off") {
    conditions.push({
      id: "verifier-stats",
      status: "violated",
      detail:
        `round \`${latestRound.reviewId}\` ran with \`verification_mode: off\` — no verdict was read, ` +
        "so no finding in it was independently checked by anyone but its author.",
    });
  } else if (latestRound.verification.claimsReceived === null) {
    // Same rule as the `verification === null` branch one level up: a mode line
    // with no claim count does not say whether anything was verified.
    conditions.push({
      id: "verifier-stats",
      status: "unobserved",
      detail:
        `round \`${latestRound.reviewId}\` records \`verification_mode: ${latestRound.verification.mode}\` and no ` +
        "`claims_received:` line, so nothing says whether the verifier was given anything to check.",
    });
  } else if (
    latestRound.verification.claimsReceived === 0 &&
    latestRound.findings.some((finding) => blocksAtFloor(finding.severity, config.severityFloor))
  ) {
    // `off` was refused on the ground that no verdict was read. The identical
    // fact holds for a mode that received nothing — and `annotate` is the
    // DEFAULT while `--verifications` is optional, so `keryx review ingest
    // --report r.md` produced `verification_mode: annotate, claims_received: 0`
    // and the gate printed "0 claim(s) received" inside the sentence saying the
    // condition held. The mode names an intention; the claim count is what was
    // actually read.
    //
    // Bounded to a round that RETAINED something at or above the floor: a round
    // with nothing to verify has verified everything there was, and failing it
    // would refuse the honest clean round.
    const blocking = latestRound.findings.filter((finding) => blocksAtFloor(finding.severity, config.severityFloor));
    conditions.push({
      id: "verifier-stats",
      status: "violated",
      detail:
        `round \`${latestRound.reviewId}\` ran with \`verification_mode: ${latestRound.verification.mode}\` and ` +
        `received 0 claims while retaining ${blocking.length} finding(s) at or above \`${config.severityFloor}\` ` +
        `(${blocking.map((finding) => finding.globalId ?? finding.id).join(", ")}). The mode says a verifier was ` +
        "meant to run; the claim count says nothing was checked. Pass the verifier's output with " +
        "`keryx review ingest --verifications <file|->`.",
    });
  } else {
    conditions.push({
      id: "verifier-stats",
      status: "pass",
      detail:
        `round \`${latestRound.reviewId}\`: verification_mode \`${latestRound.verification.mode}\`, ` +
        `${latestRound.verification.claimsReceived ?? "?"} claim(s) received, ` +
        `${latestRound.verification.refuted ?? "?"} refuted, ` +
        `${latestRound.verification.findingsRetained ?? "?"} retained`,
    });
  }

  const failing = conditions.filter((condition) => condition.status !== "pass");
  if (failing.length === 0) {
    return {
      status: "pass",
      detail:
        `all 5 conditions hold across ${ingested.length} ingested round(s)` +
        (config.notes.length === 0 ? "" : ` [config: ${config.notes.join("; ")}]`),
      conditions,
      roundsSeen: rounds.length,
      ingestedRounds: ingested.length,
      capReached,
    };
  }

  // AC7. The cap and this gate can conflict, and the conflict resolves in favour
  // of NOT completing. `complete()` already returns the flow to `in-progress` on
  // any failing gate; what this adds is that the operator is TOLD the cap is
  // spent, rather than reading a bare failure and re-running a round that is no
  // longer available.
  const capNote = capReached
    ? ` The round cap (${REVIEW_ROUND_CAP}) is reached with the gate unsatisfied: the flow stays ` +
      "in-progress and the decision is the operator's. Completing here would reintroduce the leak this gate closes."
    : "";
  const configNote = config.notes.length === 0 ? "" : ` [config: ${config.notes.join("; ")}]`;
  return {
    status: "fail",
    detail:
      `${failing.length} of 5 conditions failed — ` +
      failing.map((condition) => `${condition.id} (${condition.status}): ${condition.detail}`).join(" | ") +
      capNote +
      configNote,
    conditions,
    roundsSeen: rounds.length,
    ingestedRounds: ingested.length,
    capReached,
  };
}

function externalCommentsCondition(input: ReviewGateInput): ReviewGateCondition {
  // A flow with no PR has no comments anybody could have left on it. This is the
  // one place absence is a genuine answer rather than an unasked question.
  if (input.flow.pr.url === null) {
    return {
      id: "external-comments",
      status: "pass",
      detail: "no PR is recorded on this flow, so no external comment can exist",
    };
  }

  // What the ROUNDS say, which is an independent source of "unanswered" and is
  // checked whatever the collector reports: a finding carrying `source:
  // external` is a comment somebody left, and AC13 wants exactly one reply and
  // one disposition per comment. This runs first so a collector that answers
  // "nothing outstanding" cannot cover for a package that says otherwise.
  const externals = latestFindingStates(input.rounds).filter(isExternalFinding);
  const fromRounds = externals.flatMap((finding) => {
    const verdict = findingVerdict(finding);
    const reply = externalReplyUrl(finding);
    if (!verdict.terminal) {
      return [`${finding.globalId ?? finding.id}: ${verdict.reason}`];
    }
    if (reply === undefined) {
      return [`${finding.globalId ?? finding.id}: dispositioned but no reply was posted (no \`external_ref.reply_url\`)`];
    }
    return [];
  });

  const report = input.externalComments;
  if (report === undefined || report === null) {
    // Nothing answered the question at all. Note what this is NOT: it is not
    // "the round manifest named a collector in its coverage", which is written
    // from a CLI flag and collects nothing. See
    // {@link EXTERNAL_COMMENT_COVERAGE_REVIEWERS}.
    return {
      id: "external-comments",
      status: "unobserved",
      detail:
        `this flow has a PR (${input.flow.pr.url}) and nothing records whether anyone commented on it. ` +
        "Zero collected comments and no collection at all are different facts, and only one of them is clean. " +
        "Run `keryx review comments collect` so the durable record exists, or inject " +
        "`FlowServiceDeps.externalCommentsGate`." +
        (fromRounds.length === 0 ? "" : ` Separately, the rounds carry ${fromRounds.length} unanswered comment(s): ${fromRounds.join(" | ")}`),
    };
  }
  if (!report.collected) {
    // `unobserved` is the default because that is what every collector that
    // predates `status` means, and because it is the safe reading: a report that
    // does not claim to have established anything has not established anything.
    const status = report.status ?? "unobserved";
    return {
      id: "external-comments",
      status,
      detail:
        (status === "violated"
          ? "the external-comment record does not answer for this pull request"
          : "the external-comment collection did not run") +
        `${report.detail === undefined ? "" : `: ${report.detail}`}` +
        (fromRounds.length === 0 ? "" : `; the rounds separately carry ${fromRounds.length} unanswered comment(s): ${fromRounds.join(" | ")}`),
    };
  }

  const unanswered = [...report.unanswered, ...fromRounds];
  if (unanswered.length > 0) {
    return {
      id: "external-comments",
      status: "violated",
      detail:
        `${unanswered.length} collected comment(s) have no reply and/or no disposition: ` + unanswered.join(" | "),
    };
  }
  return {
    id: "external-comments",
    status: "pass",
    detail:
      (report.detail ?? "collection ran; nothing unanswered") +
      (externals.length === 0 ? "" : `; ${externals.length} external finding(s) in the rounds, each dispositioned and replied to`),
  };
}

/** Two SHAs denote the same commit when one is an abbreviation of the other. */
export function shaMatches(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length < 7 || right.length < 7) {
    return false;
  }
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Read everything the gate needs and evaluate it.
 *
 * Split from {@link evaluateReviewGate} so the five conditions are testable
 * without a filesystem, and so `complete()` has one call to make.
 */
export async function runReviewGate(input: {
  cwd: string;
  flowDir: string;
  flow: FlowState;
  tracker: TrackerAdapter | null;
  externalCommentsGate?: ExternalCommentsGate | undefined;
  mergedCommit?: string | undefined;
}): Promise<ReviewGateVerdict> {
  const config = await readReviewGateConfig(input.cwd);
  if (!config.requireCleanRound) {
    return {
      status: "skipped",
      detail:
        `disabled by \`completion.require_clean_round: false\` in ${REVIEW_GATE_CONFIG_PATH}. ` +
        "Nothing checked that the last review round came back clean." +
        (config.notes.length === 0 ? "" : ` [config: ${config.notes.join("; ")}]`),
      conditions: [],
      roundsSeen: 0,
      ingestedRounds: 0,
      capReached: false,
    };
  }

  const rounds = await readReviewRounds(input.cwd, input.flowDir);

  // One resolution, read by conditions 3 and 4. It carries HOW it ended, not
  // just whether it succeeded — see {@link PrHeadResolution}.
  const prHead = await resolvePrHead({ flow: input.flow, tracker: input.tracker });

  // Defaulted, not merely injectable. The seam existed and was provided by two
  // test cases and by nothing else, so in the shipping CLI condition 4 had no
  // collector at all and fell through to the coverage-name check that any
  // `--reviewers` value satisfied. A caller that forgets to wire the dependency
  // must not get a weaker gate than one that remembers.
  const externalComments = await (input.externalCommentsGate ?? durableExternalCommentsGate)({
    cwd: input.cwd,
    flowDir: input.flowDir,
    flow: input.flow,
    rounds,
    prHead,
  });

  // Only on the `--merged` path, and only when there is something to compare:
  // this is the one condition that needs to ask git, and asking it when a pull
  // request head is available would answer a question nobody asked.
  const latestRoundHead = rounds.filter((round) => round.ingested).at(-1)?.head ?? null;
  const containment =
    prHeadOf(prHead) === null && input.mergedCommit !== undefined && latestRoundHead !== null
      ? await commitContains(input.cwd, latestRoundHead, input.mergedCommit)
      : undefined;

  return evaluateReviewGate({
    cwd: input.cwd,
    flowDir: input.flowDir,
    flow: input.flow,
    config,
    rounds,
    prHead,
    ...(externalComments === undefined ? {} : { externalComments }),
    ...(input.mergedCommit === undefined ? {} : { mergedCommit: input.mergedCommit }),
    ...(containment === undefined ? {} : { mergedCommitContainment: containment }),
  });
}

/**
 * Is `commit` an ancestor of (or the same commit as) `descendant`?
 *
 * `git merge-base --is-ancestor` exits 0 for yes and 1 for no; anything else —
 * no git, no repository, a commit this clone never fetched — is `unknown`, which
 * this gate treats as "not shown to be contained" rather than as either answer.
 * The same shape `verifyCommitOnMain` uses for the main-merge gate, kept here
 * rather than shared because that one asks about `origin/main` and this one asks
 * about a commit the caller named.
 */
export async function commitContains(
  cwd: string,
  commit: string,
  descendant: string,
): Promise<MergedCommitContainment> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit.trim()) || !/^[0-9a-f]{7,64}$/i.test(descendant.trim())) {
    return "unknown";
  }
  try {
    const proc = Bun.spawn(["git", "merge-base", "--is-ancestor", commit.trim(), descendant.trim()], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return "contains";
    }
    return exitCode === 1 ? "does-not-contain" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The gate as `complete()` records it.
 *
 * Opt-in per package, exactly like the task gate: `gates.review` is written by
 * `flow init`, so every package created after this landed is covered and no
 * historical one is retroactively invalidated. An absent flag reports `skipped`
 * — in the gate list, where it can be read, rather than silently absent.
 */
export async function reviewGate(input: {
  cwd: string;
  flowDir: string;
  flow: FlowState;
  tracker: TrackerAdapter | null;
  externalCommentsGate?: ExternalCommentsGate | undefined;
  mergedCommit?: string | undefined;
}): Promise<{ name: "review"; status: "pass" | "fail" | "skipped"; detail: string }> {
  if (input.flow.gates?.review !== true) {
    return {
      name: "review",
      status: "skipped",
      detail:
        "review gate not enabled for this package (created before the gate); " +
        "flows created by this keryx version opt in automatically",
    };
  }
  const verdict = await runReviewGate(input);
  return { name: "review", status: verdict.status, detail: verdict.detail };
}
