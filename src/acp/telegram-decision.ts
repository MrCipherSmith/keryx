/** A single decision shared by projections of one pending ACP operation. */
export type DecisionOutcome<T> =
  | { kind: "answered"; source: "desktop" | "telegram"; value: T }
  | { kind: "expired" | "cancelled" };

/**
 * The caller supplies its trusted operation/generation check and answer validator.
 * Neither a caller-controlled eligibility flag nor a malformed answer can settle it.
 */
export class ProjectedDecision<T> {
  readonly result: Promise<DecisionOutcome<T>>;
  private resolve!: (outcome: DecisionOutcome<T>) => void;
  private settled = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    deadline: number;
    current: (source: "desktop" | "telegram") => boolean;
    validate: (value: unknown) => value is T;
    onSettled: (outcome: DecisionOutcome<T>) => void;
    now?: () => number;
  }) {
    this.result = new Promise((resolve) => { this.resolve = resolve; });
    this.timer = setTimeout(() => this.finish({ kind: "expired" }), Math.max(0, options.deadline - this.now()));
  }

  claim(source: "desktop" | "telegram", value: unknown): boolean {
    if (this.settled) return false;
    if (this.now() >= this.options.deadline) {
      this.finish({ kind: "expired" });
      return false;
    }
    if (!this.options.current(source) || !this.options.validate(value)) return false;
    this.finish({ kind: "answered", source, value });
    return true;
  }

  cancel(): void { this.finish({ kind: "cancelled" }); }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private finish(outcome: DecisionOutcome<T>): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    try { this.options.onSettled(outcome); } catch { /* A failed projection close cannot unsettle the decision. */ }
    this.resolve(outcome);
  }
}
