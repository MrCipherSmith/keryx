// Flow 400 (AC9): the interviewer's host rule as a contract the code can check.
//
// With a host that can show a question (the TUI composer dock, a chat bridge) the interviewer asks through
// `ask_user`, one question at a time, and the answers are certain because the user gave them. Without a host
// (a headless run, a subagent, the line shell) it asks NOTHING: a question in plain text would have nobody to
// answer it and would be recorded as if it had been. It returns NEEDS_CONTEXT with the assumptions it would
// have asked about, and the caller decides.
//
// The skill text (`planning/interviewer/SKILL.md`, "Host or no host") states the same rule; the test pins both.

import { CANCEL_ANSWER, type AskFn, type AskOption } from "./ask";

/** The most questions one interview asks, as in the skill. */
export const MAX_INTERVIEW_QUESTIONS = 8;

export interface InterviewQuestion {
  id: string;
  question: string;
  /** The A/B/C/D options, as `ask_user` takes them. */
  options: AskOption[];
  /** What the interviewer proceeds on when nobody can answer. Required: a question without one cannot be skipped safely. */
  assumption: string;
}

export interface InterviewAnswer {
  id: string;
  question: string;
  answer: string;
  /** The user said it. */
  confidence: "certain";
}

export interface InterviewAssumption {
  id: string;
  question: string;
  assumption: string;
  confidence: "assumption";
}

export type InterviewResult =
  | { status: "READY"; answers: InterviewAnswer[]; assumptions: []; asked: number }
  | { status: "NEEDS_CONTEXT"; answers: InterviewAnswer[]; assumptions: InterviewAssumption[]; asked: number };

/** The host the interviewer may ask through: `ask_user`'s own function, or nothing. */
export interface InterviewHost {
  askUser: AskFn;
}

/** The path a run takes: `ask_user` when a host is present, NEEDS_CONTEXT when it is not. */
export function interviewPath(host: InterviewHost | undefined): "ask_user" | "needs_context" {
  return host === undefined ? "needs_context" : "ask_user";
}

function assume(question: InterviewQuestion): InterviewAssumption {
  return { id: question.id, question: question.question, assumption: question.assumption, confidence: "assumption" };
}

/**
 * Run the interview. Host present: ask each question through `host.askUser`, in order and one at a time. A cancelled
 * question, a failing host, or a question past the limit becomes an assumption, never an answer. No host: no question is
 * asked and every question is returned as an assumption.
 */
export async function runInterview(questions: readonly InterviewQuestion[], host: InterviewHost | undefined): Promise<InterviewResult> {
  const answers: InterviewAnswer[] = [];
  const assumptions: InterviewAssumption[] = [];
  let asked = 0;
  let hostUsable = interviewPath(host) === "ask_user";
  for (const [index, question] of questions.entries()) {
    if (!hostUsable || host === undefined || index >= MAX_INTERVIEW_QUESTIONS) {
      assumptions.push(assume(question));
      continue;
    }
    asked += 1;
    let answer: string;
    try {
      answer = await host.askUser({ question: question.question, options: question.options, allowFreeform: true });
    } catch {
      answer = CANCEL_ANSWER;
    }
    if (answer === CANCEL_ANSWER || answer.trim().length === 0) {
      // nobody answered: the rest of the interview has no one to ask either
      hostUsable = false;
      assumptions.push(assume(question));
      continue;
    }
    answers.push({ id: question.id, question: question.question, answer, confidence: "certain" });
  }
  if (assumptions.length === 0) return { status: "READY", answers, assumptions: [], asked };
  return { status: "NEEDS_CONTEXT", answers, assumptions, asked };
}
