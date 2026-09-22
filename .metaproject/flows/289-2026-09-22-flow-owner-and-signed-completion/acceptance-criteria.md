# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A flow can name an owner — the human accountable for it — set with `keryx flow init --owner "<name>"` and changed afterwards only through `keryx flow owner set <id> --owner "<name>" --reason "<why>"`, which refuses an empty reason. The owner is never inferred: a flow whose owner was never set reports `owner: not set`, not a name taken from git or the environment.
- AC2: Every owner change is kept as history, not overwritten: setting or changing the owner appends an event with the previous value, the new value, the reason and the time, so `keryx flow status` can answer both who owns the flow now and who owned it before. No code path rewrites or deletes an earlier entry; a test changes the owner twice and asserts both earlier values survive.
- AC3: Every recorded identity — the owner and each signer — carries a `basis` (`stated` when given explicitly by a flag or environment variable, `derived` when read from something like the local git configuration, `unknown` when nothing was available) and a `source` naming exactly where it came from. A derived identity is never recorded as stated, and no path invents an identity when none is available; tests cover all three bases.
- AC4: `keryx flow ac confirm` and `keryx flow complete` each append a signature recording who (identity, basis, source), when, and what was signed — for a confirmation the criterion id and the frozen acceptance-criteria checksum in force; for completion that checksum and the pull-request head commit the gates evaluated, when one is known. Signatures are append-only: running the command again adds a new signature and never alters an earlier one.
- AC5: Flows created by `flow init` after this change record an owner gate, opt-in per package the same way the existing tasks and review gates are. On such a flow `keryx flow complete` fails the owner gate with a named reason when no owner is set, and passes it when one is; a flow created before this change reports the gate as skipped and completes exactly as it did before.
- AC6: Existing `flow.json` files without owner or signature fields load, validate, pass `keryx flow check` and complete unchanged: the new fields are optional and additive in the schema and its published JSON Schema copy, no new schema version is introduced, and reading an old file never rewrites it on disk. A test loads a pre-change fixture and asserts all of this.
- AC7: `keryx flow status` shows the current owner (or `not set`) and the latest completion signature — signer, basis and time — as lines in the same style as its existing `status`, `AC` and `PR` rows.
- AC8: What keryx cannot verify is stated as a limit, not presented as a fact: the docs and the CLI output for a stated or derived identity say that a name given by a flag, an environment variable or the local git configuration is a claim that an agent could make on its own, not proof that a human signed. Nowhere does the feature claim otherwise.
- AC9: The flow command help, the CLI reference, README and a decision record describe the owner, the signature, the owner gate, the compatibility guarantee and the limits in AC8, and make clear that this "owner" is the accountable human — distinct from the existing use of "owner" for module ownership in the docs.
- AC10: CI is green on the PR and `keryx health run` gate is pass.
