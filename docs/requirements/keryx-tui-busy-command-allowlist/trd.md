# TRD: TUI Busy-State Command Allowlist

Grounds `prd.md` against the current shape of `src/tui/tui-shell.ts` (re-read
2026-08-19; PRD/README line numbers were from an earlier pass and have
drifted slightly — this TRD uses freshly confirmed line numbers throughout).

## 1. Architecture

### 1.1 Location and current shape of the busy branch

`runLine(line: string): void` starts at `src/tui/tui-shell.ts:3006`. The busy
branch is `if (chrome.isBusy()) { ... }` at `tui-shell.ts:3019-3097` (confirmed
current; PRD's `3019-3097` estimate was accurate). Inside it, in order:

1. `const command = findAgentCommand(line, "agent");` (3020) — resolved once,
   reused by every arm below it.
2. `/exit` (3021-3029), `/help` (3030-3043), `/interrupt` (3044-3052), `/queue`
   (3053-3076) — each an `if (command?.name === "/x") { ...; return; }` block.
3. `/status` and `/flows` (3077-3084) — these use a *different* matcher shape:
   `const isBusyReadonlyCommand = isSessionInfoCommand(line) || isFlowsCommand(line);`
   is computed once at 3014 (before the `isBusy()` check, so it's available
   whether or not the turn is busy), then re-checked per-command:
   ```ts
   if (isBusyReadonlyCommand && isSessionInfoCommand(line)) { showSessionInfo(); return; }
   if (isBusyReadonlyCommand && isFlowsCommand(line)) { showFlows(); return; }
   ```
4. The generic refusal (3086-3096): any remaining `command !== undefined` or
   any line starting with `/` prints the yellow "main is busy — command
   deferred" message and returns.

### 1.2 Idle-path handlers being reused (confirmed line numbers)

- `/think` (3304-3309), `/expand` (3310-3315), `/copy` (3332-3341) — all
  `command.name === "/x"` arms, further down in the same `runLine` body, past
  the `isBusy()` block's `return`.
- `/workspace` (3324-3327) and `/review` (3328-3331) — `isWorkspaceCommand(command.name)`
  / `isReviewCommand(command.name)` arms, same pattern as `isSessionInfoCommand`/
  `isFlowsCommand` two arms above them (3316-3323).
- All the functions these five arms call — `toggleNewestBlock` (a local wrapper
  at 1797: `const toggleNewestBlock = (kind?: string): BlockState | undefined => nav.toggleNewest(kind);`),
  `newestBlock` (1796), `copyBlock` (1798), `showWorkspace` (2447-2471),
  `showReview` (2472-...) — are declared as `const` bindings in the *same*
  enclosing closure as `runLine` itself (the body of `launchTuiAgentShell`,
  `tui-shell.ts:1422-`). All are declared **before** `runLine`'s definition
  (1422 < 1797/1798 < 2447/2472 < 3006), so they are already in lexical scope
  inside the busy branch with zero new plumbing — **confirms PRD FR-6's
  assumption holds exactly as stated, no gap found here.**
- `isWorkspaceCommand`/`isReviewCommand` both have the identical signature
  `(line: string): boolean` as `isSessionInfoCommand`/`isFlowsCommand`
  (`workspace-inspector.ts:43`, `review-inspector.ts:45` vs.
  `session-info.ts:89`, `flow-inspector.ts:35`) — so they slot into the exact
  same `isBusyReadonlyCommand`-style pattern already used for `/status`/`/flows`.

### 1.3 Resolved edit shape (recommended, no blocking gap found)

Add three new `command?.name === "/x"` arms **directly after the existing
`/queue` arm** (i.e. between line 3076's closing and line 3077's
`isBusyReadonlyCommand` check), body copied verbatim from the idle-path arms:

```ts
if (command?.name === "/think") {
  if (toggleNewestBlock("thought") === undefined) {
    io.onSystem?.("No reasoning yet.\n");
  }
  return;
}
if (command?.name === "/expand") {
  if (toggleNewestBlock("output") === undefined && toggleNewestBlock() === undefined) {
    io.onSystem?.("Nothing to expand — no tool output yet.\n");
  }
  return;
}
if (command?.name === "/copy") {
  const target = newestBlock();
  if (target === undefined || !copyBlock(target.id)) {
    io.onSystem?.("Nothing to copy yet.\n");
  }
  return;
}
```

Extend the existing `isBusyReadonlyCommand` constant at 3014 to also cover the
two new read-only-modal commands (keeps the single-source-of-truth comment at
3011-3013 true, rather than inventing a second combined-boolean):

```ts
const isBusyReadonlyCommand =
  isSessionInfoCommand(line) || isFlowsCommand(line) ||
  isWorkspaceCommand(line) || isReviewCommand(line);
```

Then add two more arms mirroring 3077-3084 exactly, placed immediately after
them:

```ts
if (isBusyReadonlyCommand && isWorkspaceCommand(line)) { showWorkspace(); return; }
if (isBusyReadonlyCommand && isReviewCommand(line)) { showReview(); return; }
```

This is a pure insertion — no existing line in the busy branch or the idle
branch is modified, no new state, no new imports (`isWorkspaceCommand`/
`isReviewCommand` are already imported at 68-69 for the idle path).

### 1.4 Duplication is the established pattern, not a smell

`showSessionInfo()`/`showFlows()` are already called from **two** separate
call sites — the busy arms (3077-3084) and the idle arms (3316-3323) — with
identical bodies. The same will now be true for `/think`/`/expand`/`/copy`/
`/workspace`/`/review`. This repo's existing convention for this exact
dispatcher is duplicated one-line dispatch arms per branch, not a shared
sub-dispatch table — FR-6 ("call the exact same functions") is satisfied by
matching this convention, not by refactoring it away. No shared-helper
extraction is in scope.

## 2. Tech Stack

No new dependencies, libraries, or runtime primitives. Same TypeScript/Bun +
`@opentui/core` stack already in use; the change is confined to
`src/tui/tui-shell.ts`.

## 3. Data Models

No new types, fields, or state. Reuses as-is:
- `BlockState`/`BlockRegistry` (`transcript-blocks.ts`) via the already-scoped
  `toggleNewestBlock`/`newestBlock`/`copyBlock` closures.
- `ShellChrome.isBusy()` (`shell-chrome.ts:297`) as the sole busy-state read.
- `openWorkspace`/`openReview`'s existing parameter shapes
  (`workspace-inspector.ts`, `review-inspector.ts`) via the unmodified
  `showWorkspace`/`showReview` closures.

## 4. API / Interaction Contracts

Per-command dispatch, all synchronous decisions inside `runLine`'s busy
branch (the async work inside `showWorkspace`/`showReview` is unchanged —
it's already wrapped in `void (async () => {...})()` today, identically for
`showFlows`):

| Command | Busy-branch matcher | Call | Idle-branch call (unchanged, for comparison) |
|---|---|---|---|
| `/think` | `command?.name === "/think"` | `toggleNewestBlock("thought")` | same, 3304-3309 |
| `/expand` | `command?.name === "/expand"` | `toggleNewestBlock("output")` → fallback `toggleNewestBlock()` | same, 3310-3315 |
| `/copy` | `command?.name === "/copy"` | `newestBlock()` + `copyBlock(id)` | same, 3332-3341 |
| `/workspace` | `isBusyReadonlyCommand && isWorkspaceCommand(line)` | `showWorkspace()` | same, 3324-3327 |
| `/review` | `isBusyReadonlyCommand && isReviewCommand(line)` | `showReview()` | same, 3328-3331 |

No return-value or output-format change versus the idle path — same system
messages (`"No reasoning yet.\n"`, `"Nothing to expand — no tool output
yet.\n"`, `"Nothing to copy yet.\n"`) on the empty-state branches, same modal
on `/workspace`/`/review`. FR-8 ("document any busy-vs-idle difference") does
not apply — there is no behavioral difference to document; every one of the
five commands does exactly what it already does when idle.

## 5. Non-Functional Requirements

- Matches PRD NFR-1..NFR-3 with no additional technical constraint: single
  insertion point, no new synchronization, no change to
  `createBlockNavController`'s existing (already busy-safe) `Ctrl+O` path.
- NFR-3's "best-effort newest-block targeting" concurrency argument is
  unchanged from the PRD/README — confirmed still accurate: `addBlock`
  (3-arg version wired via `attachBlockIo`, `tui-shell.ts:456-503`) and
  `toggleNewestBlock`/`newestBlock`/`copyBlock` all run synchronously on the
  same event loop; no data race, only the pre-existing "which block is
  'newest' at this exact tick" semantic behavior already accepted for
  `Ctrl+O`.

## 6. Integration Points

None beyond the existing internal call graph already described in §1.2 — no
external service, no other module boundary crossed. `openWorkspace`/
`openReview` already coordinate with `chrome`'s overlay arbitration
internally (same mechanism `openFlows` already uses safely from the busy
branch today); this change adds no new modal-stacking logic, it only makes an
already-safe call reachable from one more branch.

## 7. Deployment Notes

No migration, no config/env var, no rollout gate — a synchronous code change
shipped in the next normal release, same as prior small TUI PRs in this repo
(flow 169/170/171 precedent).

---

## TRD-level finding: no existing test harness covers `runLine`'s dispatch (busy or idle)

This corrects an assumption in `prd.md`'s Verification section ("extend
whatever test file already covers this, if one exists").

**What was checked:** every `*.test.ts` file under `src/tui/` was searched for
references to `runLine` — **zero matches anywhere** (confirmed via `rg
runLine src/`, only non-test hits are inside `tui-shell.ts`/`chat-shell.ts`
themselves). `src/tui/tui-shell.test.ts` (88KB, the largest test file in the
directory) has no `isBusy`/`startBusy`/"main is busy"/"command deferred"
references either — the string `busy` appears exactly once, in a comment, not
a test. This means **none** of the busy branch's existing six commands
(`/exit`, `/help`, `/interrupt`, `/queue`, `/status`, `/flows`) has a dispatch-
level test today, not just the five new ones this PRD adds.

What *is* tested, separately and at a lower level, and remains unaffected by
this change:
- The command-name matchers themselves: `isSessionInfoCommand`
  (`session-info.test.ts`), `isFlowsCommand` (`flow-inspector.test.ts`),
  `isWorkspaceCommand` (`workspace-inspector.test.ts`), `isReviewCommand`
  (`review-inspector.test.ts`).
- The block-registry mechanics `/think`/`/expand`/`/copy` ultimately call:
  `toggleNewest`/`setCollapsed`/`copy` are covered via `mountBlockHarness` in
  `tui-shell.test.ts` (e.g. the AC6 test at `tui-shell.test.ts:1636`) and in
  `transcript-blocks.test.ts` — but that harness mounts only the block-wiring
  subsystem (`registry`/`nav`/a bare `BoxRenderable` transcript), it does not
  construct a `chrome`, does not call `launchTuiAgentShell`, and has no
  `runLine` in scope at all.

**Root cause:** `runLine` and every closure it reads (`chrome`, `nav`,
`showWorkspace`, `showReview`, etc.) live inside `launchTuiAgentShell`
(`tui-shell.ts:1422`), the single exported entry point that mounts the real
interactive shell end-to-end (real OpenTUI renderer, real IO loop). There is
no smaller exported seam that exposes `runLine` or `chrome` for direct
testing — `mountBlockHarness` exists precisely *because* the block-nav
subsystem needed one and none was available for the full shell.

**Resolution (scoped to this PRD, not a blocker):** Building a new
`launchTuiAgentShell`-level test harness (mocking IO, stdin driving, a fake
agent turn to flip `chrome.isBusy()`) is a genuinely separate, larger
infrastructure task — it would itself be new test architecture, which PRD
§8's Constraints already rule out adding as part of this change ("must reuse
`runLine`'s existing busy-branch structure... not a new dispatch mechanism").
It is also disproportionate: the six *existing* busy-branch commands shipped
and have run in production without this kind of test, so requiring one only
for the five new arms would be an inconsistent, ad hoc bar.

Verification for this PRD is therefore **manual/smoke-only**, matching the
existing precedent exactly: run the TUI, start a long-running turn, and
confirm each of `/think`, `/expand`, `/copy`, `/workspace`, `/review` behaves
identically to its idle-state behavior while the turn is in flight, and
confirm an out-of-scope command (e.g. `/model`) still shows the deferred
message. PRD's NFR-4 ("existing tests... must continue to pass unmodified")
is vacuously satisfied — there are none to update.

If dispatch-level test coverage for `runLine` as a whole is wanted later,
that's a legitimate follow-up (extract `runLine`'s dispatch into an
independently-testable pure function/table), but it is out of scope here and
should be raised as a separate PRD if the operator wants it, not folded into
this one.

---

## 8. Addendum: Test Coverage Design (2026-08-19, operator request)

**Supersedes the "manual/smoke-only" resolution above.** The operator
explicitly asked for the busy-branch dispatch to be covered by tests,
confirming the "legitimate follow-up" the finding above anticipated. This
section resolves the exact "how."

### Design: extract the decision, not the side effects

New file `src/tui/busy-dispatch.ts`, zero dependencies on `@opentui/core` or
any renderer/chrome type — plain strings and booleans in, a discriminated
union out:

```ts
export type BusyDispatchTarget =
  | "exit" | "help" | "interrupt" | "queue"
  | "session-info" | "flows" | "workspace" | "review"
  | "think" | "expand" | "copy"
  | "deferred" | "not-a-command";

export function classifyBusyDispatch(params: {
  line: string;
  commandName: string | undefined;
  isSessionInfo: boolean;
  isFlows: boolean;
  isWorkspace: boolean;
  isReview: boolean;
}): BusyDispatchTarget {
  const { line, commandName, isSessionInfo, isFlows, isWorkspace, isReview } = params;
  if (commandName === "/exit") return "exit";
  if (commandName === "/help") return "help";
  if (commandName === "/interrupt") return "interrupt";
  if (commandName === "/queue") return "queue";
  if (commandName === "/think") return "think";
  if (commandName === "/expand") return "expand";
  if (commandName === "/copy") return "copy";
  const isBusyReadonlyCommand = isSessionInfo || isFlows || isWorkspace || isReview;
  if (isBusyReadonlyCommand && isSessionInfo) return "session-info";
  if (isBusyReadonlyCommand && isFlows) return "flows";
  if (isBusyReadonlyCommand && isWorkspace) return "workspace";
  if (isBusyReadonlyCommand && isReview) return "review";
  if (commandName !== undefined || line.startsWith("/")) return "deferred";
  return "not-a-command";
}
```

The order of the `if` chain preserves `runLine`'s exact current precedence
(`/exit`/`/help`/`/interrupt`/`/queue` before the readonly group, matching
today's 3021-3076 vs. 3077-3084 ordering; the new `/think`/`/expand`/`/copy`
arms are placed with the first group per §1.3's insertion point). This is a
straight transcription of the existing `if`-chain's conditions into a
returned tag — no new business logic, only a new seam.

### `runLine`'s busy branch becomes a thin switch over the decision

```ts
const decision = classifyBusyDispatch({
  line,
  commandName: command?.name,
  isSessionInfo: isSessionInfoCommand(line),
  isFlows: isFlowsCommand(line),
  isWorkspace: isWorkspaceCommand(line),
  isReview: isReviewCommand(line),
});
switch (decision) {
  case "exit": /* existing /exit body, unchanged */ break;
  case "help": /* existing /help body, unchanged */ break;
  case "interrupt": /* existing /interrupt body, unchanged */ break;
  case "queue": /* existing /queue body, unchanged */ break;
  case "think": /* toggleNewestBlock("thought") body from §1.3 */ break;
  case "expand": /* toggleNewestBlock("output") body from §1.3 */ break;
  case "copy": /* newestBlock/copyBlock body from §1.3 */ break;
  case "session-info": showSessionInfo(); break;
  case "flows": showFlows(); break;
  case "workspace": showWorkspace(); break;
  case "review": showReview(); break;
  case "deferred": /* existing yellow "command deferred" TextRenderable, unchanged */ break;
  case "not-a-command": break; // falls through to the existing recipient-selector code below
}
if (decision !== "not-a-command") {
  return;
}
```

Every arm's *body* is copied verbatim from what it already is today (§1.3 for
the five new ones; the untouched existing code for the six pre-existing
ones) — this is a mechanical reshaping of the dispatch (`if`-chain →
`classifyBusyDispatch` + `switch`), not new logic. FR-6/FR-7's "call the
exact same functions" guarantee is preserved by construction.

### Tests: `src/tui/busy-dispatch.test.ts`

One `test()` per `BusyDispatchTarget` value (13 cases: 11 named commands +
`deferred` + `not-a-command`), each constructing the `params` object a real
call site would produce and asserting the returned tag — e.g. the `/model`
case asserts `classifyBusyDispatch({ line: "/model", commandName: "/model",
isSessionInfo: false, isFlows: false, isWorkspace: false, isReview: false })
=== "deferred"`. No renderer, no `chrome`, no `@opentui/core` import — pure
unit tests, matching PRD NFR-5.

This does **not** test that `runLine` actually wires each case to the right
side-effecting call (that would require the full-shell harness the original
finding above said was disproportionate, and still is) — it tests that the
*decision* is correct for every input class. Combined with the fact that
each `switch` arm's body is a verbatim, one-line-away copy of already-shipped
code (six of eleven arms are literally unmodified from before this PRD), the
residual risk of a decision being correct but wired to the wrong handler is
low and is caught by the manual/smoke pass already planned in PRD §11/AC1-7.

### Scope boundary (unchanged from the original finding)

This is still not "build a `launchTuiAgentShell` test harness" — that
remains out of scope, for the same reason as before (disproportionate,
would itself be new test infrastructure). The extraction above is scoped
narrowly enough that it doesn't need one.
