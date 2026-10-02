// Flow 392: what the human can do AFTER the answer, without the answer having
// waited for it: add the one optional reason for a deviation, and change the
// answer once the blind reveal has shown what was recommended. The TUI reaches
// these through `/decisions reason <why>` and `/decisions change <option>`; both
// default to the latest answered decision, or to the id the caller names.

import { answerDecision, recordReason } from "./journal";
import { readRecords } from "./store";
import type { AnswerRecord, AnswerResult, OpenRecord } from "./types";

/** The id of the latest decision that has an answer on record. */
export async function latestAnsweredDecision(cwd: string): Promise<string | undefined> {
  const records = await readRecords(cwd);
  const answered = new Set(records.filter((r) => r.kind === "answer").map((r) => r.id));
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record !== undefined && record.kind === "open" && answered.has(record.id)) return record.id;
  }
  return undefined;
}

async function resolveOpen(cwd: string, id: string | undefined, lastId: string | undefined): Promise<OpenRecord> {
  const wanted = id ?? lastId ?? (await latestAnsweredDecision(cwd));
  if (wanted === undefined) throw new Error("no answered decision to act on yet");
  const open = (await readRecords(cwd)).find((r): r is OpenRecord => r.kind === "open" && r.id === wanted);
  if (open === undefined) throw new Error(`no decision with id ${wanted}`);
  return open;
}

export interface GiveReasonResult {
  id: string;
  /** False when a reason was already on record: the human is asked once, and that was it. */
  recorded: boolean;
}

/** Add the one optional reason for a deviation. Only a deviation takes one. */
export async function giveReason(input: { cwd: string; text: string; id?: string | undefined; lastId?: string | undefined; now?: (() => Date) | undefined }): Promise<GiveReasonResult> {
  const text = input.text.trim();
  if (text.length === 0) throw new Error("a reason needs some text: /decisions reason <why>");
  const open = await resolveOpen(input.cwd, input.id, input.lastId);
  const answers = (await readRecords(input.cwd)).filter((r): r is AnswerRecord => r.kind === "answer" && r.id === open.id);
  const first = [...answers].sort((x, y) => x.seq - y.seq)[0];
  if (first === undefined) throw new Error(`decision ${open.id} has no answer yet`);
  if (open.recommendation === null || first.choice === open.recommendation.optionId) {
    throw new Error(`decision ${open.id}: the recommendation was followed; there is no deviation to explain`);
  }
  return { id: open.id, recorded: await recordReason(input.cwd, open.id, text, input.now) };
}

/** An option id, or a label (case-insensitive), as the human typed it. */
export function resolveOptionId(open: OpenRecord, typed: string): string {
  const wanted = typed.trim();
  const byId = open.options.find((option) => option.id === wanted);
  if (byId !== undefined) return byId.id;
  const byLabel = open.options.filter((option) => option.label.trim().toLowerCase() === wanted.toLowerCase());
  if (byLabel.length === 1 && byLabel[0] !== undefined) return byLabel[0].id;
  const choices = open.options.map((option) => (option.label === option.id ? option.id : `${option.id} (${option.label})`)).join(", ");
  throw new Error(`"${wanted}" is not one of the options of decision ${open.id}: ${choices}`);
}

/** Record a changed answer: both answers stay on record, the report counts the first for the match share. */
export async function changeAnswer(input: { cwd: string; choice: string; id?: string | undefined; lastId?: string | undefined; now?: (() => Date) | undefined }): Promise<AnswerResult> {
  const open = await resolveOpen(input.cwd, input.id, input.lastId);
  return answerDecision({ cwd: input.cwd, id: open.id, choice: resolveOptionId(open, input.choice), now: input.now });
}
