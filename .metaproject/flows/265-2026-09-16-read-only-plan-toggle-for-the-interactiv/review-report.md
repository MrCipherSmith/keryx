# Review — flow 265, read-only /plan toggle

Base: cdd69cc98280a9015f6d7fecdff801418570cdc0
Head reviewed: 0138c58de630f6a19dbd421d1238166c0cc2bcc4
Branch: feature/plan-mode-toggle

Consolidated report from three parallel reviewers dispatched by flow-orchestrator
(task T4): review-logic, review-security-code, review-architecture. Lightweight,
non-managed, diff-mode review — no GitHub PR exists for this work.

## Summary

- review-logic: 0 findings (blocker/major/minor/info).
- review-security-code: 1 minor (F-001), 1 info (F-002).
- review-architecture: 0 blocker/major/minor findings; one info-level note on the
  same topic as F-002 (not separately numbered — folded into F-002's evidence).

Zero blockers, zero majors. One minor finding, fixed in commit 9fe403b0d25f3d3f4d3a2c0b928273739182d7e2
before this ingest.

## F-001 — Injection quarantine vocabulary not extended to /plan read-only mentions

severity: minor

`src/harness/child/quarantine.ts:38-42`'s `permission-config` pattern already
treats `permissionMode`/`bypassPermissions` mentions in subagent free text as an
injection marker, per `permission-mode.ts`'s own stated threat model ("The mode
itself must only ever be set by an explicit user action ... `quarantine.ts`
already treats `permissionMode`/`bypassPermissions` ... this module gives that
vocabulary a real, host-only home"). The new `readOnly`/`/plan` axis introduced
parallel vocabulary that was not added to that pattern list. Not exploitable
today — `readOnly` is a plain in-memory closure variable set only by literal
`wanted === "on"/"off"` comparison against typed REPL/TUI input, with no
tool/model/child-output write path (confirmed by review-security-code via grep
of every assignment site). Documentation/defense-in-depth completeness gap.

quote: `name: "permission-config",`

## F-002 — supervise-mcp.ts's decision branch does not exhaustively narrow the new "deny" outcome

severity: info

`src/harness/external/supervise-mcp.ts:281-291`'s handling is
`if (gateDecision === "auto") {...} else if (deps.requestApproval === undefined) {...} else {...}`
— the final `else` treats anything that is not `"auto"` (including a
hypothetical `"deny"`) as `"ask"`. Currently harmless: `readOnly: false` is
hardcoded at this call site, so `resolveApprovalDecision` can never actually
return `"deny"` here. Latent code-smell only, no current attack vector — flagged
by both review-security-code and review-architecture as an info-level
observation. No action taken; optional future hardening (explicit `"deny"` case
or exhaustiveness-checked switch) if this call site's `readOnly` is ever wired to
something toggle-able.

quote: `} else if (deps.requestApproval === undefined) {`

```json keryx:findings
[
  {
    "reviewer": "review-security-code",
    "id": "F-001",
    "severity": "minor",
    "file": "src/harness/child/quarantine.ts",
    "quote": "name: \"permission-config\",",
    "problem": "quarantine.ts's permission-config pattern did not cover readOnly/plan vocabulary, unlike permissionMode/bypassPermissions which permission-mode.ts's own docstring says it covers.",
    "impact": "No live exploit (readOnly has no tool/model-output write path); defense-in-depth completeness gap relative to the existing threat model permission-mode.ts commits to.",
    "suggested_fix": "Extend the permission-config regex to also match readOnly/read-only-mode/plan vocabulary.",
    "evidence": "permission-mode.ts's top-of-file docstring states quarantine.ts covers permissionMode/bypassPermissions; quarantine.ts:38-42's permission-config pattern's regex alternation had no readOnly/plan terms before this fix.",
    "confidence": "high"
  },
  {
    "reviewer": "review-security-code",
    "id": "F-002",
    "severity": "info",
    "file": "src/harness/external/supervise-mcp.ts",
    "quote": "} else if (deps.requestApproval === undefined) {",
    "problem": "The gateDecision branch does not exhaustively narrow the new \"deny\" outcome; its final else treats any non-auto decision (including a hypothetical deny) as ask.",
    "impact": "None today: readOnly is hardcoded false at this call site, so resolveApprovalDecision can never actually return \"deny\" here.",
    "suggested_fix": "Optional: switch on gateDecision with an explicit deny case for future-proofing, if this call site's readOnly is ever wired to something toggle-able.",
    "evidence": "supervise-mcp.ts:263-291 constructs the ApprovalGateInput with readOnly: false unconditionally, then branches only on auto vs. requestApproval-undefined vs. else.",
    "confidence": "high"
  }
]
```
