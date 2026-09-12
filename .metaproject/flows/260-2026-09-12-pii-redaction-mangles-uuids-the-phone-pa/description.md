# PII redaction mangles UUIDs: the phone pattern eats a correlationId in MCP output

Status: draft (flow-init skill formalizes this)
Source: CI failure on PR #538, reproduced locally 2026-09-12

## Problem

keryx's PII detector classifies the middle of a UUID as a phone number and
redacts it. An identifier that goes through the redacting surface comes out
corrupted:

```
$ echo '{"correlationId":"730344f3-3668-4760-9056-bf7292686b67"}' | keryx security check-output --stdin
  pii/pii.phone → redact (line 1)
{"correlationId":"730344f3-[REDACTED:phone]-bf7292686b67"}
```

The phone pattern matches a run of digit groups (`3668-4760-9056`) **inside** a
longer hyphenated token, with no boundary or context guard rejecting a match
that sits in the middle of a hex identifier.

### How it surfaced

`src/sac/proposal-lifecycle-parity.test.ts:51` — "actual CLI and real stdio MCP
SDK preserve terminal review and replay parity" — failed in CI on a release PR
that touched only `package.json` and `CHANGELOG.md`. The CLI returned the whole
UUID; the MCP path returned the redacted one, and the parity assertion caught
the difference. The test is not flaky in the usual sense: it fails exactly when
`crypto.randomUUID()` happens to produce a phone-shaped middle.

### How often

Measured on 5 000 random v4 UUIDs put through `keryx security check-output`:
**46 were redacted — about 0.9 %, roughly one in a hundred.** So this is not a
test-only curiosity: correlation ids, event ids and any other UUID crossing a
redacting surface are corrupted at that rate in real use, and the corruption is
silent — the consumer receives a well-formed-looking string that is not the id
that was issued.

### Why now

Two costs, both live on `main` today (predating 0.2.98, which is unaffected by
this and unaffected BY it):

1. **Correctness.** An MCP client correlating events by `correlationId` will
   fail to match roughly 1 % of them, with no error anywhere.
2. **Signal.** A CI gate that fails on a dice roll trains everyone to re-run it,
   which is how a real failure gets re-run away next time.

## Expected Outcome

- A UUID is never partially redacted, whatever digits it happens to contain.
- The phone detector still catches the phone numbers it is there for — the fix
  is a boundary/context guard, not a weakened pattern, and the existing phone
  corpus still passes.
- The mechanism is covered by a test that would have failed before the fix
  deterministically, rather than once in a hundred runs.
- The parity test stops being a lottery.

## Out of Scope

- Rewriting the detector architecture or the finding/severity model.
- Other detector families (secrets, injection, other PII categories) beyond
  whatever the same boundary bug demonstrably affects.
- The 0.2.98 release, which ships independently of this.
