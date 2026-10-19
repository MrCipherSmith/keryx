// Operator decisions in `<package>/operator-decisions.json`. Two record families share the file.
//
// - Gate decisions (flow 457, T7) relax a review gate. A mutation waiver ("Not run: mutation pass" on an attended
//   review) and a reviewer-set override (a smaller set than `keryx review required` names, or mode diff) used to be
//   accepted from any `operatorQuote` in the dispatch JSON — which the agent writes. On a package stamped by `review
//   start` (./run-profile.ts) the gate now accepts them only when one of these records exists, and only two writers
//   produce one: the `review_waive_mutation` / `review_override_reviewers` cards in keryx shell (confirmedVia
//   tui-card|remote-card), and `keryx review waive-mutation|override-reviewers` at a terminal (confirmedVia terminal).
// - Premise answers (flow 459, kind `premise-question`) answer a finding the premise judge held. They relax nothing:
//   `uphold` returns the finding to the fix, `dismiss` ends it. The same provenance applies: the two writers are the
//   `review_decide_premise` card and `keryx review decide-premise`, each records how it was confirmed and the
//   operator's own words, and the record is bound to the finding it was shown (`subject`).
//
// Every write is a read-modify-write of the whole file. An atomic rename stops a torn file, not a lost update, so the
// read and the write run under one lock beside the file: two writers that overlap both land.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { cardPressFields, hostQuestionFields, isHostQuestion, type CardPress, type ConfirmedVia, type HostQuestion } from "./types";

export const OPERATOR_DECISIONS_FILE = "operator-decisions.json";
/**
 * The lock directory serialising writes to {@link OPERATOR_DECISIONS_FILE} and to the package's findings.json: the
 * decisions writers, a premise answer (which writes both), the disposition recorder and ingest all take it.
 */
export const OPERATOR_DECISIONS_LOCK = ".operator-decisions.lock";

/** The gate decisions: the kinds that relax a gate and carry the quote/subject shape of {@link OperatorDecision}. */
export const OPERATOR_DECISION_KINDS = ["mutation-waiver", "reviewer-override"] as const;
export type OperatorDecisionKind = (typeof OPERATOR_DECISION_KINDS)[number];
/** The premise answer (flow 459): a different record, see {@link PremiseQuestionDecision}. */
export const PREMISE_DECISION_KIND = "premise-question";
/** Every kind the file may hold. */
export type AnyOperatorDecisionKind = OperatorDecisionKind | typeof PREMISE_DECISION_KIND;

/**
 * How the operator's words reached the package: a shell card, its remote mirror, a terminal prompt, or (flow 467) a
 * question the host asked with its own tool and the agent recorded: weaker than a card, because keryx did not see the
 * press and takes the question and the answer as the agent reports them. A record of it carries `hostQuestion`.
 */
export type OperatorDecisionVia = ConfirmedVia | "terminal" | "host-question";
const VIAS: readonly OperatorDecisionVia[] = ["tui-card", "remote-card", "terminal", "host-question"];

/** Who answers a premise question. Both writers record this one label; how it was confirmed is `confirmedVia`. */
export const PREMISE_DECISION_ACTOR = "operator";

/**
 * What the card or the terminal showed the operator (security review M4): the head the package was at, and the
 * mutant ids left unrun (mutation waiver) or the required reviewers left out (override). The gate accepts a decision
 * only for that head and only while what is waived now is a subset of what was shown: a new head, a new mutant or
 * another dropped reviewer needs the operator again.
 */
export type OperatorDecisionSubject = { head?: string | undefined; items: string[] };

export type OperatorDecision = {
  kind: OperatorDecisionKind;
  quote: string;
  reason: string;
  confirmedVia: OperatorDecisionVia;
  at: string;
  subject?: OperatorDecisionSubject | undefined;
  /** Set with `confirmedVia: "host-question"` only (flow 467); absent on every older record. */
  hostQuestion?: HostQuestion | undefined;
} & CardPress;

/**
 * What the operator was shown when answering a premise question: the finding's severity, the judge's verdict, and a
 * hash of the finding's problem text. A decision counts only while the finding still matches it, so a re-ingest that
 * reuses the id for a different finding (or changes its severity or verdict) needs the operator again.
 */
export type PremiseDecisionSubject = { severity: string; verdict: string; problemSha256: string };

/**
 * The operator's answer to a held finding (flow 459): `keryx review decide-premise` / the `review_decide_premise` card.
 * `uphold` returns the finding to kept at its original severity; `dismiss` records `dismissed-incorrect` with `reason`
 * as the evidence. `finding` is the finding's `global_id` or `id`; `quote` is what the operator typed or confirmed.
 */
export type PremiseQuestionDecision = {
  kind: typeof PREMISE_DECISION_KIND;
  finding: string;
  answer: "uphold" | "dismiss";
  reason: string;
  quote: string;
  at: string;
  /** Always {@link PREMISE_DECISION_ACTOR}: a label, not an identity. */
  actor: string;
  confirmedVia: OperatorDecisionVia;
  subject: PremiseDecisionSubject;
  /** Set when the answer was copied from an earlier round's package for a carried finding (flow 459): that package's path. */
  carriedFrom?: string | undefined;
  /** Set with `confirmedVia: "host-question"` only (flow 467); absent on every older record. */
  hostQuestion?: HostQuestion | undefined;
} & CardPress;

/** What a writer passes: the store fills in the kind and the actor, so both writers record the same convention. */
export type PremiseDecisionInput = Omit<PremiseQuestionDecision, "kind" | "actor">;

export type OperatorDecisionsFile = { schemaVersion: 1; decisions: Array<OperatorDecision | PremiseQuestionDecision> };

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function validPremiseSubject(value: unknown): value is PremiseDecisionSubject {
  if (value === null || typeof value !== "object") return false;
  const subject = value as Record<string, unknown>;
  return text(subject.severity) && text(subject.verdict) && text(subject.problemSha256);
}

/** Older records have no `hostQuestion`; a record that says `host-question` must carry a complete one. */
function viaConsistent(d: Record<string, unknown>): boolean {
  return d.confirmedVia === "host-question" ? isHostQuestion(d.hostQuestion) : true;
}

function validPremise(entry: unknown): entry is PremiseQuestionDecision {
  if (entry === null || typeof entry !== "object") return false;
  const d = entry as Record<string, unknown>;
  return (
    d.kind === PREMISE_DECISION_KIND &&
    text(d.finding) &&
    (d.answer === "uphold" || d.answer === "dismiss") &&
    text(d.reason) &&
    text(d.quote) &&
    text(d.at) &&
    text(d.actor) &&
    VIAS.includes(d.confirmedVia as OperatorDecisionVia) &&
    viaConsistent(d) &&
    validPremiseSubject(d.subject)
  );
}

function validGateDecision(entry: unknown): entry is OperatorDecision {
  if (entry === null || typeof entry !== "object") return false;
  const d = entry as Record<string, unknown>;
  return (
    (OPERATOR_DECISION_KINDS as readonly unknown[]).includes(d.kind) &&
    text(d.quote) &&
    text(d.reason) &&
    VIAS.includes(d.confirmedVia as OperatorDecisionVia) &&
    viaConsistent(d) &&
    text(d.at) &&
    (d.subject === undefined || validSubject(d.subject))
  );
}

function validDecision(entry: unknown): entry is OperatorDecision | PremiseQuestionDecision {
  return validGateDecision(entry) || validPremise(entry);
}

/**
 * A file name as a case-insensitive, normalisation-insensitive filesystem may compare it (review SEC3-001): NFKC (a
 * full-width or composed spelling is its plain form), then upper- and lower-cased, so U+017F long s and U+0131 dotless
 * i land on `s` and `i`, and U+212A Kelvin on `k`. Wider than any one filesystem's match, which is the point: a name
 * that folds onto an operator-only name is treated as that name.
 */
export function foldFileName(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/**
 * The decisions store's path, read by its exact name only (review SEC3-001). Undefined when the package holds no entry
 * of that exact name: on a case-insensitive volume the plain path would open a look-alike an agent planted
 * (`operator-deciſions.json`), so the store is never read through a name it does not have. Throws when any other
 * entry folds to the store's name ({@link foldFileName}): with a look-alike in the package, which file the filesystem
 * opens is not a fact the reader can trust, so no decision is read or written until it is removed.
 */
async function decisionsStorePath(packageDir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(packageDir);
  } catch {
    return undefined;
  }
  const folded = foldFileName(OPERATOR_DECISIONS_FILE);
  const lookalikes = names.filter((name) => name !== OPERATOR_DECISIONS_FILE && foldFileName(name) === folded);
  if (lookalikes.length > 0) {
    throw new Error(
      `${path.basename(packageDir)} holds ${lookalikes.map((name) => JSON.stringify(name)).join(", ")}, which a case-insensitive filesystem may read as ${OPERATOR_DECISIONS_FILE}. No operator decision is read or written while it is there: only the operator's own commands write that file, so remove the look-alike and check the decisions again.`,
    );
  }
  return names.includes(OPERATOR_DECISIONS_FILE) ? path.join(packageDir, OPERATOR_DECISIONS_FILE) : undefined;
}

async function readEntries(packageDir: string): Promise<unknown[]> {
  const store = await decisionsStorePath(packageDir);
  const file = store === undefined ? undefined : await readJsonFileOr<unknown>(store, undefined);
  return file !== null && typeof file === "object" && Array.isArray((file as { decisions?: unknown }).decisions) ? (file as { decisions: unknown[] }).decisions : [];
}

/**
 * Run `fn` holding the package's decisions lock. Not re-entrant: `fn` must not call a recorder in this module, which
 * takes the lock itself.
 */
export async function withOperatorDecisionsLock<T>(packageDir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(packageDir, OPERATOR_DECISIONS_LOCK), fn);
}

/** Append one entry, keeping every valid entry the file holds. The caller holds the lock. */
async function appendDecision(packageDir: string, entry: OperatorDecision | PremiseQuestionDecision): Promise<void> {
  // The whole valid file, both families: writing back only one kind would drop the other's entries.
  const decisions = (await readEntries(packageDir)).filter(validDecision);
  const body: OperatorDecisionsFile = { schemaVersion: 1, decisions: [...decisions, entry] };
  await writeFileAtomic(path.join(packageDir, OPERATOR_DECISIONS_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

/** The gate-relaxing decisions (mutation waiver, reviewer override). A `premise-question` record is read by {@link readPremiseDecisions}. */
export async function readOperatorDecisions(packageDir: string): Promise<OperatorDecision[]> {
  return (await readEntries(packageDir)).filter(validGateDecision);
}

/**
 * The premise-question decisions the package holds, oldest first. Only a complete record counts: one without how it was
 * confirmed, the operator's words or the subject it was shown is not an operator decision.
 */
export async function readPremiseDecisions(packageDir: string): Promise<PremiseQuestionDecision[]> {
  return (await readEntries(packageDir)).filter(validPremise);
}

/** What an `applyFirst` step hands back: how to undo its write, and a value the caller reads once the decision landed. */
export type AppliedFirst<A> = { undo: () => Promise<void>; value: A };

/** Appends a premise-question decision (the operator's answer, or one carried from an earlier round). */
export async function recordPremiseDecision(packageDir: string, input: PremiseDecisionInput): Promise<PremiseQuestionDecision> {
  return (await recordPremiseDecisionAfter(packageDir, input, async () => undefined)).decision;
}

/**
 * Appends a premise-question decision after `applyFirst`, inside the same lock: the answer command uses it to apply the
 * answer to findings.json, so no other writer interleaves between the two files. The two writes land together or not
 * at all (review HL2-003): a failed append runs `applyFirst`'s undo before the error reaches the caller, and a failed
 * `applyFirst` records nothing. Either way a retry starts from the state before the answer, never from a recorded
 * decision whose findings.json was not updated. `applied` is `applyFirst`'s value, returned only once both landed.
 */
export async function recordPremiseDecisionAfter<A>(
  packageDir: string,
  input: PremiseDecisionInput,
  applyFirst: (decision: PremiseQuestionDecision) => Promise<AppliedFirst<A> | undefined>,
): Promise<{ decision: PremiseQuestionDecision; applied: A | undefined }> {
  const kept: PremiseQuestionDecision = {
    kind: PREMISE_DECISION_KIND,
    finding: typeof input.finding === "string" ? input.finding.trim() : input.finding,
    answer: input.answer,
    reason: typeof input.reason === "string" ? input.reason.trim() : input.reason,
    quote: typeof input.quote === "string" ? input.quote.trim() : input.quote,
    at: input.at,
    actor: PREMISE_DECISION_ACTOR,
    confirmedVia: input.confirmedVia,
    ...cardPressFields(input),
    subject: input.subject,
    ...(input.carriedFrom === undefined ? {} : { carriedFrom: input.carriedFrom }),
    ...hostQuestionFields(input),
  };
  if (!validPremise(kept)) {
    throw new Error("a premise decision needs the finding, an answer of uphold or dismiss, a reason, the operator's words, the time, how it was confirmed and the finding it was shown");
  }
  const applied = await withOperatorDecisionsLock(packageDir, async () => {
    const first = await applyFirst(kept);
    try {
      await appendDecision(packageDir, kept);
    } catch (error) {
      await first?.undo();
      throw error;
    }
    return first?.value;
  });
  return { decision: kept, applied };
}

function validSubject(value: unknown): value is OperatorDecisionSubject {
  if (value === null || typeof value !== "object") return false;
  const subject = value as Record<string, unknown>;
  return Array.isArray(subject.items) && subject.items.every((item) => typeof item === "string") && (subject.head === undefined || typeof subject.head === "string");
}

/** Whether `decision` was shown at least what `now` waives, at the same head. A decision without a subject covers nothing. */
export function decisionCovers(decision: OperatorDecision, now: OperatorDecisionSubject): boolean {
  if (!validSubject(decision.subject)) return false;
  if ((decision.subject.head ?? "") !== (now.head ?? "")) return false;
  const shown = new Set(decision.subject.items);
  return now.items.every((item) => shown.has(item));
}

/**
 * The latest valid decision of `kind`, or undefined. With `now`, only a decision bound to that head whose shown items
 * include every item waived now (`decisionCovers`).
 */
export async function confirmedDecision(packageDir: string, kind: OperatorDecisionKind, now?: OperatorDecisionSubject): Promise<OperatorDecision | undefined> {
  return (await readOperatorDecisions(packageDir)).filter((decision) => decision.kind === kind && (now === undefined || decisionCovers(decision, now))).at(-1);
}

export async function recordOperatorDecision(packageDir: string, decision: OperatorDecision): Promise<OperatorDecision> {
  if (!validGateDecision(decision)) throw new Error("an operator decision needs a kind, the operator's words, a reason, how it was confirmed and the time");
  const subject = decision.subject === undefined ? undefined : { ...(decision.subject.head === undefined ? {} : { head: decision.subject.head }), items: [...new Set(decision.subject.items)].sort() };
  const entry: OperatorDecision = { ...decision, quote: decision.quote.trim(), reason: decision.reason.trim(), ...cardPressFields(decision), ...(subject === undefined ? {} : { subject }) };
  await withOperatorDecisionsLock(packageDir, () => appendDecision(packageDir, entry));
  return decision;
}

/** The card or command that records `kind`, for a refusal to name. */
export function decisionWriters(kind: AnyOperatorDecisionKind, packageArg = "<review-dir>"): string {
  if (kind === PREMISE_DECISION_KIND) {
    return `in keryx shell, call the review_decide_premise tool (the operator answers a card); elsewhere ask the operator with the host's question tool, or in a terminal, run \`keryx review decide-premise --package ${packageArg} --finding <id> --answer uphold|dismiss --reason "<why>"\` (from a host question add --answered-by <source>:<ref> --answer-text "<their words>" --question-text "<the question>")`;
  }
  return kind === "mutation-waiver"
    ? `in keryx shell, call the review_waive_mutation tool (the operator answers a card); elsewhere ask the operator with the host's question tool, or in a terminal, run \`keryx review waive-mutation --package ${packageArg} --reason "<why>"\` (from a host question add --answered-by <source>:<ref> --answer-text "<their words>" --question-text "<the question>")`
    : `in keryx shell, call the review_override_reviewers tool (the operator answers a card); elsewhere ask the operator with the host's question tool, or in a terminal, run \`keryx review override-reviewers --package ${packageArg} --reason "<why>"\` (from a host question add --answered-by <source>:<ref> --answer-text "<their words>" --question-text "<the question>")`;
}
