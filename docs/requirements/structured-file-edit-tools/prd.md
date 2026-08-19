# PRD: Structured File-Edit Tools
Version: 0.2.0

## Problem

The interactive agent has exactly one way to change a file: `shell_exec`.
Every edit — however small, however read-adjacent in intent — is classified
`risk: "shell"` (`shell-exec-tool.ts:383`), which is one of the six
non-`"read"` risk classes sharing a single small per-turn budget
(`DEFAULT_MAX_NON_READ_TOOL_CALLS`). On any task that touches more than a
handful of files, or edits the same file more than a couple of times, the
agent runs out of budget mid-task — independent of whatever the budget's
*number* is set to, because the real bottleneck is "one shell call per edit,"
not "the number is too small." (Raising the default 8→32, landed separately,
buys headroom but does not fix the underlying one-edit-one-slot shape.)

Two secondary problems compound this:

- The approval prompt for an edit shows the human a raw shell command
  (`cat > file <<'EOF' ... EOF` or a `sed` invocation), not a diff. Reviewing
  "is this edit safe" from shell-escaped heredoc text is materially harder
  than reviewing a diff.
- The destructive-command classifier (`src/lib/command-risk.ts`) reasons
  about shell *syntax* (`rm -rf`, `chmod -R`, force-push). It has no way to
  flag "this patch deletes `src/harness/policy/engine.ts`" — that fact is
  invisible to it because the file never appears as a shell argument, only
  inside a heredoc body.

## Goal

Add `apply_patch`: a tool that takes a standard multi-file unified diff,
validates and applies it in-process, and is approval-gated with:

1. a real `write`-risk path in the gate (today hard-denied — see README's
   "Key finding"), so the tool actually runs instead of always failing;
2. an escalation classifier that reasons about the patch's *targets*
   (deletions, credential paths, `.git/` internals, breadth) the way
   `isDestructiveCommand` reasons about shell text;
3. a diff-rendered approval prompt.

One call may contain edits to several files — the model expresses "make
these N changes" as N hunks in ONE tool call, charging ONE budget slot
instead of N.

## Users

- The keryx interactive agent itself (the primary "user" of the tool
  contract — schema, description, and error messages are written for a
  model, not a human).
- The human at the terminal approving `write` actions (TUI dock / readline
  prompt) — needs a diff they can actually read.
- keryx maintainers extending the approval gate / risk taxonomy later
  (`network`, `credential` are still hard-denied after this package and may
  want the same treatment eventually — out of scope here, but the gate
  extension should not make that harder).

## Requirements

### Functional

1. `apply_patch` accepts `{ patch: string }` — one or more concatenated
   unified-diff file sections (`--- a/path` / `+++ b/path` / `@@ ... @@`
   hunks), the same shape `git diff`/`git apply` already produce and consume.
2. Supports create (`--- /dev/null`), delete (`+++ /dev/null`), and modify.
3. Every target path is resolved and confined via the same
   `confineToRoot` used by `read_file`/`search_code` — a path that escapes
   the project root is rejected before anything is written, with a
   structured per-file error (not a partial apply).
4. Validates with `git apply --check` before writing anything; a patch that
   does not apply cleanly (wrong context, file changed since generation)
   fails closed with the git error surfaced to the model — never a partial
   write.
5. Multi-file patches apply atomically: if any file's hunk fails validation,
   nothing is written for the whole call.
6. Structured per-file result: `{ path, action: "create"|"modify"|"delete", ok, error? }[]`.

### Security / gating

7. `apply_patch` is `risk: "write"`. `GatedToolRisk`, `executeCall`, and
   `resolveApprovalDecision` are extended so `write` reaches the same
   approval machinery `shell`/`destructive` already use — default-deny with
   no approver, `ask`/`trust`/`auto` permission-mode semantics unchanged in
   shape.
8. A patch classifier (`write`'s analog of `isDestructiveCommand`) escalates
   to "ask even under `trust`" when: any file is deleted; any target path
   matches the existing `CREDENTIAL_MARKERS`/`touchesAgentCredentials`
   check; any target path is under `.git/`; or the patch touches more than
   a configurable file-count threshold in one call.
9. The credential-path floor is a hard floor exactly like
   `ApprovalGateInput.credentials` today — never auto-approved, not even
   under `auto` mode, matching `resolveApprovalDecision`'s existing
   `credentials || sacReviewConfirmation` short-circuit.
10. The approval prompt shows a real diff (reusing `classifyDiffLine`
    styling), not the raw patch text as an opaque blob.

### Non-functional

11. No new subprocess-execution surface beyond a fixed, non-shell argv call
    to `git apply` (mirrors `makeKeryxRunner`'s `Bun.spawn([...])` pattern) —
    no shell string is ever constructed from model input.
12. Deterministic, unit-testable: the classifier and path-confinement logic
    are pure functions over the parsed patch, independent of the `git apply`
    subprocess (which is mocked/injected in tests the same way
    `shell-exec-tool.test.ts` injects a command runner).

## Success Criteria

- A task that edits 5 files in one turn costs 1 non-read budget slot, not 5.
- `apply_patch` cannot write outside the project root under any input
  (property-style test with adversarial `../`, absolute, and symlink-escape
  paths, mirroring `confineToRoot`'s existing test coverage).
- A patch touching a credential-marker path is asked for under every
  permission mode, including `auto` (regression test asserting the hard
  floor holds for `write` the same way it holds for `shell`/`destructive`
  today).
- `bun test`/`typecheck` green; no change to `shell_exec`'s existing
  behavior, budget cost, or test expectations.

## Risks

| Risk | Mitigation |
|---|---|
| Extending the gate is itself a security-relevant change (new class of auto-approvable mutation) | P0 lands the gate extension alone, with its own focused test suite, before any patch-parsing code exists (see README's phased plan); write up as a real ADR before merging (mirrors ADR-0008/ADR-0009's own precedent for exactly this kind of gate change). |
| `git apply` requires the project root to be a git repository | Documented non-goal; a non-git root gets a clear, structured error from the tool, never a silent fallback to something less safe. |
| A model-crafted patch that *looks* safe in a truncated approval-UI diff but does something else | Diff rendering shows the full patch (no truncation of the approval view itself — truncation, if any, applies only to what's echoed back into the model's own transcript, same distinction `ApprovalMeta`/`requestApproval` already draw between "what the human sees" and "what the model sees"). |
| Classifier drift (new escalation rules needed later, e.g. touching `package.json`/lockfiles) | Same posture as `command-risk.ts`: "this list is an EXPEDIENT, not a boundary" — `confineToRoot` + git-apply's own strictness are the real boundary; the classifier only decides when to ask more insistently. |

## Recommendation

Proceed with the phased plan in README.md, starting with **P0 (gate
extension) as its own reviewable, ADR-backed change** before writing any
patch-parsing code. This sequencing means the riskiest part of the design —
"a new class of tool call that can now auto-approve under `trust`/`auto`" —
is validated in isolation, with its own tests, rather than bundled into a
larger PR where the gate change is easy to under-review next to the parser.
