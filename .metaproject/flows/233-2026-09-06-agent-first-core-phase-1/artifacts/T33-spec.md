# T33 spec — one repair across the security gate path (config load → flow completion)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`).
Written before any production edit. Baseline evidence for every defect is the two
reviewer probes, executed first (raw logs in the Verification section of
`T33-implementation.md`).

## The five defects, and the one path they sit on

| # | Site | Today | Required |
|---|---|---|---|
| D1 | `service.ts` `readLatestReport` / `runGate` / `runReport` | absent **and** unparseable `latest.json` both collapse to `null`; `runGate` maps `null` to `pass`, `runReport` synthesizes a `gate: "pass"` report | both are *unavailable evidence* → `incomplete`; `runReport` builds an `incomplete` report |
| D2 | `service.ts` `runGate` fold | two-value denylist (`fail`/`incomplete`) with an unconditional `pass` fallthrough over a value obtained by `as SecurityReport` with no shape check | exhaustive mapping over the four recognized `SecurityGate` values; array / non-object / missing `gate` / unrecognized `gate` → `incomplete` |
| D3 | `guard.ts` `guardOutput` outer catch | any throw → `{ allowed: true, decision: ALLOW_DECISION }`, in every mode | a posture that cannot be read is incomplete evidence, never a `pass` decision |
| D4 | `guard.ts` `securityFlowGate` mode-load catch | `return null`, indistinguishable from the intentional module-disabled `null`, so flow completion omits the gate entirely | a blocking `fail` entry with a constant, leak-safe detail |
| D5 | `guard.ts` `securityFlowGate` status mapping | non-exhaustive ternary over a four-value union; `needs-approval` reads as `pass` | exhaustive mapping; `pass` is the only non-blocking status |
| root | `config.ts` `loadSecurityConfig` | `mergeSecurityConfig(parsed)` reads `parsed.policies` off a non-object JSON payload (`null`, `[]`, `5`, `"x"`) and throws — the single trigger behind D3 and D4 | a non-object payload takes the function's existing malformed-JSON fallback to defaults |

## Why the completion gate decides the mapping

`src/flow/service.ts` (read-only for this task) is the consumer:

- Gate 6 (`:657-670`) pushes an entry only when `securityFlowGate` returns non-`null`.
- `passed = gates.every((gate) => gate.status !== "fail")` (`:672`).

So `pass` and `skipped` are both non-blocking and a missing entry is invisible.
A status the completion gate ignores is not a gate — therefore `securityFlowGate`
must return `fail` for everything that is not a verified `pass`.

## Design

### 1. `config.ts` — the root trigger

`loadSecurityConfig` treats a parsed value that is not a plain object exactly as
it already treats malformed JSON: fall back to `mergeSecurityConfig({})`. No new
behavior, one existing behavior extended to the payload shape that escaped it.

### 2. `service.ts` — evidence classification

`readLatestReport` returns a discriminated outcome instead of `SecurityReport | null`:

```
{ kind: "report"; report } | { kind: "absent" } | { kind: "unreadable" }
| { kind: "unparsed" } | { kind: "invalid" }
```

Validation is deliberately **narrow**: the parsed value must be a non-null,
non-array object carrying a `gate` that is one of the four `SecurityGate`
literals. Not the full `SECURITY_REPORT_SCHEMA`, for two reasons:

1. The gate decision reads exactly one field, so the shape that matters is
   "an object with a recognized gate".
2. Full-schema rejection buys nothing against tampering — an attacker who can
   write `latest.json` can write a fully schema-valid report with `gate: "pass"`
   just as cheaply as a malformed one — while it *would* collapse the very
   distinction this task must preserve, reclassifying every legitimate
   `fail` / `needs-approval` artifact that predates a schema field as
   `incomplete`.

`runGate` then maps exhaustively, and its status union gains `needs-approval`
so the report keeps the three distinctions the design constraint names:

| Evidence | `runGate` status | reason (constant literal) |
|---|---|---|
| `gate: "pass"` | `pass` | `security gate: pass` |
| `gate: "fail"` | `fail` | `security gate: fail` |
| `gate: "needs-approval"` | `needs-approval` | `security gate: needs-approval` |
| `gate: "incomplete"` | `incomplete` | `security gate: incomplete` |
| no `latest.json` | `incomplete` | `no security report; run \`keryx security scan\` first` |
| unreadable / unparseable / shape-invalid / unrecognized gate | `incomplete` | `security report unusable; re-run \`keryx security scan\`` |

Every reason is a string literal: no error text, no path, no source bytes.

`runReport` shares the same outcome: a usable stored report is returned as-is,
anything else builds a report with `gate: "incomplete"` instead of `"pass"`.

`runScanPath`'s `pass -> incomplete` fold (`service.ts:174-176`) is **not
touched** — T34 depends on it for the truthful non-recursive directory outcome.

### 3. `types.ts` — additive only

`SecurityService.gate`'s status union gains `"needs-approval"`. Additive; the
only in-repo consumer is `securityFlowGate`, which this task also changes.

### 4. `guard.ts` — the two catches and the mapping

- The mode load moves into its **own** `try`. A workspace that has *enabled*
  security but cannot read its own posture is incomplete evidence: `guardOutput`
  returns `allowed: false` with an `incomplete` decision and a constant reason.
  Guessing a permissive mode is what the defect did.
- The engine `check` keeps its own catch, degrading to an `incomplete` decision
  that then flows through the existing mode fold — advisory keeps truthful
  diagnostics and does not block, enforced/ci blocks. Unchanged behavior for
  every workspace whose config loads.
- `securityFlowGate`'s mode-load catch returns
  `{ status: "fail", detail: "security posture unavailable: check could not complete" }`
  instead of `null`. `null` stays reserved for the one intentional case:
  the module is disabled.
- The status mapping becomes an exhaustive `switch`: `pass -> pass`;
  `fail`, `needs-approval`, `incomplete` and any unrecognized future value
  -> `fail`.
- The two comments F-003 (T30) flags as mislabelling this scope are corrected.
  The file header's statement that the deterministic output floor applies
  regardless of module state is left exactly as it is.

## Regressions (RED first), one per defect

All in `src/security/guard.test.ts` — the owned test file, and the one already in
the required verification selection. `runGate`/`runReport` are imported from
`./service`.

| Test | Defect | Fails before because |
|---|---|---|
| `runGate: missing and unparseable evidence is incomplete, never pass` | D1 | absent / truncated / empty all return `pass`; `runReport` returns `gate: "pass"` |
| `runGate: the fold is exhaustive over recognized gates and refuses the rest` | D2 | `needs-approval`, missing `gate`, `"banana"` and `[]` all return `pass` |
| `guardOutput: an unreadable security posture is not an allow` | D3 | the outer catch returns `allowed: true` with a `pass` decision |
| `securityFlowGate: an unreadable posture blocks instead of vanishing` | D4 | returns `null`, so flow completion omits the gate |
| `securityFlowGate: a stored needs-approval report blocks completion` | D5 | maps to `{ status: "pass" }` |

D3 and D4 force the load failure with `mock.module` over `./config`, restored in
`finally` — after the root-cause fix the branch is unreachable from a fixture,
which is the point. A sixth test pins the original `null`-config reproducer end
to end (the trigger no longer throws, and the planted secret is detected rather
than silently passed).

## Out of scope, deliberately

- `runScanPath`, `path-scan.ts`, `output-validation.ts`, `src/mcp/*`,
  `src/commands/*`, `src/flow/service.ts`, `service.memo.test.ts`.
- A destroyed `security.config.json` now loads as the **default** config, whose
  mode is `advisory`. That is the pre-existing malformed-JSON fallback the
  dispatch explicitly asks for, and mode-downgrade detection (§14
  self-protection) is the control that covers it. Recorded as a concern, not
  changed here.
