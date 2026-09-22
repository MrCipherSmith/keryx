// Flow 289 — owner and signed completion.
//
// Mirrors `src/forgetting/journal.ts`'s `Attribution`/`resolveRequestedBy`
// shape and doctrine on purpose (same "never promote a weak source" rule),
// but is defined locally to `src/flow/` rather than imported from
// `src/forgetting/`: the two modules solve unrelated problems (who requested
// a deletion vs. who signed a flow event) and importing across them would
// create a dependency edge that has no other reason to exist. Keep the
// SHAPE identical, not the import.
//
// `IdentityBasis`/`Identity` are the honesty contract this whole feature
// rests on: keryx can observe a CLI flag, an environment variable, or a
// local git config value, and none of those are proof that a human is
// behind them — an agent can set any of the three on itself. `basis` records
// how the value was obtained rather than asserting it is trustworthy, and
// `source` names exactly where it came from so a reader never has to guess.

export type IdentityBasis = "stated" | "derived" | "unknown";

export type Identity = {
  /** Null exactly when `basis` is "unknown". */
  value: string | null;
  basis: IdentityBasis;
  /** Where the value came from, or why there is none. Always populated. */
  source: string;
};

export type SignerIdentityInput = {
  /** `--signed-by` on the command line. */
  stated?: string | undefined;
  /** `KERYX_ACTOR`, for a non-interactive caller. Read as STATED: a human set it. */
  env?: string | undefined;
  /** `git config user.email` in this checkout — who RAN the command, not necessarily who signed. */
  gitIdentity?: string | undefined;
};

/**
 * Resolve a signer's identity for a signature (AC3, AC4), in strict priority
 * order: `--signed-by` (stated) > `KERYX_ACTOR` (stated) > local git identity
 * (derived, NEVER promoted to stated) > unknown. Mirrors
 * `resolveRequestedBy` in `src/forgetting/journal.ts` exactly on this point:
 * "The git identity is deliberately the weakest input and is never
 * promoted: it answers 'whose checkout is this', [not who actually signed]."
 * Never invents a value when none of the three inputs is present.
 */
export function resolveSignerIdentity(input: SignerIdentityInput): Identity {
  const stated = input.stated?.trim();
  if (stated) {
    return { value: stated, basis: "stated", source: "`--signed-by` flag" };
  }
  const env = input.env?.trim();
  if (env) {
    return { value: env, basis: "stated", source: "KERYX_ACTOR environment variable" };
  }
  const git = input.gitIdentity?.trim();
  if (git) {
    return {
      value: git,
      basis: "derived",
      source:
        "git config user.email in this checkout — this is who RAN the command, which is not " +
        "necessarily who signed. Pass --signed-by to record the actual signer.",
    };
  }
  return {
    value: null,
    basis: "unknown",
    source: "no --signed-by flag, KERYX_ACTOR environment variable, or readable git identity",
  };
}

/**
 * The owner's identity. Unlike a signer, an owner is NEVER inferred (AC1): it
 * is only ever the value given explicitly to `--owner` on `flow init` or
 * `flow owner set`, so its `basis` is always `"stated"` — there is no
 * `derived`/`unknown` case for an owner, because an owner that was not
 * explicitly named is simply absent (`FlowState.owner === undefined`), never
 * a guessed one.
 */
export function ownerIdentity(name: string, source: string): Identity {
  return { value: name, basis: "stated", source };
}

/** One line describing an identity, for history/journal details. */
export function describeIdentity(identity: Identity): string {
  return `${identity.value ?? "unknown"} [${identity.basis}]`;
}
