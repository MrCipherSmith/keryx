// Flow 392: what the human can do AFTER the answer, without the answer having
// waited for it: add the one optional reason for a deviation, and change the
// answer once the blind reveal has shown what was recommended. The TUI reaches
// these through `/decisions reason <why>` and `/decisions change <option>`; both
// default to the latest answered decision, or to the id the caller names.

import { answerDecision, recordReason } from "./journal";
import { readRecords } from "./store";
import { oneLine } from "./text";
import type { AnswerRecord, AnswerResult, OpenRecord } from "./types";

/** The id of the latest decision that has an answer on record, optionally only one that belongs to `flow`. */
export async function latestAnsweredDecision(cwd: string, flow?: string): Promise<string | undefined> {
  const records = await readRecords(cwd);
  const answered = new Set(records.filter((r) => r.kind === "answer").map((r) => r.id));
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record !== undefined && record.kind === "open" && answered.has(record.id) && (flow === undefined || record.flow === flow)) return record.id;
  }
  return undefined;
}

/**
 * The decision a follow-up acts on. With an id, that decision: the human named it.
 * Without one it must be a decision of THIS session: the latest one answered here
 * (`lastId`), else the latest one of this flow, and in either case only if its open
 * record carries this session's id. A decision of another session, found through
 * the flow, is named in the refusal and left alone: with several agents and
 * sessions writing one journal, a bare `/decisions change` must not rewrite
 * somebody else's answer.
 */
async function resolveOpen(
  cwd: string,
  id: string | undefined,
  lastId: string | undefined,
  flow: string | undefined,
  session: string | undefined,
  command: string,
): Promise<OpenRecord> {
  const records = await readRecords(cwd);
  const find = (wanted: string): OpenRecord | undefined => records.find((r): r is OpenRecord => r.kind === "open" && r.id === wanted);
  if (id !== undefined) {
    const named = find(id);
    if (named === undefined) throw new Error(`no decision with id ${id}`);
    return named;
  }
  let wanted = lastId;
  if (wanted === undefined && flow !== undefined) wanted = await latestAnsweredDecision(cwd, flow);
  if (wanted === undefined) throw new Error("no decision from this session to act on; nothing was changed");
  const open = find(wanted);
  if (open === undefined) throw new Error(`no decision with id ${wanted}`);
  // The caller's own `lastId` is this session's by construction; when the session is also known it is checked anyway.
  // A decision found through the flow is only ever acted on when it carries this session's id.
  const foreign = session !== undefined ? open.session !== session : wanted !== lastId;
  if (foreign) {
    const shown = oneLine(open.question, 60);
    throw new Error(
      `the latest decision I can find, ${open.id} ("${shown}"), was not asked in this session, so nothing was changed. ` +
        `To act on it on purpose: ${command.replace("<id>", open.id)}`,
    );
  }
  return open;
}

export interface GiveReasonResult {
  id: string;
  question: string;
  /** False when a reason was already on record: the human is asked once, and that was it. */
  recorded: boolean;
}

/** Add the one optional reason for a deviation. Only a deviation takes one. */
export async function giveReason(input: { cwd: string; text: string; id?: string | undefined; lastId?: string | undefined; flow?: string | undefined; session?: string | undefined; now?: (() => Date) | undefined }): Promise<GiveReasonResult> {
  const text = input.text.trim();
  if (text.length === 0) throw new Error("a reason needs some text: /decisions reason <why>");
  const open = await resolveOpen(input.cwd, input.id, input.lastId, input.flow, input.session, 'keryx decisions reason <id> --text "<why>"');
  const answers = (await readRecords(input.cwd)).filter((r): r is AnswerRecord => r.kind === "answer" && r.id === open.id);
  const first = [...answers].sort((x, y) => x.seq - y.seq)[0];
  if (first === undefined) throw new Error(`decision ${open.id} has no answer yet`);
  if (open.recommendation === null || first.choice === open.recommendation.optionId) {
    throw new Error(`decision ${open.id}: the recommendation was followed; there is no deviation to explain`);
  }
  return { id: open.id, question: open.question, recorded: await recordReason(input.cwd, open.id, text, input.now) };
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

export interface ChangeAnswerResult extends AnswerResult {
  question: string;
  /** The answer the agent already received. */
  previous: string;
}

/**
 * Record a changed answer: both answers stay on record, the report counts the
 * first for the match share. The agent got the first answer when the question was
 * answered; the change is a record for the journal and may not reach it.
 */
export async function changeAnswer(input: { cwd: string; choice: string; id?: string | undefined; lastId?: string | undefined; flow?: string | undefined; session?: string | undefined; now?: (() => Date) | undefined }): Promise<ChangeAnswerResult> {
  const open = await resolveOpen(input.cwd, input.id, input.lastId, input.flow, input.session, "keryx decisions answer <id> --choice <option>");
  const choice = resolveOptionId(open, input.choice);
  const answers = (await readRecords(input.cwd)).filter((r): r is AnswerRecord => r.kind === "answer" && r.id === open.id);
  const first = [...answers].sort((x, y) => x.seq - y.seq)[0];
  const result = await answerDecision({ cwd: input.cwd, id: open.id, choice, now: input.now });
  return { ...result, question: open.question, previous: first?.choice ?? "" };
}
