// `keryx learn graduate` / `keryx learn graduate apply` (W3 spec "Graduation
// to skills/agents/rules"; plan module table). STUB — T10 fills this in.
// Exported now, with its final signatures, so `commands/learn.ts` (T8) can
// wire the TTY/confirmation gate for `graduate apply` against it without a
// second signature change.
//
// T10's job:
//  - `runGraduate` clusters `status: "accepted"` records (project or user
//    scope) by `domain` plus trigger-keyword overlap (Jaccard >= 0.5, >= 2
//    shared keywords) and writes a proposal artifact under
//    `.metaproject/data/learning/graduation/<proposal-id>.json`, setting
//    `graduation` on every source record — never a `SKILL.md`, agent
//    definition, or rule file itself.
//  - `applyGraduation` applies one proposal: for an `agent` target, writes
//    `.metaproject/agents/<name>.md` (`origin.kind: "learned"`, `sourceRef`
//    the source pattern id); for a `skill` target, prints the
//    `keryx skills scout --record <dir> --origin learned --source-ref <id>`
//    invocation for a human to run (W1 owns that write, not this function).
import type { LearningDomain } from "./types";

export class LearningGraduateError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningGraduateError";
  }
}

export interface RunGraduateOptions {
  domain?: LearningDomain;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ApplyGraduationOptions {
  /** Same "no bypass flag" rule `promote.ts` and `accept.ts` enforce. */
  isTerminal: boolean;
  /** Typed confirmation (e.g. "type the proposal id to confirm"), read by the CLI layer. */
  confirm: () => Promise<boolean>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * NOT IMPLEMENTED (T10). Always throws `LearningGraduateError` with reason
 * `"not-implemented"`.
 */
export async function runGraduate(root: string, opts: RunGraduateOptions = {}): Promise<never> {
  void root;
  void opts;
  throw new LearningGraduateError("not-implemented", "runGraduate is not implemented yet (flow 312, T10)");
}

/**
 * NOT IMPLEMENTED (T10). Always throws `LearningGraduateError` with reason
 * `"not-implemented"`.
 */
export async function applyGraduation(root: string, proposalId: string, opts: ApplyGraduationOptions): Promise<never> {
  void root;
  void proposalId;
  void opts;
  throw new LearningGraduateError("not-implemented", "applyGraduation is not implemented yet (flow 312, T10)");
}
