// Dependency-free on purpose: the local shells import this on every start, and `plan.ts` pulls in the generated protocol validators.
/** The shipped local clients and native host share this exact readonly state operation. Authority and idle admission belong to their host. */
export function executePlanCommand(input: string, state: { current: boolean; commit(enabled: boolean): void }): { ok: true; enabled: boolean } | { ok: false } {
  if (input === "") return { ok: true, enabled: state.current };
  if (input !== "on" && input !== "off") return { ok: false };
  const enabled = input === "on"; state.commit(enabled); return { ok: true, enabled };
}
