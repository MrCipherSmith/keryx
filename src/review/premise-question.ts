// The operator's answer to a finding the premise judge held (flow 459): looked up and recorded here, for both
// `keryx review decide-premise` and the `review_decide_premise` card, so the two refuse the same things, show the same
// facts and write the same records.

import { createHash } from "node:crypto";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { readPremiseDecisions, recordPremiseDecision, type OperatorDecisionVia, type PremiseDecisionSubject, type PremiseQuestionDecision } from "./operator-decisions";
import { applyPremiseDecision, isHeldVerdict, latestPremiseDecision, premiseHoldState, premiseSubjectOf } from "./premise";

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
 * Record the operator's answer and apply it to the finding record, under one lock: the decision goes to
 * operator-decisions.json (what the verdict, readiness and the flow gate trust), and the answered record goes to
 * findings.json (`premise.operator`, and `dismissed-incorrect` for a dismiss), which is what the readers that know
 * nothing of premises read: the round-to-round carry (prior-round.ts) and the published round block (publish.ts). Without
 * the second write a dismissed finding is carried into the next round as open.
 */
export async function answerPremiseQuestion(packageDir: string, input: PremiseAnswer): Promise<PremiseQuestionDecision> {
  return recordPremiseDecision(
    packageDir,
    { finding: input.finding.key, answer: input.answer, reason: input.reason, quote: input.quote, at: input.at, confirmedVia: input.confirmedVia, subject: input.finding.subject },
    async (decision) => {
      const file = path.join(packageDir, FINDINGS_FILE);
      const findings = await readJsonFileOr<unknown>(file, undefined);
      if (!Array.isArray(findings)) return;
      let changed = false;
      const next = findings.map((entry) => {
        const record = obj(entry);
        if (record === undefined || latestPremiseDecision(record, [decision]) === undefined) return entry;
        const applied = applyPremiseDecision(record, decision);
        changed ||= applied !== record;
        return applied;
      });
      if (changed) await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    },
  );
}
