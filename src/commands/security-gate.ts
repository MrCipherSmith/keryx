/**
 * Whether a `SecurityGate` value is the one a strict mode accepts.
 * Exhaustive, with the default arm on the blocking side: a future
 * `SecurityGate` member — or, defensively, a runtime value the type checker
 * would never let a caller construct directly — is refused rather than
 * falling through to a pass. Mirrors `runGate`'s switch
 * (`src/security/service.ts:311-330`) and `securityFlowGate`'s
 * (`src/security/guard.ts:362-371`), which already treat `enforced` and `ci`
 * as the same blocking pair (`isBlockingMode`); this file's two folds
 * (`exitCodeFor`, `reportExitCode`) had not, until T35 F-002.
 */
export function isPassGate(gate: string): boolean {
  switch (gate) {
    case "pass":
      return true;
    case "fail":
    case "needs-approval":
    case "incomplete":
      return false;
    default:
      return false;
  }
}
