# Flow Journal

## D5 — what "the local profile" is, decided rather than looked up

Spec AC-04 says a remote profile may never grant what the local profile denies,
and keryx has several local postures: `harness run` is `read-only-review`,
`harness exec` is shell-allow, and the interactive shell — the surface an
operator actually sits in front of — is `shellParentProfile`.

The ceiling is the interactive shell's posture. "Remote may never grant what
local denies" is a statement about what local GRANTS, not about the strictest
corner of it, and picking `read-only-review` would make the check pass only for
a remote profile that can do nothing — not a security property but a refusal to
implement the feature.

## Two things the launch prompt had wrong, found by running rather than reading

1. **There were four profile literals, not two.** The prompt named the two in
   `commands/harness.ts` as "the ONLY local profiles that exist".
   `tool/builtin/spawn-subagent-tool.ts` held two more with their own
   fingerprint inputs. The source-level guard written for D1 reported them; a
   reading of the prompt would not have.
2. **`DEFAULT_SERVE_PROFILE` is `remote-restricted`,** which is not a
   `PolicyProfileId`. Resolving the config's profile name against the frozen id
   set would have refused every configuration R4b shipped. Operator-facing names
   and frozen ids are now separate vocabularies — which is also the clearest
   statement of why `compareProfiles` may never compare names: `remote-restricted`
   and `unattended-untrusted` are one posture under two spellings.

## An ordering mistake I made and reverted

The profile checks first went in BEFORE the non-loopback check, and the recovery
suite went red: a two-fault configuration started refusing on the new check
instead of the proven one, changing which instruction the operator is handed.
Both refusals are terminal and neither is unsafe, so the order is a UX question
— and silently moving a refusal that has its own executed instruction is not a
change this slice needs. Moved to last, with the reason in the source.


- 2026-08-01T20:05:04.222Z - flow created
- 2026-08-01T20:12:53.915Z - frozen: 12 criteria; checksum recorded
- 2026-08-01T20:12:54.001Z - started
