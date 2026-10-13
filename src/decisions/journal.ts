// Flow 392: the three operations on the journal — open, answer, reason.
//
// `open` is called BEFORE the question is shown: it assigns the arm (A to D),
// writes the record (recommendation included), and returns what to display.
// `answer` records the choice and returns the reveal. Nothing here talks to a
// model, a TUI or a chat bridge; the caller asks the human.

import { createHash, randomBytes } from "node:crypto";
import { appendJournal, resolveFlowDir } from "../flow/store";
import { ARM_FACTORS, armOfMode, chooseArm, loadArmWeights, loadRepoSalt, modeOfArm, REASON_SUBSAMPLE_ENV, reasonSubsample, reasonSubsampleOff, recordEligible } from "./arms";
import { isIrreversible, loadDecisionsConfig, shuffle } from "./blind";
import { appendRecord, readRecords, withJournalLock } from "./store";
import { MAX_OPERATOR_TEXT_LENGTH, oneLine, storedOperatorText } from "./text";
import type {
  AnswerInput,
  AnswerRecord,
  AnswerResult,
  DecisionRecord,
  OpenInput,
  OpenRecord,
  OpenResult,
  ReasonRecord,
} from "./types";

export const DEFAULT_STAGE = "unspecified";
export const DEFAULT_CHANNEL = "tui";

function newId(now: Date): string {
  return `d-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** What makes two questions the same question: the normalised text and the set of option ids, hashed. */
function questionHash(question: string, optionIds: readonly string[]): string {
  const text = oneLine(question).toLowerCase();
  return createHash("sha256").update(JSON.stringify([text, [...optionIds].sort()])).digest("hex");
}

function resultOf(record: OpenRecord): OpenResult {
  return {
    id: record.id,
    mode: record.mode,
    arm: record.arm ?? armOfMode(record.mode),
    seed: record.seed ?? 0,
    preselected: record.preselected ?? false,
    forced: record.forced ?? false,
    eligible: recordEligible(record),
    reasonRequested: record.reasonRequested === true,
    channel: record.channel ?? DEFAULT_CHANNEL,
    order: record.order,
    showMark: record.showMark ?? record.mode === "ordinary",
    irreversible: record.irreversible ?? false,
    blindRefused: record.blindRefused ?? false,
    flow: record.flow,
  };
}

/** An unanswered open older than this is abandoned, not the question now being asked again. */
export const OPEN_TWIN_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The still-unanswered open record of this repository that asks the same question, from the same session and
 * not older than `OPEN_TWIN_MAX_AGE_MS`, if any (one scan of the journal). A stale or foreign open is never
 * reused: it would hand the new question an old arm and an old `open.at`, which skews time to answer.
 */
function findOpenTwin(records: readonly DecisionRecord[], hash: string, session: string | undefined, now: Date): OpenRecord | undefined {
  const answered = new Set<string>();
  for (const r of records) if (r.kind === "answer") answered.add(r.id);
  for (const r of records) {
    if (r.kind !== "open" || r.backfilled === true || answered.has(r.id)) continue;
    if ((r.session ?? undefined) !== (session !== undefined && session.length > 0 ? session : undefined)) continue;
    const age = now.getTime() - Date.parse(r.at);
    if (!Number.isFinite(age) || age > OPEN_TWIN_MAX_AGE_MS) continue;
    if (questionHash(r.question, r.options.map((option) => option.id)) === hash) return r;
  }
  return undefined;
}

export { REASON_SUBSAMPLE_ENV };

export async function openDecision(input: OpenInput): Promise<OpenResult> {
  const now = (input.now ?? (() => new Date()))();
  const random = input.random ?? Math.random; // the shuffle only: the arm is seeded
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

  // The twin lookup, the seq and the append are one read-then-append: under the journal lock, so two concurrent
  // opens neither share a seq (and with it an arm) nor both miss each other's twin.
  return withJournalLock(input.cwd, () => openLocked(input, now, random, question, ids, recommendation));
}

async function openLocked(
  input: OpenInput,
  now: Date,
  random: () => number,
  question: string,
  ids: ReadonlySet<string>,
  recommendation: NonNullable<OpenInput["recommendation"]> | null,
): Promise<OpenResult> {
  // Idempotent per question: asking the same question again while it is still unanswered returns the arm already
  // drawn for it, so repeating `open` cannot re-roll the arm. Once it is answered, the next open is a new decision.
  const records = await readRecords(input.cwd);
  const twin = findOpenTwin(records, questionHash(question, [...ids]), input.session, now);
  if (twin !== undefined) return resultOf(twin);

  const config = await loadDecisionsConfig(input.cwd);
  const tagged = input.action !== undefined && input.action.trim().length > 0;
  // A caller that tags the action, or says so outright, has declared it irreversible; the text match is the safety net.
  const irreversible = input.irreversible === true || tagged || isIrreversible(config.irreversible, question, input.action, input.options);
  // The arm is a pure function of (repoSalt, seq), so a repeated run assigns it the same way. An irreversible
  // question is always arm A with forced: true, and never blind (AC4).
  const salt = input.salt ?? (await loadRepoSalt(input.cwd));
  const seq = input.seq ?? records.filter((r) => r.kind === "open").length + 1;
  const choice = chooseArm({
    salt,
    seq,
    weights: await loadArmWeights(input.cwd),
    irreversible,
    hasRecommendation: recommendation !== null,
    force: input.arm,
  });
  const factors = ARM_FACTORS[choice.arm];
  const mode = modeOfArm(choice.arm);
  const given = input.options.map((option) => option.id);
  const order = factors.order === "shuffled" ? shuffle(given, random) : given;
  const showMark = factors.mark === "shown" && recommendation !== null;
  const preselected = factors.preselect && recommendation !== null;
  const channel = input.channel !== undefined && input.channel.trim().length > 0 ? oneLine(input.channel) : DEFAULT_CHANNEL;
  const blindRefused = recommendation !== null && irreversible && choice.drawn === "D";
  // AC20: eligible is the exact complement of forced. AC17: the reason subsample is a deterministic hash of (seed, seq),
  // decided here, before the question is shown; a surface that cannot take free text (reasonPrompt false) is left out.
  const eligible = !choice.forced;
  const reasonRequested = eligible && input.reasonPrompt !== false && !reasonSubsampleOff() && reasonSubsample(choice.seed, seq);

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
    arm: choice.arm,
    seed: choice.seed,
    seq,
    preselected,
    forced: choice.forced,
    eligible,
    reasonRequested,
    reasonPrompt: input.reasonPrompt !== false,
    channel,
    order,
    showMark,
    irreversible,
    ...(tagged ? { action: input.action?.trim() ?? "" } : {}),
    ...(blindRefused ? { blindRefused: true } : {}),
    ...(input.source !== undefined && input.source.trim().length > 0 ? { source: oneLine(input.source) } : {}),
    ...(input.session !== undefined && input.session.length > 0 ? { session: input.session } : {}),
  };
  await appendRecord(input.cwd, record);
  return {
    id: record.id,
    mode,
    arm: choice.arm,
    seed: choice.seed,
    preselected,
    forced: choice.forced,
    eligible,
    reasonRequested,
    channel,
    order,
    showMark,
    irreversible,
    blindRefused,
    flow: record.flow,
  };
}

export async function answerDecision(input: AnswerInput): Promise<AnswerResult> {
  const now = (input.now ?? (() => new Date()))();
  const records = await readRecords(input.cwd);
  const open = records.find((r): r is OpenRecord => r.kind === "open" && r.id === input.id);
  if (open === undefined) throw new Error(`no open decision with id ${input.id}`);
  if (open.backfilled === true) throw new Error(`decision ${open.id} is a backfilled historical record; its answer is not changed`);
  const other = input.other === true;
  // a free-form answer is the human's own words: redacted and one line, so it cannot forge a journal.md or report line or
  // carry a secret into one. `text` keeps it in full (flow 401); `choice` is the short display form of the same text (300 characters).
  const text = other ? storedOperatorText(input.choice) : undefined;
  const choice = text !== undefined ? oneLine(text) : input.choice.trim();
  if (choice.length === 0) throw new Error("decisions answer needs a choice");
  if (!other && !open.options.some((option) => option.id === choice)) {
    throw new Error(`"${choice}" is not one of the options of decision ${input.id}. Choose one of: ${open.options.map((option) => option.id).join(", ")}`);
  }

  const priorAnswers = records.filter((r): r is AnswerRecord => r.kind === "answer" && r.id === input.id);
  const prior = priorAnswers.length;
  const hasReason = records.some((r) => r.kind === "reason" && r.id === input.id);
  const recommendedId = open.recommendation?.optionId;
  // The reason is offered once per decision: an earlier deviation already offered it.
  const alreadyOffered = priorAnswers.some((r) => (recommendedId !== undefined && r.choice !== recommendedId) || (open.reasonRequested === true && prior > 0));
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
    ...(text !== undefined && text.length > 0 ? { text } : {}),
  };
  await appendRecord(input.cwd, record);

  const recommendation = open.recommendation;
  // an own answer is never "the recommended option", even when its words equal that option's id
  const matched = recommendation === null ? null : !other && recommendation.optionId === choice;
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
    askReason: (deviation || open.reasonRequested === true) && !hasReason && !alreadyOffered,
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
  const open = records.find((r): r is OpenRecord => r.kind === "open" && r.id === id);
  if (open === undefined) throw new Error(`no open decision with id ${id}`);
  if (open.backfilled === true) throw new Error(`decision ${id} is a backfilled historical record; its reason is not changed`);
  // `replace` is the human adding or changing the reason later (`/decisions reason <why>`): the latest record wins in the report.
  if (options.replace !== true && records.some((r) => r.kind === "reason" && r.id === id)) return false;
  // flow 401: redacted, one line, kept in full up to 2000 characters (a visible marker when cut)
  const reason = text === undefined ? "" : storedOperatorText(text);
  const record: ReasonRecord = { kind: "reason", id, at: now().toISOString(), ...(reason.length > 0 ? { reason } : {}) };
  await appendRecord(cwd, record);
  if (reason.length > 0) await journalReasonToFlow(cwd, open, record.at, reason);
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
    const changed = `${answer.changed ? " (changed answer)" : ""}${answer.other === true ? " (own answer)" : ""}`;
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

/**
 * Flow 401: a reason is one line in the flow's journal.md too, with the question id, so the flow's
 * own file says why the operator chose what they chose. Same rules as `journalToFlow`: never
 * throws, and an inferred flow is a guess that stays out of the flow's file.
 */
async function journalReasonToFlow(cwd: string, open: OpenRecord, at: string, reason: string): Promise<void> {
  if (open.flow === null || open.flowSource === "inferred") return;
  try {
    const dir = await resolveFlowDir(cwd, open.flow);
    await appendJournal(cwd, dir, at, `decision ${open.id} [${oneLine(open.stage)}] reason: ${oneLine(reason, MAX_OPERATOR_TEXT_LENGTH + 80)}`);
  } catch {
    // the project-wide journal already has the record
  }
}
