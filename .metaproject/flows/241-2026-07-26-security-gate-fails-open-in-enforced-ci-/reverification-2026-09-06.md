# Re-verification against main (2026-09-06)

This package was written on 2026-07-26 in an isolated worktree and sat
unpushed. Before landing it, every hole was re-checked directly in
`origin/main` at `0bc6418` — 579 commits later.

**All five holes are still present.** Only line numbers moved.

| Hole | As written (2026-07-26) | On main (2026-09-06) |
|---|---|---|
| `guardOutput` assigns `mode` inside the `try`, so an engine error yields a synthetic pass | `guard.ts:93-106` | unchanged, same shape |
| `redactRaw` returns the original unredacted content from its `catch` | `guard.ts:146-148` | `guard.ts:~165` |
| `securityFlowGate` returns `null` on a config error | `guard.ts:190-195` | two `return null` sites in the same function |
| `redactToolOutput` adds a second blanket catch | `redact-seam.ts:29` | `redact-seam.ts:29` (unchanged) |
| `gates.every(g => g.status !== "fail")` cannot fail on an omitted gate | `flow/service.ts:431` | `flow/service.ts:672` |
| `isSecurityEnabled` collapses "absent" and "corrupt" via `readJsonFileOr(manifestPath, {})` | `guard.ts:60-69` | unchanged |

The analysis in `description.md` and criteria AC1–AC10 therefore still apply as
written. Re-derive exact line numbers at implementation time rather than
trusting the left-hand column.

## Flow id note

Minted as flow 125 on 2026-07-26 in a worktree; `main` independently allocated
125 to `125-2026-07-26-harness-shell-security-hardening-fix-f1-`. Renumbered to
241 (first id free in the clone allocation ledger) via `keryx flow renumber`;
the move is recorded in `.metaproject/flows/id-map.json`, so references to
"flow 125" from that session resolve through the id map.

## Status when parked

No implementation was started — this is a planning package only. Tasks T5–T8
(the four implementation slices) are all still open.
