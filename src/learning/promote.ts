// `keryx learn promote` (W3 spec "Promotion rule"; plan module table). STUB —
// T10 fills this in. Exported now, with its final signature, so
// `commands/learn.ts` (T8) can wire the TTY/confirmation gate against it
// without a second signature change.
//
// T10's job: a `scope: "project"`, `status: "accepted"` record is eligible
// when `~/.keryx/learning/index.json` has entries for the same `id` from
// `>=2` distinct `project.identity` values, each at (indexed, accept-time)
// `confidence >= 0.8`. Requires interactive confirmation (no bypass flag —
// same D2 rule `accept.ts` already enforces) and, on confirmation, writes a
// new `scope: "user"`, `status: "candidate"` record under
// `~/.keryx/learning/patterns/` — never `"accepted"`; promotion re-enters
// Review/Consent at the new scope.
export class LearningPromoteError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningPromoteError";
  }
}

export interface PromotePatternOptions {
  /** No bypass flag exists for this command (W3 spec "Promotion rule" #2) — refuses outright without a terminal. */
  isTerminal: boolean;
  /** Typed confirmation (e.g. "type the pattern id to confirm"), read by the CLI layer. */
  confirm: () => Promise<boolean>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * NOT IMPLEMENTED (T10). Always throws `LearningPromoteError` with reason
 * `"not-implemented"`.
 */
export async function promotePattern(root: string, id: string, opts: PromotePatternOptions): Promise<never> {
  void root;
  void id;
  void opts;
  throw new LearningPromoteError("not-implemented", "promotePattern is not implemented yet (flow 312, T10)");
}
