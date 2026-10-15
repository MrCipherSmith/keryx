/** Session-owner integration only: no archive deletion and no ACP capability. */
/** Shared ERL identifier: one bounded path component, never traversal. */
export function isSessionEvidenceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
}
export interface SessionEvidenceScope {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly sourceKind: "session-archive";
}
export interface SessionEvidenceOwnerOptions {
  /** Trusted runtime canonical scope, never tool/user input. */
  projectRoot: string;
  /**
   * Backend must durably persist the scoped tombstone and drain affected readers
   * before resolving. Rejection must leave retrieval fail-closed. This port is
   * not a substitute for the P1 ledger implementation or its race tests.
   */
  revokeAndDrain?: (scope: Readonly<SessionEvidenceScope>) => Promise<void>;
}
export type SessionEvidenceRevocationResult = {
  code: "revoked" | "unavailable" | "invalid-session";
};
export function createSessionEvidenceOwner(options: SessionEvidenceOwnerOptions) {
  const projectRoot = options.projectRoot, revokeAndDrain = options.revokeAndDrain;
  return Object.freeze({
    async revokeSessionEvidence(sessionId: string): Promise<SessionEvidenceRevocationResult> {
      if (!isSessionEvidenceId(sessionId)) return { code: "invalid-session" };
      if (!projectRoot || !revokeAndDrain) return { code: "unavailable" };
      try {
        await revokeAndDrain(Object.freeze({ projectRoot, sessionId, sourceKind: "session-archive" as const }));
        return { code: "revoked" };
      } catch {
        return { code: "unavailable" };
      }
    },
  });
}
