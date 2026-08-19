# TRD: Busy-State /mode Command

Grounds `prd.md` against the current shape of `src/tui/tui-shell.ts` and
`src/tui/busy-dispatch.ts` (re-read 2026-08-19, post-flow-172).

## 1. Architecture

### 1.1 Current shape (confirmed exact line numbers)

The busy branch (`tui-shell.ts:3172-3296`) computes a `decision` via
`classifyBusyDispatch()` (`tui-shell.ts:3177-3184`) and `switch`es on it
(`tui-shell.ts:3185-3296`). `BusyDispatchTarget` is currently `"exit" |
"help" | "interrupt" | "queue" | "session-info" | "flows" | "workspace" |
"review" | "think" | "expand" | "copy" | "deferred" | "not-a-command"`
(`busy-dispatch.ts:12-25`).

`/mode`'s ENTIRE current logic — `applyMode`, the `clear` branch, and the
no-arg picker — lives inline inside `if (command.name === "/mode") { ... }`
at `tui-shell.ts:3569-3644`, in the idle-path section further down in the
same function, past the busy branch's `switch`. Unlike `showWorkspace`/
`showReview` (`tui-shell.ts:2447-2471`, `const` bindings declared BEFORE
`runLine`, already reusable from the busy branch with zero plumbing), `/mode`
has no equivalent standalone, hoisted function — it's authored as a one-shot
inline block.

### 1.2 Resolved shape: hoist `/mode`'s logic into a `const` beside `showWorkspace`/`showReview`

Extract the `/mode` block's body verbatim into a new function with the same
declaration pattern as `showWorkspace`/`showReview`
(`tui-shell.ts:2447-2471`, i.e. declared earlier in `launchTuiAgentShell`'s
body, before `runLine`, so it's in lexical scope for both branches with zero
new plumbing):

```ts
const runModeCommand = (line: string): void => {
  const modeArgs = line.trim().split(/\s+/).slice(1).filter((p) => p.length > 0);
  const wanted = modeArgs[0] ?? "";
  const saveFlag = modeArgs.includes("save");

  const applyMode = async (next: PermissionMode): Promise<void> => {
    if (next === "auto") {
      chrome.hideMenu();
      const confirmId = await chrome.withOverlay(() =>
        showComposerChoice(otui, r, chrome.dock, {
          title: "Switch to auto mode?",
          subtitle:
            "Skips confirmation for EVERY action, including destructive commands. " +
            "Only credential-touching commands still ask.",
          cancelId: "cancel",
          options: [
            { id: "confirm", label: "Confirm", description: "I understand the risk" },
            { id: "cancel", label: "Cancel", description: "Keep the current mode", recommended: true },
          ],
        }),
      );
      input.focus();
      if (confirmId !== "confirm") {
        chrome.showToast("Cancelled — mode unchanged.");
        return;
      }
    }
    permissionMode = next;
    chrome.showToast(`Permission mode: ${next}`);
    if (saveFlag) {
      const saved = setProjectPermissionMode(sessionCwd, next);
      chrome.showToast(saved ? "Saved as this project's default." : "Could not save the project default.");
    }
  };

  if (wanted === "clear") {
    setProjectPermissionMode(sessionCwd, undefined);
    chrome.showToast(`Cleared project default. Session stays on: ${permissionMode}`);
    return;
  }
  if (wanted.length > 0) {
    if (!isPermissionMode(wanted)) {
      io.onSystem?.(`Unknown mode '${wanted}'. Choose one of: ${PERMISSION_MODES.join(", ")}\n`);
      return;
    }
    void applyMode(wanted);
    return;
  }
  const stored = getProjectPermissionMode(sessionCwd);
  chrome.hideMenu();
  void (async () => {
    const id = await chrome.withOverlay(() =>
      showComposerChoice(otui, r, chrome.dock, {
        title: `Permission mode (current: ${permissionMode})`,
        subtitle: stored !== undefined ? `Project default: ${stored}` : "No project default set.",
        cancelId: permissionMode,
        options: PERMISSION_MODES.map((m) => ({
          id: m,
          label: m,
          description: MODE_PICKER_DESCRIPTIONS[m],
          recommended: m === permissionMode,
        })),
      }),
    );
    input.focus();
    if (isPermissionMode(id) && id !== permissionMode) {
      await applyMode(id);
    }
  })();
};
```

Replace the idle-path block (`tui-shell.ts:3569-3644`) with:
```ts
if (command.name === "/mode") {
  runModeCommand(line);
  return;
}
```

This is a pure extraction — no behavior change to the idle path. `permissionMode`
(the closure `let`, `tui-shell.ts:2262`), `chrome`, `otui`, `r`, `input`,
`sessionCwd`, `io` are all already in the same enclosing closure as
`showWorkspace`/`showReview`, so `runModeCommand` needs no new parameters
beyond `line` — confirms PRD FR-4's "reuse verbatim" requirement holds
exactly, no gap found.

### 1.3 Busy-branch wiring

Add `"mode"` to `BusyDispatchTarget` (`busy-dispatch.ts:12-25`) and one more
`if (commandName === "/mode") return "mode";` arm in `classifyBusyDispatch`
(`busy-dispatch.ts:41-47` area, alongside the existing `/think`/`/expand`/
`/copy` literal-name checks — `/mode` needs no `isBusyReadonlyCommand`-style
matcher since, like those three, it's a direct `command?.name` literal
check, not a shared-matcher-function check like `/status`/`/flows`/
`/workspace`/`/review`).

Add one more `case` to the busy `switch` (`tui-shell.ts:3185-3296`), placed
alongside `think`/`expand`/`copy` (same "direct command, no shared external
matcher" family):

```ts
case "mode": {
  runModeCommand(line);
  return;
}
```

This satisfies FR-1/FR-2/FR-3 together — `runModeCommand` internally
branches on `clear` vs. an explicit mode vs. no-arg (§1.2), so ONE busy-branch
case covers all three PRD goals with zero additional dispatch complexity.

### 1.4 EC-2 resolved: overlay lifecycle vs. busy-state changing underneath it

`chrome.withOverlay()` (used by both the `auto`-confirmation and the no-arg
picker) is the SAME mechanism `showWorkspace`/`showReview`'s modals already
use while busy (confirmed: `openWorkspace`/`openReview` both call through
`chrome`'s overlay arbitration, same as `/mode`'s `showComposerChoice`
calls). `chrome.isBusy()` and `chrome.overlayActive()`/`withOverlay()` are
tracked as two INDEPENDENT pieces of `ShellChrome` state (`shell-chrome.ts`
— `busy` flipped only by `startBusy`/`stopBusy`, overlay state flipped only
by `withOverlay`'s own open/close lifecycle) — one does not observe or react
to the other. So a running turn finishing (busy → not busy) while a `/mode`
overlay is still open behaves identically to `/workspace`/`/review`'s
already-shipped busy-safe overlays in the same situation: the overlay stays
open, unaffected, until the operator resolves it (confirm/cancel/pick), same
as flow 172 already established. No new code needed for EC-2 — it inherits
flow 172's precedent by construction, not by a new check this TRD adds.

### 1.5 FR-7 resolved: no overlay adjustment needed

Because `/mode`'s overlays use the exact same `chrome.withOverlay`/
`showComposerChoice(otui, r, chrome.dock, {...})` call shape already
busy-safe for `/workspace`/`/review` (§1.4), no z-order/focus-timing
adjustment is needed — `input.focus()` after the overlay closes is already
present in `/mode`'s existing code (both branches, unchanged by the
extraction in §1.2) and behaves the same as it already does for the other
two commands' overlays today.

## 2. Tech Stack

No new dependencies. Same TypeScript/Bun + `@opentui/core` stack; change
confined to `src/tui/tui-shell.ts` and `src/tui/busy-dispatch.ts`.

## 3. Data Models

No new types or state. `PermissionMode`, `PERMISSION_MODES`,
`isPermissionMode`, `MODE_PICKER_DESCRIPTIONS` (all already imported/defined
where `/mode`'s block currently lives) are reused as-is by the hoisted
`runModeCommand`. `BusyDispatchTarget` gains one new string literal member,
`"mode"`.

## 4. API / Interaction Contracts

| Command form | Busy-branch matcher | Call |
|---|---|---|
| `/mode <ask\|trust\|auto>` | `command?.name === "/mode"` → `classifyBusyDispatch` returns `"mode"` | `runModeCommand(line)` → internally `applyMode(wanted)` |
| `/mode clear` | same | `runModeCommand(line)` → internally the `clear` branch |
| `/mode` (no arg) | same | `runModeCommand(line)` → internally the picker branch |

No return-value or output-format change versus the idle path — same toasts,
same overlay copy, same error message for an unknown mode argument.

## 5. Non-Functional Requirements

- Matches PRD NFR-1..NFR-4 with no additional technical constraint.
- NFR-3 ("observable on the very next tool call") is satisfied by
  construction, already proven in the README's investigation: `agent.ts:1985`
  reads `permissionMode?.()` fresh inside `executeCall()`, called per-call
  from `agent.ts:1481`/`1851` — this TRD's change doesn't touch that read
  path at all, it only makes the WRITE path (`runModeCommand`/`applyMode`)
  reachable while busy.

## 6. Integration Points

None beyond the existing internal call graph in §1.2-§1.3 — no external
service, no other module boundary crossed. `permission-mode.ts`'s exports
(`PermissionMode`, `PERMISSION_MODES`, `isPermissionMode`,
`DEFAULT_PERMISSION_MODE`) and `permission-mode-config.ts`'s
`setProjectPermissionMode`/`getProjectPermissionMode` are unchanged, just
called from one more reachable place.

## 7. Deployment Notes

No migration, no config/env var, no rollout gate — a synchronous code
change shipped in the next normal release, same as flow 172's precedent.

## 8. Test-coverage note (per flow 172's own established precedent)

Flow 172's TRD found `runLine`'s dispatch had zero pre-existing test
coverage and added `src/tui/busy-dispatch.test.ts` (13 cases, one per
`BusyDispatchTarget` value at the time) specifically to unit-test
`classifyBusyDispatch` without mounting any renderer. This PRD's FR-1..FR-3
are covered the same way: add ONE more case to that same test file
asserting `classifyBusyDispatch({commandName: "/mode", ...}) === "mode"`
(plus confirming `/model`, a real out-of-scope command with a similar name,
still resolves to `"deferred"` — an easy off-by-typo class of bug worth a
dedicated assertion given how close `"/mode"` and `"/model"` are as
strings). `runModeCommand`'s own internal branching (`clear`/explicit-mode/
no-arg picker) is already exercised by whatever existing test coverage
`/mode`'s idle-path handler has today (if any) — this TRD's extraction
(§1.2) does not change that logic, so no new tests are required for
`runModeCommand`'s internals, only for its new busy-branch reachability.
