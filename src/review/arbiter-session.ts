// The model the session runs on, remembered for the review arbiter.
//
// The arbiter runs one tier below the session's flagship, so it has to know the flagship. The shell builds its
// agent deps in a file the source audits keep narrow; the agent loop already holds the provider and model, so it
// reports them here at the start of every turn that can ask the operator a question (a turn with `ask_user`).

export interface ArbiterSession {
  readonly providerId: string;
  readonly modelId: string;
}

let session: ArbiterSession | undefined;

export function rememberArbiterSession(next: ArbiterSession | undefined): void {
  session = next;
}

export function arbiterSession(): ArbiterSession | undefined {
  return session;
}
