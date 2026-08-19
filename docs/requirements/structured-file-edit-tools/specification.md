# Specification: Structured File-Edit Tools
Version: 0.3.0

## 1. Identity

- Tool name: `apply_patch`
- Location: `src/harness/tool/builtin/apply-patch-tool.ts` (new file,
  sibling of `shell-exec-tool.ts`, `interactive-tools.ts`)
- Registration: `buildInteractiveAgentTools`
  (`src/commands/interactive-agent-tools.ts`) — added to the array alongside
  `shellExecTool(input.cwd)`.
- Declared risk: `"write"` (new, currently-dead `ToolRisk` value — see §2).

## 2. Gate extension (P0 — lands before the tool exists)

### 2.1 `permission-mode.ts`

```ts
export type GatedToolRisk = "read" | "shell" | "destructive" | "delegate" | "write";
```

`ApprovalGateInput` gains no new fields — `destructive`, `credentials`, and
`sacReviewConfirmation` are reused as-is; `write`'s own classifier (§4)
populates `destructive`/`credentials` the same way the shell path populates
them from `isDestructiveCommand`/`touchesAgentCredentials`.

`resolveApprovalDecision` needs **no logic change** — its existing branches
already key off `destructive`/`credentials`/`mode`, not off `risk` directly,
except the `read` auto-allow check at the top. `write` falls through exactly
like `shell`/`destructive` does today: `ask` mode always asks; `trust` mode
auto-approves unless `destructive`; `auto` bypasses except the
`credentials`/`sacReviewConfirmation` hard floor. Update the function's doc
comment to say "every risk other than `read`" instead of enumerating
`shell`/`destructive`/`delegate`, since `write` now shares the same rule.

### 2.2 `agent.ts` — `executeCall`

Add a `write` branch, structurally identical to the `shell`/`destructive`
branch but sourcing `destructive`/`credentials` from the patch classifier
instead of `isDestructiveCommand`/`touchesAgentCredentials`:

```ts
} else if (risk === "write") {
  const patch = typeof input.patch === "string" ? input.patch : "";
  const { destructive, credentials } = classifyPatchRisk(patch, /* cwd */);
  const decision = resolveApprovalDecision({ mode, risk, destructive, credentials, sacReviewConfirmation: false });
  if (decision === "auto") {
    onAutoApproved?.(call.name, call.input, { destructive, credentials });
  } else {
    const fingerprint = toolCallHash(call.name, call.input);
    const response =
      requestApproval === undefined
        ? false
        : await requestApproval(call.name, call.input, { fingerprint, destructive, ...(credentials ? { credentials } : {}) });
    if (!isApprovalFor(response, fingerprint)) {
      return { output: `patch not approved by the user; not executed`, isError: true };
    }
  }
} else if (risk !== "read") {
```

The final `else if (risk !== "read")` branch is unchanged and continues to
hard-deny `network`/`credential` — this package touches only `write`.

`classifyPatchRisk` needs the tool's confined root to resolve target paths;
threading `cwd` through requires either (a) `executeCall` gaining a `cwd`
parameter (all call sites updated), or (b) the classifier re-deriving paths
from the *unparsed* patch text (matching `touchesAgentCredentials`'s own
"matched on text, not resolved path" posture, for consistency and to avoid
widening `executeCall`'s signature). **Recommendation: (b)** — text-level
matching is already this codebase's accepted trade-off for exactly this
kind of check (`command-risk.ts:255-259`'s own comment explains why), and it
keeps the gate extension a pure risk-branch addition with no signature
changes elsewhere.

### 2.3 New file: `src/lib/patch-risk.ts`

Mirrors `command-risk.ts`'s shape (pure functions, no I/O):

```ts
export interface PatchTarget {
  path: string;
  action: "create" | "modify" | "delete";
}

/** Parse a unified-diff patch into its per-file target list. Pure. */
export function parsePatchTargets(patch: string): PatchTarget[];

export interface PatchRiskClassification {
  destructive: boolean;
  credentials: boolean;
  reasons: string[]; // human-readable, surfaced in the approval prompt
}

/**
 * `write`'s analog of `isDestructiveCommand`/`touchesAgentCredentials`.
 * `destructive` escalates (never blocks on its own — same ADR-0009 posture)
 * when any target is deleted, touches `.git/`, or the patch exceeds
 * MAX_FILES_BEFORE_ESCALATION (default 8) distinct targets in one call.
 * `credentials` reuses touchesAgentCredentials against the joined target
 * path list — same markers, same "matched on text" trade-off.
 */
export function classifyPatchRisk(patch: string): PatchRiskClassification;
```

## 3. `apply_patch` tool (P1)

### 3.1 Input schema

```json
{
  "type": "object",
  "properties": {
    "patch": { "type": "string" }
  },
  "required": ["patch"],
  "additionalProperties": false
}
```

`patch` is one or more concatenated unified-diff file sections. Multi-file
convention is exactly `git diff`'s: each file section starts with
`--- a/<path>` / `+++ b/<path>` (or `/dev/null` on either side for
create/delete) followed by one or more `@@ -l,s +l,s @@` hunks.

### 3.2 Output (per-file, never a single pass/fail blob)

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "action": { "type": "string", "enum": ["create", "modify", "delete"] },
          "ok": { "type": "boolean" },
          "error": { "type": "string" }
        },
        "required": ["path", "action", "ok"]
      }
    },
    "applied": { "type": "boolean" }
  },
  "required": ["results", "applied"]
}
```

`applied: false` means the WHOLE patch was rejected (validation failed) and
`results` explains why per file — never a state where some files in the
same call were written and others weren't (requirement PRD §5).

### 3.3 Execution algorithm

1. Parse target paths (`parsePatchTargets`); confine every path via the same
   `confineToRoot` helper `interactive-tools.ts` exports — a single escaping
   path fails the WHOLE call before any subprocess runs (`applied: false`,
   per-file `error: "path escapes the project root"` on the offending
   entry, `ok: false` on all entries — nothing partially applied).
2. Reject (structured error, `applied: false`) if `cwd` is not inside a git
   work tree (`git rev-parse --is-inside-work-tree`, same detection
   `shell-exec-tool.ts` already needs for other checks) — see PRD's non-goal.
3. `Bun.spawn(["git", "apply", "--check", "-p1"], { cwd, stdin: patch })` —
   dry-run validate. Non-zero exit → `applied: false`, git's stderr surfaced
   per-file where attributable, else as a top-level error on every entry.
4. `Bun.spawn(["git", "apply", "-p1"], { cwd, stdin: patch })` — apply for
   real. Same argv-array-only invocation pattern as `makeKeryxRunner`
   (`metaproject-tools.ts:77-99`) — the patch travels over **stdin**, never
   as a shell-interpolated argument, so there is no metacharacter-injection
   surface analogous to `shell_exec`'s.
5. Build `results` from the parsed target list; `ok: true` for every entry
   when step 4 exits 0.

No custom hunk-matching code is written for this package — `git apply`'s own
context-matching (and its "fails closed on ambiguity" default) is the
correctness boundary, same rationale PRD's Risks table gives.

### 3.4 Description text (model-facing)

> Apply a unified diff (the same format `git diff` produces) to one or more
> files in the project. Input: `{ patch: string }`. Supports creating
> (`--- /dev/null`), deleting (`+++ /dev/null`), and modifying files. Prefer
> ONE `apply_patch` call with all the hunks for this turn's edits over
> several small calls — each call is one budget slot regardless of how many
> files/hunks it contains. Requires the user's explicit approval before it
> writes anything.

## 4. Approval UI (P2)

`ApprovalMeta`/`requestApproval` (`agent.ts`) are unchanged in shape — the
`input` string passed to `requestApproval` is still the raw JSON tool input,
which already contains the full patch text. The rendering layer (TUI dock,
readline prompt) gains a `write`-risk case that:

1. Extracts `input.patch` (same parse `parseShellExecCommand` does for
   `shell_exec`'s command — `shell-permissions.ts:439` is the precedent).
2. Splits it into lines, classifies each with `classifyDiffLine`
   (`src/lib/md-blocks.ts:116`), and renders with the same
   add/del/hunk/meta styling already used for diff code blocks in chat
   markdown — no new color/style vocabulary invented.
3. Shows the FULL patch (no truncation) in the approval view specifically —
   truncation policy for what re-enters the model's own transcript is
   separate and unaffected (PRD Risks table).

No "always allow" pattern mechanic is added in this phase (README non-goals)
— the picker offers approve/deny only, matching `shell_exec`'s baseline
before its own "remember" feature existed.

## 5. Integration points (files touched)

| File | Change |
|---|---|
| `src/harness/tool/types.ts` | none — `"write"` already exists in `ToolRisk` |
| `src/commands/permission-mode.ts` | `GatedToolRisk` gains `"write"`; doc comment update |
| `src/commands/agent.ts` | new `write` branch in `executeCall`; import `classifyPatchRisk` |
| `src/lib/patch-risk.ts` | **new** — `parsePatchTargets`, `classifyPatchRisk` |
| `src/lib/patch-risk.test.ts` | **new** — pure-function unit tests |
| `src/harness/tool/builtin/apply-patch-tool.ts` | **new** — the tool itself |
| `src/harness/tool/builtin/apply-patch-tool.test.ts` | **new** — injected `git apply` runner, same DI pattern as `shell-exec-tool.test.ts` |
| `src/commands/interactive-agent-tools.ts` | register `applyPatchTool(input.cwd)` |
| `src/commands/interactive-agent-tools.test.ts` | update the fixed tool-name-list assertion (same pattern as the `flow_status` addition) |
| `src/commands/shell.ts` (readline `requestApproval`) | `apply_patch` branch: `renderDiff`-rendered patch, destructive/credential hints |
| `src/tui/tui-shell.ts` (TUI `requestApproval`) | `apply_patch` branch: per-line `classifyDiffLine` + `otui` coloring, same hints |
| `src/commands/agent.ts` `buildAgentSystemInstruction` | mention `apply_patch`, steer away from `shell_exec` for edits (P3) |

## 6. Acceptance criteria

- [ ] `GatedToolRisk`/`resolveApprovalDecision` tests: `write` behaves
      identically to `shell`/`destructive` under `ask`/`trust`/`auto`,
      including the `credentials` hard floor under `auto`.
- [ ] `executeCall` denies `apply_patch` with no approver present
      (default-deny), matching `shell`'s existing test.
- [ ] `parsePatchTargets`: create/modify/delete detection, multi-file
      patches, malformed input → empty/error, not a throw.
- [ ] `classifyPatchRisk`: delete → `destructive`; credential-marker path →
      `credentials`; N+1 files (N = threshold) → `destructive`; ordinary
      1-3 file modify → neither.
- [ ] `confineToRoot` escape attempt (`../`, absolute path, symlink escape)
      in any hunk → whole call rejected, `applied: false`, no file touched
      (assert via a before/after directory snapshot, same style as
      `p0-test-utils.ts`'s `assertP0Purity`).
- [ ] Multi-file patch where one file's hunk doesn't apply → `applied:
      false`, no file written (atomicity).
- [ ] A 5-file, single-call `apply_patch` costs exactly 1 unique non-read
      budget slot (integration test against `runAgentTurn`'s budget
      accounting, mirroring the existing `reserveToolAttempt` tests in
      `agent.test.ts`).
- [ ] `bun run typecheck` and the full existing suite stay green; no
      assertion about `shell_exec`'s risk, budget, or approval behavior
      changes.

## 7. ADR

Landed as
[ADR-0010: `write` risk joins the interactive-shell approval gate](../../decisions/keryx-harness/ADR-0010-write-risk-approval-gate.md),
mirroring ADR-0008/ADR-0009's structure: why `write` was previously excluded
(the gate's original four-class design), why it's safe to add now (same
approval machinery, same hard floors, an escalation classifier with the same
"never blocks on its own" posture as `isDestructiveCommand`), and what
remains deliberately out of scope (`network`, `credential` risk classes stay
hard-denied).

## 8. Implementation status (P0/P1/P3)

| §2/§3 item | File | Status |
|---|---|---|
| `GatedToolRisk` gains `"write"` | `src/commands/permission-mode.ts` | done |
| `executeCall`'s `write` branch | `src/commands/agent.ts` | done |
| `parsePatchTargets`/`classifyPatchRisk` | `src/lib/patch-risk.ts` | done, unit-tested (`patch-risk.test.ts`) |
| `apply_patch` tool | `src/harness/tool/builtin/apply-patch-tool.ts` | done, unit + real-`git`-subprocess tested (`apply-patch-tool.test.ts`) |
| Tool registration | `src/commands/interactive-agent-tools.ts` | done |
| System-prompt steering (P3) | `src/commands/agent.ts` (`buildAgentSystemInstruction`) | done |
| §4 diff-preview approval UI (P2) | `src/commands/shell.ts` (readline), `src/tui/tui-shell.ts` (TUI) | done — both branch on `tool === "apply_patch"` before falling through to the shell-command approval path; `extractPatchText` (`src/lib/patch-risk.ts`) replaces `parseShellExecCommand` for this tool |

Deviation from §3.3 step 2 as originally specified: the pre-check "is `cwd` a
git work tree" step was dropped. `git apply` does not itself require a `.git`
directory to validate/apply a patch against files that exist relative to
`cwd`, so the extra check would have added a false constraint not present in
`git apply`'s actual behavior. The tool's error surface (a failed `git apply
--check`) already covers the cases where this would matter in practice.
