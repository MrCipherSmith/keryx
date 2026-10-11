// Where the arbiter meets the shell: one arbiter per working directory, and the two places a question reaches it.
//
//   - an autonomous run (`KERYX_AUTONOMOUS_ANSWERS_FILE`): `answerAutonomously` consults the hook installed here;
//   - `review-auto` (an interactive shell that answers its own review menus): `consultArbiter`, called from the
//     `ask_user` bridge, replaces the word heuristic for a question that carries a policy tag.
//
// `ask` mode never comes through here: the operator is asked, as before.

import type { AskUserRequest } from "../harness/tool/builtin/ask-user-tool";
import { setQuestionArbiter } from "./autonomous-answers";
import { asQuestionArbiter, createArbiter, type Arbiter, type ArbiterDeps } from "./arbiter";
import { readArbiterConfig } from "./arbiter-config";

let current: { readonly cwd: string; readonly arbiter: Arbiter } | undefined;

/** Test seam and production entry: builds the arbiter for `cwd` (or takes `deps`) and remembers it. */
export function installArbiter(cwd: string, deps: Partial<ArbiterDeps> = {}): Arbiter {
  const arbiter = createArbiter({ cwd, ...deps });
  current = { cwd, arbiter };
  return arbiter;
}

export function resetArbiter(): void {
  current = undefined;
  setQuestionArbiter(undefined);
}

/** The arbiter for `cwd`, or `undefined` when the project turned it off (`review.arbiter.enabled: false`). */
export function arbiterFor(cwd: string): Arbiter | undefined {
  if (current !== undefined && current.cwd === cwd) return current.arbiter;
  if (!readArbiterConfig(cwd).enabled) return undefined;
  return installArbiter(cwd);
}

/** Registers the arbiter as the autonomous run's hook. Returns whether one is in place. */
export function installQuestionArbiter(cwd: string): boolean {
  const arbiter = arbiterFor(cwd);
  if (arbiter === undefined) {
    setQuestionArbiter(undefined);
    return false;
  }
  setQuestionArbiter(asQuestionArbiter(arbiter));
  return true;
}

export type ArbiterOutcome =
  /** Not for the arbiter: the caller keeps its old behaviour. */
  | { readonly kind: "none" }
  /** The arbiter allowed the recommended option. */
  | { readonly kind: "answer"; readonly answer: string; readonly rule: string }
  /** The arbiter denied or escalated, or could not decide: the operator answers. */
  | { readonly kind: "human"; readonly notice: string };

/** What a `review-auto` shell does with a question: ask the arbiter when the question carries a policy tag. */
export async function consultArbiter(cwd: string, request: AskUserRequest): Promise<ArbiterOutcome> {
  if (request.policy === undefined) return { kind: "none" };
  const arbiter = arbiterFor(cwd);
  if (arbiter === undefined) return { kind: "none" };
  let decision: Awaited<ReturnType<Arbiter["decide"]>>;
  try {
    decision = await arbiter.decide(request);
  } catch {
    return { kind: "human", notice: "review-auto: the arbiter failed on this question, so it is yours to answer" };
  }
  if (decision === undefined) return { kind: "none" };
  if (decision.verdict === "allow" && decision.answer !== undefined && request.options.some((option) => option.id === decision.answer)) {
    return { kind: "answer", answer: decision.answer, rule: decision.rule };
  }
  const why = decision.rule === "none" ? decision.reason : `rule ${decision.rule}`;
  return { kind: "human", notice: `review-auto: the arbiter said ${decision.verdict} (${why}), so this question is yours to answer` };
}
