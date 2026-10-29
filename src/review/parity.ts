import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { EVIDENCE_DIR, pendingMutants, type MutationRecord } from "./mutate";
import { readWaveGaps } from "./wave-events";

/**
 * What a review round leaves behind that no severity or finding count shows: mutation candidates that never ran,
 * severities a survivor held in place (presentation-only, or in code the suite covers), and follow-ups the parent still owes. One projection read by
 * `keryx review status`, the `/review parity` shell view, the sidebar, and `keryx review report-parity`, so no surface
 * states a number another does not. Read-only.
 */
export type ParityHeld = { finding: string; severity: string; mutant: string; kind?: string | undefined; reason: string };

export type ParityFollowUp = {
  /** The ledger obligation id, e.g. `review-testing-practices:fu1`. */
  id: string;
  text: string;
  /** `open`: no disposition closes it. `narrowed`: closed, but a disposition says part of it remains. */
  state: "open" | "narrowed";
  remains?: string | undefined;
};

export type ReviewParityView = {
  /** Proposed mutation candidates no recorded pass has run. */
  notRun: number;
  /** The cap of the latest pass that had one. */
  cap: number | undefined;
  notRunIds: string[];
  held: ParityHeld[];
  followUps: ParityFollowUp[];
  /** `idle` events in `tool-calls/wave-events.jsonl`: pauses with open slices under an authorized plan. Absent without any. */
  gaps?: { count: number; maxMinutes: number } | undefined;
};

const FOLLOW_UP_ID = /:fu\d+$/;
/** The ledger writes the question as `…done or ruled out, and where is that recorded? <follow-up>`. */
const QUESTION_TAIL = /recorded\?\s*/;

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function latestCap(packageDir: string): Promise<number | undefined> {
  const dir = path.join(packageDir, EVIDENCE_DIR);
  if (!existsSync(dir)) return undefined;
  const names = (await readdir(dir)).filter((n) => /^mutation-\d+\.json$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  let cap: number | undefined;
  for (const name of names) {
    const record = (await readJson(path.join(dir, name))) as MutationRecord | undefined;
    if (typeof record?.cap === "number") cap = record.cap;
  }
  return cap;
}

function heldOf(findings: unknown): ParityHeld[] {
  if (!Array.isArray(findings)) return [];
  const out: ParityHeld[] = [];
  for (const finding of findings as Array<Record<string, unknown>>) {
    const audit = finding?.severity_audit;
    const held = audit !== null && typeof audit === "object" ? (audit as { held?: unknown }).held : undefined;
    if (held === null || typeof held !== "object") continue;
    const note = held as Record<string, unknown>;
    out.push({
      finding: String(finding.id ?? finding.global_id ?? "?"),
      severity: String(note.severity ?? finding.severity ?? ""),
      mutant: String(note.mutant ?? ""),
      ...(typeof note.kind === "string" ? { kind: note.kind } : {}),
      reason: String(note.reason ?? ""),
    });
  }
  return out;
}

function followUpsOf(research: unknown): ParityFollowUp[] {
  const obligations = (research as { ledger?: { obligations?: unknown } } | undefined)?.ledger?.obligations ?? (research as { obligations?: unknown } | undefined)?.obligations;
  if (!Array.isArray(obligations)) return [];
  const out: ParityFollowUp[] = [];
  for (const item of obligations as Array<Record<string, unknown>>) {
    const id = typeof item?.id === "string" ? item.id : "";
    if (!FOLLOW_UP_ID.test(id)) continue;
    const question = typeof item.question === "string" ? item.question : "";
    const text = question.includes("recorded?") ? question.split(QUESTION_TAIL).slice(1).join("recorded? ").trim() : question;
    if (item.status === "narrowed") out.push({ id, text, state: "narrowed", remains: typeof item.remains === "string" ? item.remains : undefined });
    else if (!["finding", "refuted", "out-of-scope"].includes(String(item.status))) out.push({ id, text, state: "open" });
  }
  return out;
}

export async function readReviewParity(packageDir: string): Promise<ReviewParityView> {
  const pending = await pendingMutants(packageDir).catch(() => []);
  const research = await readJson(path.join(packageDir, "research.json"));
  const gaps = await readWaveGaps(packageDir).catch(() => undefined);
  return {
    notRun: pending.length,
    cap: pending.length > 0 ? await latestCap(packageDir) : undefined,
    notRunIds: pending.map((m) => m.id),
    held: heldOf(await readJson(path.join(packageDir, "findings.json"))),
    followUps: followUpsOf(research),
    ...(gaps === undefined ? {} : { gaps }),
  };
}

export const parityIsEmpty = (view: ReviewParityView): boolean => view.notRun === 0 && view.held.length === 0 && view.followUps.length === 0 && view.gaps === undefined;

/** A pause is not a verdict: a wait for an operator card looks the same, so this line informs and never warns. */
function gapsText(gaps: { count: number; maxMinutes: number }): string {
  return `Gaps without a launch after the plan was authorized: ${gaps.count}, longest ${gaps.maxMinutes} min (waits for operator cards are possible)`;
}

function notRunText(view: ReviewParityView): string {
  const ids = view.notRunIds.length > 0 ? `: ${view.notRunIds.slice(0, 6).join(", ")}${view.notRunIds.length > 6 ? ", …" : ""}` : "";
  return `Not run: ${view.notRun} candidates${view.cap === undefined ? "" : ` (cap ${view.cap})`}${ids}`;
}

/** The lines `status`, the shell view and the sidebar print. Empty when there is nothing to say. */
export function parityLines(view: ReviewParityView | undefined): string[] {
  if (view === undefined) return [];
  const lines: string[] = [];
  if (view.notRun > 0) lines.push(notRunText(view));
  for (const held of view.held) lines.push(`held: ${held.finding} stays ${held.severity} (mutant ${held.mutant}): ${held.reason}`);
  for (const up of view.followUps) lines.push(`follow-up ${up.state}: ${up.id} ${up.text}${up.remains === undefined ? "" : ` (remains: ${up.remains})`}`);
  if (view.gaps !== undefined) lines.push(gapsText(view.gaps));
  return lines;
}

/** One short line for the sidebar: the three counts, nothing when all are zero. */
export function paritySummary(view: ReviewParityView | undefined): string {
  if (view === undefined || parityIsEmpty(view)) return "";
  const parts: string[] = [];
  if (view.notRun > 0) parts.push(`Not run ${view.notRun}`);
  if (view.held.length > 0) parts.push(`held ${view.held.length}`);
  if (view.followUps.length > 0) parts.push(`follow-ups ${view.followUps.length}`);
  if (view.gaps !== undefined) parts.push(`gaps ${view.gaps.count}`);
  return parts.join(", ");
}

/** Markdown to paste into `report.md`. Empty string when there is nothing to carry. */
export function renderParityReport(view: ReviewParityView): string {
  if (parityIsEmpty(view)) return "";
  const lines = ["## Review parity", ""];
  if (view.notRun > 0) lines.push(`- **${notRunText(view)}.** They stay pending; a pass that runs them can still change a severity.`);
  for (const held of view.held) lines.push(`- **Held severity:** ${held.finding} stays ${held.severity}. ${held.kind === "covered" ? `${held.reason.charAt(0).toUpperCase()}${held.reason.slice(1)}.` : `Mutant ${held.mutant} survived but only changes presentation.`}`);
  for (const up of view.followUps) lines.push(`- **Not verified:** ${up.text} (${up.id}, ${up.state === "open" ? "open" : `narrowed, remains: ${up.remains ?? "not stated"}`})`);
  if (view.gaps !== undefined) lines.push(`- **${gapsText(view.gaps)}.**`);
  return `${lines.join("\n")}\n`;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A report line that opens with the marker (after a list or emphasis prefix), as `report-parity` writes it. */
const startsLine = (marker: string): RegExp => new RegExp(`^[ \\t>*_-]*${marker}`, "im");

/**
 * A warning, never a refusal, for each kind of leftover the report does not name. A category is named when the report
 * has a line that opens with its marker (`Not run`, `Held severity`, `Not verified`) or mentions one of its items by id:
 * a mutant id for a held note, an obligation id for a follow-up. A finding id would prove nothing, since the finding's
 * own block is in the report.
 */
export function parityWarnings(view: ReviewParityView, report: string): string[] {
  const warnings: string[] = [];
  const mentions = (id: string): boolean => id.length > 0 && new RegExp(`(?<![\\w.-])${escapeRegExp(id)}(?![\\w.-])`).test(report);
  if (view.notRun > 0 && !startsLine("Not run\\b").test(report)) {
    warnings.push(`${view.notRun} mutation candidate(s) were Not run and the report does not say so; paste \`keryx review report-parity <review>\` into report.md`);
  }
  if (view.held.length > 0 && !view.held.some((h) => mentions(h.mutant)) && !startsLine("Held severity").test(report)) {
    warnings.push(`${view.held.length} severity note(s) were held by a surviving mutant and the report names none; paste \`keryx review report-parity <review>\` into report.md`);
  }
  if (view.followUps.length > 0 && !view.followUps.some((f) => mentions(f.id)) && !startsLine("Not verified").test(report)) {
    warnings.push(`${view.followUps.length} follow-up(s) are not verified and the report names none; paste \`keryx review report-parity <review>\` into report.md`);
  }
  return warnings;
}

export async function packageParityWarnings(packageDir: string, report: string): Promise<string[]> {
  return parityWarnings(await readReviewParity(packageDir), report);
}
