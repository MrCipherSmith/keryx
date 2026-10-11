// What an autonomous review run answers when the model asks a question and nobody is there.
//
// An irreversible question is refused before anything else, an arbiter included. Then an arbiter, when
// one is registered (flow 425 plugs in here); otherwise the safe default: the recommended option, else
// the first. A question with nothing to choose from is refused. Every answer is appended to a journal file the runner and the TUI read.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CANCEL_ANSWER } from "../decisions/service";
import type { AskUserRequest } from "../harness/tool/builtin/ask-user-tool";

/** Set by the runner on the child shell; its presence turns the autonomous answer path on. */
export const ENV_AUTONOMOUS_ANSWERS_FILE = "KERYX_AUTONOMOUS_ANSWERS_FILE";

export function autonomousAnswersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const file = env[ENV_AUTONOMOUS_ANSWERS_FILE];
  return file !== undefined && file.length > 0;
}

export type AutoAnswerBasis =
  | "recommended"
  | "first"
  | "refused-irreversible"
  | "refused-no-option"
  | "arbiter"
  | "arbiter-deny"
  | "arbiter-escalate";

export interface AutoAnswerRecord {
  readonly at: string;
  readonly question: string;
  readonly answer: string;
  readonly basis: AutoAnswerBasis;
  readonly rule?: string;
}

export interface ArbiterVerdict {
  readonly verdict: "allow" | "deny" | "escalate";
  /** The option id to answer with; only read for `allow`. */
  readonly answer?: string;
  readonly rule: string;
}

export type QuestionArbiter = (request: AskUserRequest) => Promise<ArbiterVerdict | undefined>;

let arbiter: QuestionArbiter | undefined;

/** The hook point of the arbiter. `undefined` removes it. */
export function setQuestionArbiter(fn: QuestionArbiter | undefined): void {
  arbiter = fn;
}

export interface AnswerOptions {
  readonly file: string;
  readonly now?: () => Date;
}

function record(file: string, entry: AutoAnswerRecord): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // the journal is an observation; losing it must not stop the run
  }
}

export async function answerAutonomously(request: AskUserRequest, options: AnswerOptions): Promise<string> {
  const at = (options.now?.() ?? new Date()).toISOString();
  const finish = (answer: string, basis: AutoAnswerBasis, rule?: string): string => {
    record(options.file, { at, question: request.question, answer, basis, ...(rule === undefined ? {} : { rule }) });
    return answer;
  };

  if (request.irreversible === true) return finish(CANCEL_ANSWER, "refused-irreversible");

  if (arbiter !== undefined) {
    let verdict: ArbiterVerdict | undefined;
    try {
      verdict = await arbiter(request);
    } catch {
      verdict = undefined;
    }
    if (verdict !== undefined) {
      if (verdict.verdict === "deny") return finish(CANCEL_ANSWER, "arbiter-deny", verdict.rule);
      if (verdict.verdict === "escalate") return finish(CANCEL_ANSWER, "arbiter-escalate", verdict.rule);
      if (verdict.answer !== undefined && request.options.some((o) => o.id === verdict.answer)) {
        return finish(verdict.answer, "arbiter", verdict.rule);
      }
    }
  }

  const recommended = request.options.find((o) => o.recommended === true);
  if (recommended !== undefined) return finish(recommended.id, "recommended");
  const first = request.options[0];
  if (first !== undefined) return finish(first.id, "first");
  return finish(CANCEL_ANSWER, "refused-no-option");
}

export function readAutoAnswers(file: string): AutoAnswerRecord[] {
  if (!existsSync(file)) return [];
  const records: AutoAnswerRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as AutoAnswerRecord);
    } catch {
      // a torn last line of a killed run
    }
  }
  return records;
}
