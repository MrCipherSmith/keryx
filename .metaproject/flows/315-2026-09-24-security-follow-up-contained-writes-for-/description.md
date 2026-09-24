# Security follow-up: contained writes for init, testing service and .gitignore, plus deferred W3/W4 minors

Status: formalized
Source: deferred follow-up scope in the journals of flows 313 (W4, PR #690) and 312 (W3, PR #691)

## Problem

The W4 and W3 reviews left one major finding and several minor ones open. The owner deferred them to this flow.

- R5-F1 (major, pre-existing on main): `keryx init` writes through symlinks inside the repo that point outside the project.
  - A symlinked manifest can overwrite an arbitrary file.
  - Rules get planted into `~/.claude/rules`, carrying the cloned repo's AGENTS.md text.
  - The writers in `src/testing/service.ts` have the same defect.
- R5-F3 (minor): `src/lib/metaproject-gitignore.ts` appends through a symlinked `.gitignore`.
- W4 R8-F1 (minor): the test near `src/security/audit-harness/audit-harness.test.ts:2001` passes on the pre-fix code, so it guards nothing.
- W4 R8-F2 (info): there is no UTF-32 BOM detection.
- W4 R8-F3 (info): the direct audit path gives a false positive for UTF-16 agents.
- W3 R10-F1 (minor): stale skill/rule graduation proposals are never re-gated against a login configured after they were written. `graduate apply` also prints the stored next-step command.
- W3 R10-F2 (minor): the model-backed draft's extractor label and evidence sourceRef are persisted without going through gateReviewerText.

## Expected Outcome

- `init`, the testing service and the gitignore helper route every write under the project root through `src/lib/contained-write.ts`.
- All three of those files are covered by the ratchet.
- The R8-F1 test is meaningful: it fails on the pre-fix code.
- Stored graduation proposals are re-gated on rerun and at apply time, and so is the printed command.
- Model-backed draft metadata is gated before it is persisted.
- Every fix has a regression test that fails on the pre-fix code.
- R8-F2 and R8-F3 are fixed if the fix is cheap, and documented as limitations otherwise.

## Out of Scope

Deferred W3 follow-ups:

- host observers for harnesses other than Claude Code;
- a scheduled `keryx learn prune`;
- a salted HMAC for observation edit digests;
- graduation apply for skill and rule targets;
- `KERYX_LEARNING` accepting values other than `off`;
- the info findings R10-F3 and R10-F4.

Deferred W4 follow-ups:

- R3-F18 (bundle ownership provenance);
- the info findings carried over from rounds r05 through r07.
