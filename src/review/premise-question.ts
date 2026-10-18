// The operator's answer to a finding the premise judge held (flow 459): looked up and recorded here, for both
// `keryx review decide-premise` and the `review_decide_premise` card, so the two refuse the same things, show the same
// facts and write the same records.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { readPremiseDecisions, recordPremiseDecision, recordPremiseDecisionAfter, type AppliedFirst, type OperatorDecisionVia, type PremiseDecisionSubject, type PremiseQuestionDecision } from "./operator-decisions";
import { isReviewPackageDir } from "./package-location";
import { applyPremiseDecision, isHeldVerdict, latestPremiseDecision, premiseHoldState, premiseSubjectOf } from "./premise";
import { recordFinishedRound, registryVouchesPackage } from "./round-registry";

export type HeldFinding = {
  /** The key the decision is recorded under: the finding's `global_id`, else its `id`. */
  key: string;
  severity: string;
  problem: string;
  verdict: string;
  question: string;
  /** The operator's earlier answer, when the question was already answered (a later answer replaces it). */
  answered?: "uphold" | "dismiss" | undefined;
  /** What a decision is bound to (see `premiseSubjectOf`). */
  subject: PremiseDecisionSubject;
  /** sha256 of everything above as shown: a card compares it before it records, so a change after showing refuses. */
  digest: string;
};

export type HeldFindingLookup = { ok: true; finding: HeldFinding } | { ok: false; refusal: string };

const FINDINGS_FILE = "findings.json";

const obj = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/**
 * The held finding `ref` names (its `global_id` or `id`) in the package's findings.json. Refuses an unknown finding, an
 * ambiguous id and a finding the premise judge did not hold.
 *
 * The hold is read from the finding record only. Ingest wrote that record from the claims the merge ACCEPTED; the raw
 * claims file (research-evidence/premises.json) keeps the rejected claims too, so reading it here would offer the
 * operator a question the merge refused to ask.
 */
export async function findHeldFinding(packageDir: string, ref: string): Promise<HeldFindingLookup> {
  const wanted = ref.trim();
  if (wanted === "") return { ok: false, refusal: "a finding id is required" };
  const findings = await readJsonFileOr<unknown>(path.join(packageDir, FINDINGS_FILE), undefined);
  const records = Array.isArray(findings) ? findings.map(obj).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
  const named = records.filter((record) => str(record["global_id"]) === wanted || str(record["id"]) === wanted);
  if (named.length === 0) return { ok: false, refusal: `No finding "${wanted}" in ${path.basename(packageDir)}/${FINDINGS_FILE}. Name a finding by its global_id or id.` };
  const keys = new Set(named.map((record) => str(record["global_id"]) ?? str(record["id"]) ?? wanted));
  if (keys.size > 1) return { ok: false, refusal: `"${wanted}" names ${keys.size} findings (${[...keys].join(", ")}); name one by its global_id.` };
  const record = named[0] as Record<string, unknown>;
  const key = [...keys][0] as string;
  const premise = obj(record["premise"]);
  const subject = premiseSubjectOf(record);
  if (premise === undefined || !isHeldVerdict(premise["verdict"]) || subject === undefined) {
    return { ok: false, refusal: `Finding ${key} is not held: the premise judge did not challenge it, so there is no premise question to answer.` };
  }
  const decisions = await readPremiseDecisions(packageDir);
  const state = premiseHoldState(record, decisions);
  const answered: HeldFinding["answered"] = state === "upheld" ? "uphold" : state === "dismissed" ? "dismiss" : undefined;
  const shown: Omit<HeldFinding, "subject" | "digest"> = {
    key,
    severity: str(record["severity"]) ?? "unknown",
    problem: str(record["problem"]) ?? str(record["summary"]) ?? str(record["title"]) ?? "(no problem statement)",
    verdict: str(premise["verdict"]) ?? "challenged",
    question: str(premise["question"]) ?? "(the judge recorded no question)",
    ...(answered === undefined ? {} : { answered }),
  };
  const digest = createHash("sha256").update(JSON.stringify([shown.key, shown.severity, shown.problem, shown.verdict, shown.question, shown.answered ?? ""])).digest("hex");
  return { ok: true, finding: { ...shown, subject, digest } };
}

/**
 * Carry the operator's premise answers into a delta round's package (flow 459). Each finding the round carries from
 * `previousDir` keeps the answer the operator gave there, recorded as carried from that package, so an upheld finding is
 * not asked again.
 *
 * What is carried is re-validated, never trusted as found (review SEC2-001):
 * - `previousDir` must be a real review package of `projectRoot` ({@link isReviewPackageDir}), and not this package or
 *   one that contains it;
 * - only its top-level operator-decisions.json is read, and only complete records count (`readPremiseDecisions`): one
 *   without how it was confirmed, the operator's words or the subject it was shown is not carried;
 * - the previous record must still be held by the premise judge, and the decision's subject (severity, verdict,
 *   problem digest) must match it; the new round's own finding is matched against that subject again when the decision
 *   is read, so a finding whose problem changed asks the operator afresh.
 * Returns the finding keys whose answers were carried.
 */
export async function carryPremiseDecisions(
  packageDir: string,
  previousDir: string,
  carriedIds: readonly string[],
  carriedFrom: string,
  options: { projectRoot: string },
): Promise<string[]> {
  if (carriedIds.length === 0 || !isReviewPackageDir(previousDir, options.projectRoot)) return [];
  const realPrevious = realpathSync(previousDir);
  const realPackage = existsSync(packageDir) ? realpathSync(packageDir) : path.resolve(packageDir);
  if (realPrevious === realPackage || realPackage.startsWith(`${realPrevious}${path.sep}`)) return [];
  const previous = await readPremiseDecisions(realPrevious);
  if (previous.length === 0) return [];
  const findings = await readJsonFileOr<unknown>(path.join(realPrevious, FINDINGS_FILE), undefined);
  const records = Array.isArray(findings) ? findings.map(obj).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
  const have = await readPremiseDecisions(packageDir);
  const carried: string[] = [];
  for (const record of records) {
    const keys = [str(record["global_id"]), str(record["id"])].filter((key): key is string => key !== undefined);
    if (!keys.some((key) => carriedIds.includes(key))) continue;
    if (!isHeldVerdict(obj(record["premise"])?.["verdict"])) continue;
    const decision = latestPremiseDecision(record, previous);
    if (decision === undefined) continue;
    if (have.some((entry) => entry.finding === decision.finding && entry.at === decision.at && entry.carriedFrom === carriedFrom)) continue;
    const { kind: _kind, actor: _actor, ...input } = decision;
    await recordPremiseDecision(packageDir, { ...input, carriedFrom });
    carried.push(decision.finding);
  }
  return carried;
}

export type PremiseAnswer = {
  finding: HeldFinding;
  answer: "uphold" | "dismiss";
  reason: string;
  /** The operator's own words: what they typed at the terminal, or the card text they said yes to. */
  quote: string;
  at: string;
  confirmedVia: OperatorDecisionVia;
};

/**
 * Where the local round registry is read and written (the checkout, for its repository identity, and the config dir),
 * and where a registry that could not be updated is reported: the answer itself is recorded either way.
 */
export type RegistryOptions = { cwd?: string; dir?: string; warn?: (message: string) => void };

const registryPlace = (registry: RegistryOptions): { cwd?: string; dir?: string } => ({
  ...(registry.cwd === undefined ? {} : { cwd: registry.cwd }),
  ...(registry.dir === undefined ? {} : { dir: registry.dir }),
});

/**
 * Record the operator's answer and apply it to the finding record, under one lock. The answered record goes to
 * findings.json first (`premise.operator`, and `dismissed-incorrect` for a dismiss): that is what the readers that know
 * nothing of premises read, the round-to-round carry (prior-round.ts) and the published round block (publish.ts), and
 * without it a dismissed finding is carried into the next round as open. Then the decision goes to
 * operator-decisions.json (what the verdict, readiness and the flow gate trust). The two land together: a failed
 * decision write restores findings.json as it was.
 *
 * findings.json is one of the files the local round registry hashes (review RG2-001). When the registry vouched for the
 * package before the answer, the round is recorded again after it, so the next round still cuts a delta from it; an
 * answer never makes the registry vouch for a package it did not vouch for already.
 */
export async function answerPremiseQuestion(packageDir: string, input: PremiseAnswer, registry: RegistryOptions = {}): Promise<PremiseQuestionDecision> {
  const { decision, applied: vouched } = await recordPremiseDecisionAfter(
    packageDir,
    { finding: input.finding.key, answer: input.answer, reason: input.reason, quote: input.quote, at: input.at, confirmedVia: input.confirmedVia, subject: input.finding.subject },
    (kept) => applyAnswerToFindings(packageDir, kept, registry),
  );
  if (vouched === true) reRecordRegistry(packageDir, registry);
  return decision;
}

/**
 * Writes `kept` onto the finding records it answers in findings.json. Its value is whether the registry vouched for the
 * package before the write; undefined (nothing to undo) when findings.json is missing, unparseable or holds no record
 * the answer changes.
 */
async function applyAnswerToFindings(packageDir: string, kept: PremiseQuestionDecision, registry: RegistryOptions): Promise<AppliedFirst<boolean> | undefined> {
  const file = path.join(packageDir, FINDINGS_FILE);
  const before = await readFile(file, "utf8").catch(() => undefined);
  let findings: unknown;
  try {
    findings = before === undefined ? undefined : JSON.parse(before);
  } catch {
    findings = undefined;
  }
  if (before === undefined || !Array.isArray(findings)) return undefined;
  let changed = false;
  const next = findings.map((entry) => {
    const record = obj(entry);
    if (record === undefined || latestPremiseDecision(record, [kept]) === undefined) return entry;
    const applied = applyPremiseDecision(record, kept);
    changed ||= applied !== record;
    return applied;
  });
  if (!changed) return undefined;
  const vouched = registryVouchesPackage(packageDir, registryPlace(registry));
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { undo: () => writeFileAtomic(file, before), value: vouched };
}

/** Records the round again after an answer changed findings.json, which the registry hashes; a failure is a warning. */
function reRecordRegistry(packageDir: string, registry: RegistryOptions): void {
  const recorded = recordFinishedRound(packageDir, "decide-premise", registryPlace(registry));
  const problem = recorded.error ?? recorded.skipped;
  if (problem !== undefined) registry.warn?.(`the answer is recorded, but the local round registry was not updated (${problem}): the next round of this package runs full`);
  if (recorded.warning !== undefined) registry.warn?.(recorded.warning);
}
