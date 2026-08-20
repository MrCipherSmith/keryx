// Pure audit-log line formatting (spec.md §2.5, AC6). "Every mutating
// extension action produces exactly one audit-log line in the output
// channel" — the ONE-line-per-action invariant is enforced by shape here
// (a single `formatAuditLine` call per action at the `vscode`-calling call
// site), and is unit-testable without any `vscode` import: the function is
// total and pure, so a caller either invokes it once per action or the test
// suite covering `extension.ts`'s wiring would need to assert call counts —
// this module only owns the LINE SHAPE, not the call-site discipline.

export type AuditActor = "user" | "extension";

export interface AuditEvent {
  readonly timestamp: string; // ISO 8601
  readonly actor: AuditActor;
  readonly action: string;
  readonly outcome: "success" | "failure";
  readonly detail?: string;
}

/** Render one structured audit-log line, minimum fields per spec.md §2.5. */
export function formatAuditLine(event: AuditEvent): string {
  const base = `[${event.timestamp}] actor=${event.actor} action=${event.action} outcome=${event.outcome}`;
  return event.detail ? `${base} detail=${event.detail}` : base;
}
