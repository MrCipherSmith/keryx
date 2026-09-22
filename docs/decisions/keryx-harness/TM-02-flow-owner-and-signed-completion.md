# TM-02: Flow Owner and Signed Completion

## Additive Owner/Signature Fields, the Owner Gate, and Honesty Limits on Identity

**Status**: Implemented
**Frozen**: 2026-09-22
**Task**: flow 289
**Depends on**: TM-01 (task-manager-evolution.md) — additive-field and read-time-migration precedent this document reuses without repeating it in full
**Reviewer Track**: architecture

---

## 1. Purpose

Before this change, `keryx flow complete` and `keryx flow ac confirm` recorded **that** a command ran, and when, but never **who** took responsibility for it. `flow.json` had no concept of an accountable human — only a `history` log of events with no actor, and an `acConfirmed` record of `{at, note}` with no signer. This document specifies the additive fields, the CLI surface, the opt-in completion gate, and — most importantly — the honesty limits this feature is built around: keryx can record a **claim** about who acted, and where that claim came from, but it cannot prove a human, rather than an agent, made it.

## 2. The `owner` field

`FlowState.owner?: Identity` (see §4) — the human accountable for the flow, or absent if one was never named.

**Not to be confused with "owner" elsewhere in this repository's docs.** `docs/requirements/**` uses "owner" extensively for *module/subsystem* ownership — which code module is authoritative for writing a given artifact type (e.g. "Flow owner", "Wiki owner" in the shared-agent-context specifications). That is a different concept from this document's `owner`: a flow's `owner` is the accountable **human**, never a module. The two uses of the word are unrelated, and a reader of this document should not assume the module-ownership docs already define this field.

**Never inferred.** Unlike a signature's signer, an owner is populated **only** by an explicit `--owner "<name>"` on `keryx flow init` or `keryx flow owner set <id> --owner "<name>" --reason "<why>"`. No code path reads a git identity, an environment variable, or any other source to fill this field — an owner nobody named is simply absent (`owner: not set`), never guessed. Its `Identity.basis` is therefore always `"stated"`.

`keryx flow owner set` always requires a non-empty `--reason`, including for the very first assignment. Every call appends a `history` event (`owner-set` the first time, `owner-changed` afterward) naming the previous value, the new value, the reason, and the time — using the same append-only `history` mechanism every other flow mutation already uses (`ac-updated`, `task-attempt`, `frozen`, …). No earlier owner is ever lost to a silent overwrite: reading `flow.json` (or `keryx flow status`) after two changes shows the current owner from the `owner` field and both prior transitions from `history`.

## 3. Signatures

`FlowState.signatures?: FlowSignature[]` — an **append-only** array. `keryx flow ac confirm` and a **passing** `keryx flow complete` each push one entry; nothing ever removes or rewrites an entry, including a repeated confirmation of the same criterion (that adds a new entry, it does not replace the old one).

Each `FlowSignature` records:

| Field | Meaning |
|---|---|
| `at` | When this was signed (ISO 8601). |
| `kind` | `"ac-confirm"` or `"complete"`. |
| `identity` | Who signed — an `Identity` (§4). |
| `criterion` | The AC id, for `kind: "ac-confirm"` only. |
| `acChecksum` | The acceptance-criteria checksum in force at signing time (`null` if not yet frozen). |
| `headCommit` | For `kind: "complete"`: the direct-merge `--merged` commit, or **the head commit the pull-request gate observed** via its own `prStatus()` call — never guessed when unobserved, and never a second, independent fetch (`src/flow/service.ts`, `evaluatedHeadCommit`, captured from the pull-request gate's own call). |

A completion signature is appended **unconditionally** on a passing `complete()` — independent of whether the package opted into the owner gate (§5). A pre-existing package with no `owner` still gets a `kind: "complete"` signature; it simply never claims an owner that was never set.

**`headCommit` names one gate's observation, not a cross-gate guarantee.** `complete()` runs several gates that each read the PR head independently — the pull-request gate, the base-branch gate (§5 of the specification), and the review gate — each via its own call (`prStatus()`, or the review round's recorded head). Nothing re-runs those calls to reconcile them, and nothing blocks on them disagreeing. A push landing on the PR in the window between two of those calls, mid-`complete()`, can make them observe different commits; `headCommit` on the signature records only what the **pull-request gate** saw, not that every gate agreed on that commit. This is a real, if narrow, observation window — deliberately not closed here (closing it would mean re-architecting the gates to share one fetch, out of scope for this document) but the field's name and every description of it are written to not overclaim past what was actually observed.

## 4. `Identity`: a claim, not a proof

```ts
type IdentityBasis = "stated" | "derived" | "unknown";
type Identity = { value: string | null; basis: IdentityBasis; source: string };
```

This is deliberately the same shape as `Attribution`/`resolveRequestedBy` in `src/forgetting/journal.ts` (who requested a deletion) — defined locally in `src/flow/identity.ts` rather than imported, because the two modules solve unrelated problems and importing across them would create a dependency edge with no other reason to exist. The **doctrine** is copied on purpose:

- `"stated"` — given explicitly: `--signed-by` on the command line, or the `KERYX_ACTOR` environment variable. Both are still just a claim — an agent can set either on itself — but they are at least an explicit, on-the-record assertion, not an inference.
- `"derived"` — read from something the caller did not directly assert, such as `git config user.email` in the checkout the command ran in. **Never promoted to `"stated"`.** A local git identity answers "whose checkout is this", not "who actually signed" — the same distinction `journal.ts` already draws for deletion requesters.
- `"unknown"` — nothing was available. `value` is `null`. No path invents a name.

Resolution order for a **signer** (`resolveSignerIdentity`, `src/flow/identity.ts`): `--signed-by` > `KERYX_ACTOR` > local git identity (derived) > unknown. An **owner** never goes through this resolver at all (§2) — it has no derived/unknown case.

**What keryx does not claim.** None of `--signed-by`, `KERYX_ACTOR`, or a local git identity is proof that a human — rather than an agent running the same commands — made the assertion. This is stated plainly in the CLI output (`keryx flow complete`'s "Signed by:" note names the basis and, for anything short of an explicit human confirmation, says so) and in this document, rather than presented as a verified fact. See §7 for what a stronger guarantee would require and why this document does not adopt it now.

## 5. The owner gate

Opt-in per package, on the same precedent as `FlowGates.tasks`/`FlowGates.review` (TM-01's `FlowGates` mechanism, `src/flow/types.ts`): `gates.owner` is written `true` by `flow init` for every flow created after this change. A package without the flag (every flow created before this change — 197+ packages in this repository) reports the gate `skipped`, never `fail`; no historical package is retroactively invalidated.

For an opted-in package, `keryx flow complete`'s owner gate:
- **fails** with a named reason (`no owner set; run \`keryx flow owner set <id> --owner "<name>" --reason "<why>"\``) while `flow.owner` is absent;
- **passes** once an owner is set.

The gate checks only that an owner is *present* — it makes no claim about who set it, which is exactly why `owner`'s `Identity.basis` is always `"stated"` rather than something the gate could be fooled about.

## 6. Backward compatibility

No new `schemaVersion` is introduced. `owner` and `signatures` are optional, additive fields exactly like every TM-01 v2 field: `flowStateSchema()` (`src/flow/schema.ts`) and its committed docpack copy (`docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json`, kept byte-consistent by `src/flow/schema.test.ts`) model them as optional; `migrateFlow` (`src/flow/store.ts`) requires no new migration step for them — an absent key is a valid v2 shape, not a value needing a deterministic default — and reading an old file never rewrites it on disk (unchanged from TM-01 §4.1/§4.3). A pre-existing `flow.json` with no `gates`, `owner`, or `signatures` keys loads, validates, passes `keryx flow check`, and completes with the same pass/fail outcome as before this change (owner gate: `skipped`; every other gate: unaffected).

## 7. What a stronger guarantee would need (deferred)

The strongest mechanism keryx already has for "a human, not an agent, did this" is `src/sac/review-confirm-token.ts`: a short-lived, single-use, hashed token mintable only through `keryx workspace confirm-review` — a shell-only, approval-gated CLI command that an MCP/agent-only caller cannot invoke on its own, so a caller with only tool access cannot mint a token, and a caller with `shell_exec` still needs a human to approve that one command. Reusing that mechanism (or its pattern — a verb an agent-only caller structurally cannot self-invoke) for `flow ac confirm`/`flow complete` signing would turn a signature from an honest claim into a structural proof.

This document deliberately does **not** adopt that mechanism now. It is heavier machinery (a TTL'd token store, idempotency-keyed receipts, approval-gate wiring) built for one specific high-stakes SAC accept path, and the operator's ask for this flow was an accountable, on-the-record human — a claim with an honestly-stated basis — not a forgery-proof one. Building the stronger mechanism is flagged here as a natural, separately-scoped follow-up, not committed to.

## 8. CLI surface

```
keryx flow init ... [--owner "<name>"]
keryx flow owner set <id> --owner "<name>" --reason "<why>"
keryx flow ac confirm <id> <ACn> [--note "<evidence>"] [--signed-by "<name>"]
keryx flow complete <id> [--comment] [--merged <commit>] [--signed-by "<name>"]
keryx flow status <id>            # shows `owner:` and `signed:` lines
```

`--signed-by` falls back to `KERYX_ACTOR`, then to `git config user.email` in the checkout, then to `unknown` — see §4. `--owner` is never inferred from any of those.

## 9. References

- `src/flow/identity.ts` — `Identity`/`IdentityBasis`, `resolveSignerIdentity`, `ownerIdentity`.
- `src/flow/types.ts` — `FlowState.owner`, `FlowState.signatures`, `FlowGates.owner`, `GateOutcome.name` (`"owner"`).
- `src/flow/schema.ts` / `docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json` — JSON Schema for both fields.
- `src/flow/service.ts` — `ownerSet`, the owner-signing paths in `acConfirm`/`complete`, and `ownerGate`.
- `src/commands/flow.ts` — CLI wiring, `readGitUserEmail`, `signerIdentityArgs`.
- `src/forgetting/journal.ts` — the `Attribution`/`resolveRequestedBy` precedent this document's `Identity` doctrine mirrors.
- `src/sac/review-confirm-token.ts` — the stronger, structural human-presence mechanism discussed and deferred in §7.
- `docs/decisions/keryx-harness/TM-01-task-manager-evolution.md` — the additive-field, read-time-migration precedent this document follows without repeating.
