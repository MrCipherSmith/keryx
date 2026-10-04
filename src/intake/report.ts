// Flow 403 (AC20): the usefulness report, built from the ledger alone.
//
// The ledger carries ids, kinds, states, choices and times, never a title, a body or an assessment, so nothing
// in this report (and nothing in `--json`) can leak ticket text. The card -> flow -> PR chain is read from the
// flows' own `flow.json` (a flow that opened a pull request records its URL there).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { INTAKE_ACTIONS_BY_KIND, INTAKE_EVENT_KINDS, type IntakeCardKind, type IntakeChainLink, type IntakeKindReport, type IntakeLedgerCard, type IntakeReport } from "./types";
import { readIntakeLedgerCards } from "./store";

const KIND_ORDER: readonly IntakeCardKind[] = [...INTAKE_EVENT_KINDS, "overflow"];

/** States that mean a human made a choice (`later` included: it is a choice, and it was answered). */
const DECIDED_STATES = new Set(["decided", "taking", "taken", "failed"]);

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function kindReport(kind: IntakeCardKind, cards: readonly IntakeLedgerCard[]): IntakeKindReport {
  const decisions: Record<string, number> = {};
  const answers: number[] = [];
  let withSuggestion = 0;
  let matched = 0;
  for (const c of cards) {
    if (c.choice === undefined || !DECIDED_STATES.has(c.state)) continue;
    decisions[c.choice] = (decisions[c.choice] ?? 0) + 1;
    if (c.timeToAnswerMs !== undefined) answers.push(c.timeToAnswerMs);
    if (c.suggestion !== undefined) {
      withSuggestion += 1;
      if (c.suggestion === c.choice) matched += 1;
    }
  }
  return {
    kind,
    cards: cards.length,
    decisions,
    medianAnswerMs: median(answers),
    matchedSuggestion: withSuggestion === 0 ? null : matched / withSuggestion,
    decidedWithSuggestion: withSuggestion,
  };
}

async function prOfFlow(root: string, flowId: string): Promise<string | null> {
  if (!/^[0-9]+$/.test(flowId)) return null;
  const flows = path.join(root, ".metaproject", "flows");
  try {
    const dir = (await readdir(flows)).find((d) => d.startsWith(`${flowId}-`));
    if (dir === undefined) return null;
    const flow = JSON.parse(await readFile(path.join(flows, dir, "flow.json"), "utf8")) as { pr?: { url?: unknown } } | null;
    const url = flow?.pr?.url;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export async function buildIntakeReport(root: string, now: () => Date = () => new Date()): Promise<IntakeReport> {
  const cards = await readIntakeLedgerCards(root);
  const kinds = KIND_ORDER.map((kind) => kindReport(kind, cards.filter((c) => c.kind === kind))).filter((k) => k.cards > 0);
  const chains: IntakeChainLink[] = [];
  for (const c of cards) {
    if (c.flowId === undefined) continue;
    chains.push({ cardId: c.cardId, kind: c.kind, flowId: c.flowId, pr: await prOfFlow(root, c.flowId) });
  }
  return { schema: 1, generatedAt: now().toISOString(), totalCards: cards.length, kinds, chains };
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} мин` : `${(m / 60).toFixed(1)} ч`;
}

/** The text the CLI prints without `--json`. */
export function formatIntakeReport(report: IntakeReport): string {
  if (report.totalCards === 0) return "Intake: карточек пока нет.\n";
  const lines = [`Intake: карточек ${report.totalCards}`, ""];
  for (const k of report.kinds) {
    const decisions = Object.entries(k.decisions)
      .map(([a, n]) => `${a} ${n}`)
      .join(", ");
    const match = k.matchedSuggestion === null ? "—" : `${Math.round(k.matchedSuggestion * 100)}% (из ${k.decidedWithSuggestion})`;
    const buttons = k.kind === "overflow" ? "" : ` [${INTAKE_ACTIONS_BY_KIND[k.kind].join("/")}]`;
    lines.push(`${k.kind}${buttons}: карточек ${k.cards}; решения: ${decisions || "нет"}; медиана ответа ${formatDuration(k.medianAnswerMs)}; совпало с подсказкой ${match}`);
  }
  if (report.chains.length > 0) {
    lines.push("", "Карточка → flow → PR:");
    for (const c of report.chains) lines.push(`  ${c.cardId} → flow ${c.flowId} → ${c.pr ?? "PR ещё нет"}`);
  }
  return `${lines.join("\n")}\n`;
}
