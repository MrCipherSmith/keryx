// Flow 392: the three operations on the journal — open, answer, reason.
//
// `open` is called BEFORE the question is shown: it decides blind or ordinary,
// writes the record (recommendation included), and returns what to display.
// `answer` records the choice and returns the reveal. Nothing here talks to a
// model, a TUI or a chat bridge; the caller asks the human.

import { randomBytes } from "node:crypto";
import { appendJournal, resolveFlowDir } from "../flow/store";
import { BLIND_PROBABILITY, isIrreversible, loadDecisionsConfig, shuffle } from "./blind";
import { appendRecord, readRecords } from "./store";
import { oneLine } from "./text";
import type {
  AnswerInput,
  AnswerRecord,
  AnswerResult,
  DecisionMode,
  OpenInput,
  OpenRecord,
  OpenResult,
  ReasonRecord,
} from "./types";

export const DEFAULT_STAGE = "unspecified";

function newId(now: Date): string {
  return `d-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function openDecision(input: OpenInput): Promise<OpenResult> {
  const now = (input.now ?? (() => new Date()))();
  const random = input.random ?? Math.random;
  const question = oneLine(input.question);
  if (question.length === 0) throw new Error("decisions open needs a question");
  if (input.options.length < 2) throw new Error("decisions open needs at least two options");
  const ids = new Set<string>();
  for (const option of input.options) {
    if (option.id.trim().length === 0) throw new Error("every option needs an id");
    if (ids.has(option.id)) throw new Error(`duplicate option id: ${option.id}`);
    ids.add(option.id);
  }
  const recommendation = input.recommendation ?? null;
  if (recommendation !== null && !ids.has(recommendation.optionId)) {
    throw new Error(`the recommended option "${recommendation.optionId}" is not one of the options`);
  }

  const config = await loadDecisionsConfig(input.cwd);
  const tagged = input.action !== undefined && input.action.trim().length > 0;
  // A caller that tags the action, or says so outright, has declared it irreversible; the text match is the safety net.
  const irreversible = input.irreversible === true || tagged || isIrreversible(config.irreversible, question, input.action, input.options);
  // Blind needs a recommendation to hide, and is never applied to an irreversible action (AC4).
  const wantsBlind = recommendation !== null && random() < BLIND_PROBABILITY;
  const mode: DecisionMode = wantsBlind && !irreversible ? "blind" : "ordinary";
  const given = input.options.map((option) => option.id);
  const order = mode === "blind" ? shuffle(given, random) : given;
  const showMark = mode === "ordinary" && recommendation !== null;

  const record: OpenRecord = {
    kind: "open",
    id: input.id ?? newId(now),
    at: now.toISOString(),
    flow: input.flow ?? null,
    ...(input.flow !== undefined && input.flowSource !== undefined ? { flowSource: input.flowSource } : {}),
    stage: input.stage !== undefined && input.stage.trim().length > 0 ? oneLine(input.stage) : DEFAULT_STAGE,
    question,
    options: input.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description !== undefined && option.description.length > 0 ? { description: option.description } : {}),
    })),
    recommendation: recommendation === null ? null : { optionId: recommendation.optionId, reason: oneLine(recommendation.reason) },
    mode,
    order,
    showMark,
    irreversible,
    ...(tagged ? { action: input.action?.trim() ?? "" } : {}),
    ...(wantsBlind && irreversible ? { blindRefused: true } : {}),
    ...(input.session !== undefined && input.session.length > 0 ? { session: input.session } : {}),
  };
  await appendRecord(input.cwd, record);
  return {
    id: record.id,
    mode,
    order,
    showMark,
    irreversible,
    blindRefused: wantsBlind && irreversible,
    flow: record.flow,
  };
}

export async function answerDecision(input: AnswerInput): Promise<AnswerResult> {
  const now = (input.now ?? (() => new Date()))();
  const records = await readRecords(input.cwd);
  const open = records.find((r): r is OpenRecord => r.kind === "open" && r.id === input.id);
  if (open === undefined) throw new Error(`no open decision with id ${input.id}`);
  const other = input.other === true;
  // a free-form answer is the human's own words: one line, capped, so it cannot forge a journal.md or report line
  const choice = other ? oneLine(input.choice) : input.choice.trim();
  if (choice.length === 0) throw new Error("decisions answer needs a choice");
  if (!other && !open.options.some((option) => option.id === choice)) {
    throw new Error(`"${choice}" is not one of the options of decision ${input.id}. Choose one of: ${open.options.map((option) => option.id).join(", ")}`);
  }

  const priorAnswers = records.filter((r): r is AnswerRecord => r.kind === "answer" && r.id === input.id);
  const prior = priorAnswers.length;
  const hasReason = records.some((r) => r.kind === "reason" && r.id === input.id);
  const recommendedId = open.recommendation?.optionId;
  // The reason is offered once per decision: an earlier deviation already offered it.
  const alreadyOffered = priorAnswers.some((r) => recommendedId !== undefined && r.choice !== recommendedId);
  const timeToAnswerMs = Math.max(0, now.getTime() - Date.parse(open.at));
  const record: AnswerRecord = {
    kind: "answer",
    id: input.id,
    at: now.toISOString(),
    seq: prior + 1,
    choice,
    timeToAnswerMs: Number.isFinite(timeToAnswerMs) ? timeToAnswerMs : 0,
    changed: prior > 0,
    ...(other ? { other: true } : {}),
  };
  await appendRecord(input.cwd, record);

  const recommendation = open.recommendation;
  const matched = recommendation === null ? null : recommendation.optionId === choice;
  const deviation = matched === false;
  await journalToFlow(input.cwd, open, record, matched);
  return {
    id: open.id,
    seq: record.seq,
    changed: record.changed,
    choice,
    mode: open.mode,
    recommendation,
    matched,
    deviation,
    timeToAnswerMs: record.timeToAnswerMs,
    askReason: deviation && !hasReason && !alreadyOffered,
    flow: open.flow,
  };
}

/**
 * Record the one optional reason for a deviation. An empty text is stored as
 * "no reason given" and still counts as the one ask. Returns false when the
 * human was already asked for this decision.
 */
export async function recordReason(
  cwd: string,
  id: string,
  text: string | undefined,
  now: () => Date = () => new Date(),
  options: { replace?: boolean } = {},
): Promise<boolean> {
  const records = await readRecords(cwd);
  if (!records.some((r) => r.kind === "open" && r.id === id)) throw new Error(`no open decision with id ${id}`);
  // `replace` is the human adding or changing the reason later (`/decisions reason <why>`): the latest record wins in the report.
  if (options.replace !== true && records.some((r) => r.kind === "reason" && r.id === id)) return false;
  const reason = text === undefined ? "" : oneLine(text);
  const record: ReasonRecord = { kind: "reason", id, at: now().toISOString(), ...(reason.length > 0 ? { reason } : {}) };
  await appendRecord(cwd, record);
  return true;
}

/**
 * Inside a flow, every answer also leaves one line in that flow's journal.md (AC9).
 * Never throws. A flow that was only inferred (the one flow in progress, named by
 * neither KERYX_FLOW nor the branch) is a guess: the record stays in the project-wide
 * journal with its `inferred` flag, and nothing is written into the flow's own file.
 */
async function journalToFlow(cwd: string, open: OpenRecord, answer: AnswerRecord, matched: boolean | null): Promise<void> {
  if (open.flow === null || open.flowSource === "inferred") return;
  try {
    const dir = await resolveFlowDir(cwd, open.flow);
    const verdict = matched === null ? "no recommendation" : matched ? "followed the recommendation" : `recommended ${open.recommendation?.optionId ?? "?"}`;
    const changed = answer.changed ? " (changed answer)" : "";
    await appendJournal(
      cwd,
      dir,
      answer.at,
      `decision ${open.id} [${oneLine(open.stage)}, ${open.mode}]: chose ${oneLine(answer.choice)}${changed}; ${oneLine(verdict)}`,
    );
  } catch {
    // the project-wide journal already has the record; a flow that cannot be found is not an error here
  }
}
