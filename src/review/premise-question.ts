// Looking up the finding an operator answers (flow 459): shared by `keryx review decide-premise` and the
// `review_decide_premise` card, so both refuse the same things and show the same facts.

import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { premiseDecisionFor, readPremiseDecisions } from "./operator-decisions";
import { PREMISES_FILE, isHeldVerdict, premiseHoldState } from "./premise";

export type HeldFinding = {
  /** The key the decision is recorded under: the finding's `global_id`, else its `id`. */
  key: string;
  severity: string;
  problem: string;
  verdict: string;
  question: string;
  /** The operator's earlier answer, when the question was already answered (a later answer replaces it). */
  answered?: "uphold" | "dismiss" | undefined;
};

export type HeldFindingLookup = { ok: true; finding: HeldFinding } | { ok: false; refusal: string };

const obj = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/**
 * The held finding `ref` names (its `global_id` or `id`) in the package's findings.json. Refuses an unknown finding, an
 * ambiguous id and a finding the premise judge did not hold. The judge's claim in research-evidence/premises.json counts
 * when the finding record carries no premise yet (the verdict applies the file the same way).
 */
export async function findHeldFinding(packageDir: string, ref: string): Promise<HeldFindingLookup> {
  const wanted = ref.trim();
  if (wanted === "") return { ok: false, refusal: "a finding id is required" };
  const findings = await readJsonFileOr<unknown>(path.join(packageDir, "findings.json"), undefined);
  const records = Array.isArray(findings) ? findings.map(obj).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
  const named = records.filter((record) => str(record["global_id"]) === wanted || str(record["id"]) === wanted);
  if (named.length === 0) return { ok: false, refusal: `No finding "${wanted}" in ${path.basename(packageDir)}/findings.json. Name a finding by its global_id or id.` };
  const keys = new Set(named.map((record) => str(record["global_id"]) ?? str(record["id"]) ?? wanted));
  if (keys.size > 1) return { ok: false, refusal: `"${wanted}" names ${keys.size} findings (${[...keys].join(", ")}); name one by its global_id.` };
  const record = named[0] as Record<string, unknown>;
  const key = [...keys][0] as string;
  const decisions = await readPremiseDecisions(packageDir);
  const claims = obj(await readJsonFileOr<unknown>(path.join(packageDir, PREMISES_FILE), undefined));
  const claim = Array.isArray(claims?.["premises"])
    ? (claims["premises"] as unknown[]).map(obj).find((entry) => entry !== undefined && [str(record["global_id"]), str(record["id"])].includes(str(entry["finding_id"]))) 
    : undefined;
  const premise = obj(record["premise"]) ?? (claim !== undefined && isHeldVerdict(claim["verdict"]) ? claim : undefined);
  if (premise === undefined || !isHeldVerdict(premise["verdict"])) {
    return { ok: false, refusal: `Finding ${key} is not held: the premise judge did not challenge it, so there is no premise question to answer.` };
  }
  const answered = premiseDecisionFor(decisions, str(record["global_id"]), str(record["id"]))?.answer;
  // `premiseHoldState` reads the record's own `operator` answer as well; both mean "answered".
  const state = premiseHoldState({ ...record, premise }, decisions);
  return {
    ok: true,
    finding: {
      key,
      severity: str(record["severity"]) ?? "unknown",
      problem: str(record["problem"]) ?? str(record["summary"]) ?? str(record["title"]) ?? "(no problem statement)",
      verdict: str(premise["verdict"]) ?? "challenged",
      question: str(premise["question"]) ?? "(the judge recorded no question)",
      ...(state === "awaiting" ? {} : { answered: answered ?? (state === "upheld" ? "uphold" : "dismiss") }),
    },
  };
}
