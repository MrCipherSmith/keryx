# ADR-0008: The interactive shell's `delegate` risk class auto-allows without an approver

**Status**: Accepted 2026-07-22

**Reviewer Track**: security
**Source of Truth**: this document, for the *interactive shell* gate only
**Relates to**: ADR-0003 (D-03 security profiles and fail-closed containment)

---

## Context

An audit of the `keryx-opentui-shell` requirements package against the code found
that PRD N4 — "the approval/default-deny path and egress gates are untouched
(ADR-0003 holds)" — is not true as written. The interactive shell's risk gate in
`src/commands/agent.ts` (`executeCall`) has three classes, and they do not behave
alike when no approver is present:

```
read      → auto-allow
shell     → requires approval; DEFAULT-DENY when no approver
delegate  → auto-allow when no approver; ask when one is present
anything else → denied
```

So `spawn_subagent` runs unprompted in any context without an approver — a
harness run, a test, CI — while `shell_exec` in the same context is refused. The
asymmetry is deliberate and carries an explanatory comment at the call site, but
it existed only as that comment. This ADR records it, and records the containment
that makes it defensible.

**This ADR does not re-decide ADR-0003.** That decision governs the harness
policy engine, where `delegate` is a first-class policy dimension: every
`policy-profile.schema.json` instance carries `defaults.delegate ∈
allow|ask|deny`, and the schema *forces* `delegate = deny` for
`read-only-review`. The gate discussed here is a **different, simpler mechanism**
— the interactive shell's own tool gate. Conflating the two is the mistake this
document exists to prevent.

---

## Decision

**The interactive shell's `delegate` class continues to auto-allow when no
approver is present. Behaviour is unchanged; the reasoning is now written down.**

The justification is not "delegation is low risk" — it is that in this codebase
**delegation cannot expand authority**, because the child is strictly less
capable than the parent. Verified in the source at the time of writing:

1. **The child cannot run a shell command.** `spawn-subagent-tool.ts:271` passes
   `requestApproval: async () => false` with the comment "children never run
   shell". The child's `shell` class therefore hard-denies, rather than merely
   default-denying.
2. **The child is not given `shell_exec` at all.** Its tool set is
   `builtinReadOnlyTools(cwd)` plus `builtinMetaprojectTools(...)`
   (`spawn-subagent-tool.ts:223-231`). The comment on the general branch is
   explicit: "still no shell_exec (parent owns mutations)".
3. **The child cannot spawn further subagents.** `spawn_subagent` is not in the
   child's tool set, so recursion is structurally impossible. The system
   instruction also says "Do not spawn further subagents", but that sentence is
   belt-and-braces — the guarantee is the tool set, not the prompt. This matters:
   a guarantee that rests on model compliance is not a guarantee.

Given those three, an unapproved `delegate` grants the model a read-only child
that can neither mutate through a shell nor widen the tree. Requiring approval
for it would add a prompt without removing an authority.

---

## Consequences and residual risk

Stated plainly rather than implied:

- **Resource consumption is not gated.** An unapproved `spawn_subagent` spends
  provider tokens and wall-clock. Budget ceilings, not the risk gate, are what
  bound that. A model in a loop can spend money without ever touching `shell`.
- **The metaproject tools are labelled `risk: "read"`
  (`metaproject-tools.ts:140,167,189`) and reach `keryx` commands through
  `makeKeryxRunner`.** Whether every reachable command is genuinely read-only is
  *not* established by the label — the label is an assertion by the tool author.
  This is the weakest link in the chain above and the one to re-examine first if
  the child's capability set ever grows.
- **The asymmetry is surprising on first reading.** `shell` fails closed without
  an approver and `delegate` fails open. Anyone extending `executeCall` with a
  fourth class should decide its no-approver behaviour explicitly rather than
  copying whichever neighbour is closest.

## When this decision must be revisited

Any one of these invalidates the reasoning above and requires re-deciding, not
re-interpreting:

- the child gains `shell_exec`, `spawn_subagent`, or any tool of risk other than
  `read`;
- `requestApproval: async () => false` is removed or made configurable for
  children;
- a metaproject tool labelled `read` is found to mutate, or the runner gains a
  write-capable command reachable from a child;
- the interactive shell adopts the harness policy engine, at which point
  `policy-profile.schema.json`'s `defaults.delegate` becomes the authority and
  this gate should be deleted rather than kept in parallel.

---

## Alternatives considered

**Make `delegate` default-deny, symmetric with `shell`.** Rejected for now: it
would break every non-interactive context by construction — a harness run, a
test, or CI has no approver by definition, so subagents would simply stop
working there, in exchange for no reduction in authority (see the three
containment facts above). It becomes the right answer the moment any of the
revisit conditions fires.

**Add a policy flag or environment switch for strict mode.** Rejected as
premature: it adds a second behavioural branch, and therefore a second thing to
test and reason about, to protect against a risk that the containment already
covers. Worth revisiting if keryx ever runs untrusted content in an unattended
profile — which is precisely ADR-0003's `unattended-untrusted` tier, where the
harness policy engine, not this gate, is the right mechanism.

---

## Traceability

- `src/commands/agent.ts` — `executeCall` risk gate (the subject of this ADR).
- `src/harness/tool/builtin/spawn-subagent-tool.ts` — `risk: "delegate"` at
  `:134`; child tool set at `:223-231`; `requestApproval: async () => false` at
  `:271`.
- `src/harness/tool/builtin/metaproject-tools.ts` — `risk: "read"` labels.
- [ADR-0003](ADR-0003-d03-security-profiles-containment.md) — the harness policy
  posture, including `defaults.delegate` and the `read-only-review` hard deny.
  **Not superseded, not weakened, and not the mechanism described here.**
- `docs/requirements/keryx-opentui-shell/prd.md` — N4 and its divergence table
  entry, which points at this ADR.

**Decision recorded by**: the 2026-07-22 requirements audit follow-up.
**Approver**: repository maintainer (chose "record as-is" over changing behaviour
when the asymmetry was surfaced).
