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
  /** Whether a collection pass actually ran against the PR. */
  collected: boolean;
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
        `\`keryx review comments collect --repo ${ref.repo} --pr ${ref.number}\`, or inject ` +
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
  const unanswered = unansweredComments(state);
  return {
    collected: true,
    unanswered: unanswered.map((comment) => `${comment.author} ${comment.url}`),
    detail:
      `${ref.repo}#${ref.number}: ${state.seen.length} comment(s) collected over ${state.rounds_collected} round(s), ` +
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
  tracker: TrackerAdapter | null;
  config: ReviewGateConfig;
  rounds: readonly ReviewRoundRecord[];
  /** The PR head, when the caller already resolved it. `undefined` = unknown. */
  prHead?: string | null | undefined;
  externalComments?: ExternalCommentsReport | null | undefined;
  /** `flow complete --merged-commit`, when that path was taken. */
  mergedCommit?: string | undefined;
};

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
  const prHead = input.prHead ?? (input.mergedCommit ?? null);
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
      detail:
        "the PR head commit could not be determined" +
        (input.flow.pr.url === null
          ? " (no PR recorded on this flow)"
          : input.tracker === null
            ? " (no tracker configured)"
            : " (the tracker did not report a head SHA — an older `gh`, or an inaccessible PR)") +
        `; round \`${latestRound.reviewId}\` ran against ${latestRound.head}.`,
    });
  } else if (!shaMatches(latestRound.head, prHead)) {
    conditions.push({
      id: "head-commit",
      status: "violated",
      detail:
        `the latest round ran against ${latestRound.head}, but the PR head is ${prHead}. ` +
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
    return {
      id: "external-comments",
      status: "unobserved",
      detail:
        `the external-comment collection did not run${report.detail === undefined ? "" : `: ${report.detail}`}` +
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

  let prHead: string | null = null;
  if (input.flow.pr.url !== null && input.tracker !== null && (await input.tracker.detect())) {
    const status = await input.tracker.prStatus(input.flow.pr.url);
    prHead = status.exists ? (status.headSha ?? null) : null;
  }

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
  });

  return evaluateReviewGate({
    cwd: input.cwd,
    flowDir: input.flowDir,
    flow: input.flow,
    tracker: input.tracker,
    config,
    rounds,
    prHead,
    ...(externalComments === undefined ? {} : { externalComments }),
    ...(input.mergedCommit === undefined ? {} : { mergedCommit: input.mergedCommit }),
  });
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
