// Operator decisions that relax a review gate (flow 457, T7): `<package>/operator-decisions.json`.
//
// A mutation waiver ("Not run: mutation pass" on an attended review) and a reviewer-set override (a smaller set than
// `keryx review required` names, or mode diff) used to be accepted from any `operatorQuote` in the dispatch JSON —
// which the agent writes. On a package stamped by `review start` (./run-profile.ts) the gate now accepts them only
// when one of these records exists, and only two writers produce one: the `review_waive_mutation` /
// `review_override_reviewers` cards in keryx shell (confirmedVia tui-card|remote-card), and `keryx review
// waive-mutation|override-reviewers` at a terminal (confirmedVia terminal).

import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import type { ConfirmedVia } from "./types";

export const OPERATOR_DECISIONS_FILE = "operator-decisions.json";

export const OPERATOR_DECISION_KINDS = ["mutation-waiver", "reviewer-override"] as const;
export type OperatorDecisionKind = (typeof OPERATOR_DECISION_KINDS)[number];

/** How the operator's words reached the package: a shell card, its remote mirror, or a terminal prompt. */
export type OperatorDecisionVia = ConfirmedVia | "terminal";
const VIAS: readonly OperatorDecisionVia[] = ["tui-card", "remote-card", "terminal"];

export type OperatorDecision = {
  kind: OperatorDecisionKind;
  quote: string;
  reason: string;
  confirmedVia: OperatorDecisionVia;
  at: string;
};

export type OperatorDecisionsFile = { schemaVersion: 1; decisions: OperatorDecision[] };

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function valid(entry: unknown): entry is OperatorDecision {
  if (entry === null || typeof entry !== "object") return false;
  const d = entry as Record<string, unknown>;
  return (
    (OPERATOR_DECISION_KINDS as readonly unknown[]).includes(d.kind) &&
    text(d.quote) &&
    text(d.reason) &&
    VIAS.includes(d.confirmedVia as OperatorDecisionVia) &&
    text(d.at)
  );
}

export async function readOperatorDecisions(packageDir: string): Promise<OperatorDecision[]> {
  const file = await readJsonFileOr<unknown>(path.join(packageDir, OPERATOR_DECISIONS_FILE), undefined);
  const list = file !== null && typeof file === "object" && Array.isArray((file as { decisions?: unknown }).decisions) ? (file as { decisions: unknown[] }).decisions : [];
  return list.filter(valid);
}

/** The latest valid decision of `kind`, or undefined. */
export async function confirmedDecision(packageDir: string, kind: OperatorDecisionKind): Promise<OperatorDecision | undefined> {
  return (await readOperatorDecisions(packageDir)).filter((decision) => decision.kind === kind).at(-1);
}

export async function recordOperatorDecision(packageDir: string, decision: OperatorDecision): Promise<OperatorDecision> {
  if (!valid(decision)) throw new Error("an operator decision needs a kind, the operator's words, a reason, how it was confirmed and the time");
  const decisions = await readOperatorDecisions(packageDir);
  const body: OperatorDecisionsFile = { schemaVersion: 1, decisions: [...decisions, { ...decision, quote: decision.quote.trim(), reason: decision.reason.trim() }] };
  await writeFileAtomic(path.join(packageDir, OPERATOR_DECISIONS_FILE), `${JSON.stringify(body, null, 2)}\n`);
  return decision;
}

/** The card or command that records `kind`, for a refusal to name. */
export function decisionWriters(kind: OperatorDecisionKind, packageArg = "<review-dir>"): string {
  return kind === "mutation-waiver"
    ? `in keryx shell, call the review_waive_mutation tool (the operator answers a card); in a terminal, run \`keryx review waive-mutation --package ${packageArg} --reason "<why>"\``
    : `in keryx shell, call the review_override_reviewers tool (the operator answers a card); in a terminal, run \`keryx review override-reviewers --package ${packageArg} --reason "<why>"\``;
}
