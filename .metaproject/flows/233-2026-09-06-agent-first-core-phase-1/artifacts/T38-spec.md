# T38 spec — close the CLI exit-code denylists (F-002)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Owned
files: `src/commands/security.ts` and its tests (`src/commands/security.check-input.test.ts`,
a new `src/commands/security-gate-exit.test.ts`). Read-only: `src/security/*`,
`src/commands/security-recursive-scan.test.ts` (read to confirm it is
unaffected, per dispatch `files_to_read`).

## The defect (T35 F-002)

`src/commands/security.ts` has two places that turn a `SecurityGate` value
into a process exit code, and both are **denylists** rather than exhaustive
mappings:

- `exitCodeFor` (`:798-806`) — `ci` refuses only `fail`/`incomplete`;
  `needs-approval` exits 0. `enforced` is already correct (refuses
  `fail`/`needs-approval`/`incomplete`).
- `handleReport` (`:559`) — `mode === "ci" && (report.gate === "fail" ||
  report.gate === "incomplete")`; `needs-approval` exits 0 in every mode,
  including `ci`.

`runGate` is not exposed as a CLI command, so these two exit codes are the
only CLI-observable strict-CI gate. policies.md: "Strict CI принимает только
PASS" (strict CI accepts only PASS). A `needs-approval` gate — reachable by an
operator declaring `promptInjection.action: require-approval` at a reachable
`minConfidence`, per the `exitCodeFor` doc comment's own worked example —
ships unattended in `ci` today.

## What "the existing vocabulary" is

T33 already made two service-layer folds exhaustive, and this task must not
invent a second vocabulary next to them:

- `runGate` (`src/security/service.ts:301-330`) — a `switch` over the four
  `SecurityGate` values with the `default:` arm on the blocking side
  (`incomplete`), reached only after `hasRecognizedGate` validates the shape.
- `securityFlowGate` (`src/security/guard.ts:322-381`) — a `switch` over
  `runGate`'s `status`, `pass -> pass`, everything else including `default:`
  `-> fail`.

Both already treat `enforced` and `ci` identically as the two blocking modes
(`isBlockingMode(mode)` in `guard.ts`). `guardOutput` blocks on
`fail`/`needs-approval`/`incomplete` in both. The CLI's own asymmetry (`ci`
more permissive than `enforced`) is what F-002 calls "backwards."

## Fix shape

One shared, exhaustive predicate, exported for direct regression testing of
the default arm (the same reason `hasRecognizedGate`-style narrow validation
in `service.ts` is tested by constructing values TypeScript's own union would
never emit — a live `SecurityDecision` has no on-disk JSON analog to attack,
so the defensive arm needs a direct unit test to be exercised at all):

```ts
export function isPassGate(gate: string): boolean {
  switch (gate) {
    case "pass":
      return true;
    case "fail":
    case "needs-approval":
    case "incomplete":
      return false;
    default:
      return false; // future/unrecognized member: refuse, never fall through to pass
  }
}
```

`exitCodeFor` (site 1, feeds `handleScan` and `handleCheck` via
`applyRuntimeDecision`) becomes an allowlist over the one acceptable value,
in both strict modes — this is the literal fix F-002 suggests, and it is
what makes `ci` and `enforced` agree:

```ts
export function exitCodeFor(decision: SecurityDecision, _cwd: string, mode: string): number {
  if (mode === "ci" || mode === "enforced") {
    return isPassGate(decision.gate) ? 0 : 1;
  }
  return 0; // advisory / gateway: report-only, unchanged (§11 invariant)
}
```

`handleReport` (site 2) keeps F-002's own suggested scope — `ci` only, not
`enforced` — because that is what the reviewer's finding and suggested fix
both say, and `security report` is a distinct surface (it aggregates the
*last stored scan*, not a live decision) from the write-seam guard that
`isBlockingMode` governs. Widening it to `enforced` as well is a judgement
call this task is not making unilaterally; see Concerns.

```ts
export function reportExitCode(gate: string, mode: string): number {
  return mode === "ci" && !isPassGate(gate) ? 1 : 0;
}
```

Both call sites become one-line delegations to `isPassGate`. No new
vocabulary: `isPassGate`'s three-outcome shape (`pass` / not-pass-named /
refuse-on-default) mirrors `runGate`'s switch and `securityFlowGate`'s switch
exactly, just narrowed to the one boolean question the CLI needs.

## Messages

The dispatch requires "the message naming which of the three non-pass
outcomes occurred without echoing raw error text, a path or source bytes."
Both call sites already satisfy this and nothing here needs to add a new
message:

- `handleScan`/`handleCheck` (non-JSON): `renderDecision` always prints
  `gate: ${gateLabel(decision.gate)}` — `gateLabel` renders one of
  `PASS`/`FAIL`/`NEEDS-APPROVAL`/`INCOMPLETE`, never raw content.
- `handleCheck` with `--runtime`: the refusal message is
  `` `keryx security: this ${kind} was refused by the configured security
  policy (gate: ${decision.gate}).` `` — the gate enum value only.
- `handleReport`: `gate: ${gateLabel(report.gate)}` is printed unconditionally
  (JSON mode includes the `gate` field in the object). No error text, path, or
  source bytes are interpolated anywhere in either fold's message.

These labels distinguish `FAIL` (violation), `NEEDS-APPROVAL` (approval
requirement) and `INCOMPLETE` (unavailable evidence) — the three-way
distinction the dispatch asks to keep visible — and none of that changes with
this fix; only the exit code that accompanies each label changes for
`needs-approval` in `ci`.

## Regression tests (RED before, GREEN after)

New file `src/commands/security-gate-exit.test.ts`:

1. **Direct unit tests of `isPassGate`/`exitCodeFor`/`reportExitCode`** —
   the only way to exercise the default arm, since a live `SecurityDecision`
   has no on-disk JSON to attack the way `service.ts`'s `hasRecognizedGate`
   is attacked. Covers `pass`/`fail`/`needs-approval`/`incomplete` and one
   value TypeScript's own union would refuse (`"banana" as unknown as
   SecurityGate`), across `ci`/`enforced`/`advisory`.
2. **CLI-level regression, `security scan` in `ci` mode with a
   `needs-approval` finding** (T35-probe-cli2.ts's own reproduction: an
   injection string with `policies.promptInjection.minConfidence` lowered
   under the detector band) — RED before (exit 0), GREEN after (exit 1).
3. **CLI-level regression, `security report --json` over a stored
   `needs-approval` artifact in `ci` mode** (T35-probe-cli.ts's own case E4) —
   RED before (exit 0), GREEN after (exit 1).
4. **Incomplete gate, both sites, `ci` mode** — pinned as a *control*, not an
   inversion: `exitCodeFor`'s `ci` arm already refused `incomplete` before
   this fix (`decision.gate === "fail" || decision.gate === "incomplete"`),
   and so did `handleReport`'s. Both stay refused after. Written so a later
   edit cannot silently regress the one denylist member that was already
   correct.
5. **Pass control** — `ci` + a genuine `pass` decision/report exits 0, before
   and after. Proves the fix does not turn everything into a refusal.
6. **Advisory-mode control** — `advisory` + `needs-approval`/`fail` exits 0,
   before and after, at both sites. Proves §11 (advisory never blocks) is
   untouched.

Existing tests that encode the bug itself and must be corrected as part of
this fix (not "weakened" — their assertions describe the exact behavior
F-002 reports as wrong):

- `src/commands/security.check-input.test.ts:140-153` — `"an operator who
  lowers the injection floor DOES get a refusal"` currently asserts
  `writeConfig("ci", {...}); expect(exit).toBe(0)` for a `needs-approval`
  decision with no `--runtime`. After the fix this must be `1`. The comment
  block above it ("NOT ci, and that is the documented split") describes the
  pre-fix behavior as intentional; it is the bug and the comment is rewritten
  to say so.
- `src/commands/security.check-input.test.ts:482-492` —
  `"ci + needs-approval emits NOTHING"` drives the same case through
  `--runtime cursor`. Post-fix, `ci` refuses, so `decideHookOutcome` returns
  `{kind:"refuse"}` and cursor gets `{"permission":"deny", ...}` instead of
  silence. Exit code for cursor stays `0` by that runtime's own convention
  (refusal is a stdout document, not the process exit code) — the test is
  rewritten to assert the deny document and keep the `NEEDS-APPROVAL` message
  assertion.

No other test in the repository exercises `ci` mode with a `needs-approval`
decision through this file's exported entry points (checked below).

## Search for other command surfaces reading a gate value the same way

`bun src/cli.ts ctx rg -n ".gate\s*===|decision.gate|report.gate|.gate !=="
src/commands` and a follow-up broad sweep across `src` excluding
`src/security/**`, `src/commands/security.ts`, `src/flow/**` (T33's already-
fixed surface) and `src/commands/health.ts` (checked separately, below) turned
up:

- `src/commands/workspace.ts:157,168,169` — `security.gate === "needs-approval"`
  is a single-value check gating an acknowledgement flow, not a pass/fail
  exit-code fold; not the same shape.
- `src/sac/index.ts:383,399,429` and `src/sac/proposal-lifecycle.ts:713` and
  `src/lib/serve-turn.ts:789` — every one is already an **allowlist**
  (`gate !== "pass"` / `gate === "pass"`), the correct shape, not a defect of
  this class.
- `src/commands/health.ts:90-94` (`runExitCode`) — **the same denylist shape**,
  but over the unrelated `health` gate (`fail`/`incomplete`/`warn`-if-strict),
  not `SecurityGate`, and in a file this task does not own
  (`src/commands/security.ts` only). An unrecognized future `health` gate
  status falls through to `0` (a false pass) the same way `exitCodeFor` did.
  Out of scope for T38; flagged as a candidate for its own task rather than
  fixed here, since it is a different module with its own owner and its own
  gate vocabulary.

## Concerns to record (not blockers)

1. `handleReport` staying `ci`-only (not also `enforced`) is a direct
   reproduction of F-002's own suggested fix, not an independent judgement
   call — recorded so a future reviewer does not read the asymmetry as an
   oversight.
2. `src/commands/health.ts`'s `runExitCode` has the identical shape of bug
   for a different gate; out of this task's ownership, reported rather than
   fixed.
