# Pull request context: MrCipherSmith/keryx#978

Head 6824f7776244f3f4db81a488884231ffd45ad88b, collection round 1, collected 2026-10-12T20:16:22.021Z.

## Intent (round 1)

**feat(remote): Telegram relays approvals, questions and progress; close archives the topic (flow 419)**

## Summary

Flow 419: a shell with `/remote-control` can be run from Telegram alone.

- Every approval, `ask_user` question and queue dialog is mirrored to the topic with buttons, also for a turn typed in the shell. The first answer wins from either side and closes the other once (`prompt-close`). (AC1, AC2)
- An unanswered question gets a reminder every 2 minutes, at most 3. (AC3)
- `/route` joins the topic menu. `/route`, `/external`, `/external-agents` and `/model` are queued with a notice while main is busy and run when it goes idle; `/mode` takes effect at once. (AC4)
- Progress notes at subagent wave boundaries and after tool-heavy stretches, at most one a minute, counts and names only. (AC5)
- A short status question is answered from session state while the turn runs, never queued. (AC6)
- Closing the shell archives the topic (closing note, history stays readable) instead of deleting it; a killed shell is archived after the orphan window. (AC7)
- Docs: README, guide (new "What the topic hears" and "What happens when the shell closes"), CLI reference, wiki page, CHANGELOG. `mkdocs build --strict` passes locally. (AC9)

## Evidence

| AC | Tests |
|----|-------|
| AC1, AC2 | `src/remote/approval-mirror.test.ts`, `src/tui/approval-mirror.test.ts` |
| AC3 | `src/remote/prompt-reminder.test.ts` |
| AC4 | `src/remote/command-queued.test.ts`, `command-gateway` and `command-model` tests |
| AC5, AC6 | `src/remote/progress-notes.test.ts`, `src/tui/remote-queue-wiring.test.ts` |
| AC7 | `src/remote/lifecycle.test.ts`, `src/remote/orphan.test.ts` |

Targeted run: `src/remote`, `remote-queue-wiring`, `approval-mirror` — 1331 pass, 0 fail; `tsc --noEmit` clean. Full suite is left to CI.

## Not done

AC8 (a long review completed from Telegram only, with the topic's message log) needs the operator; the steps are in the flow's `plan.md`. Everything here was tested against a fake Bot API.

## Known limits

- Progress notes are driven by tool calls and subagent events only; a long silent model step produces none.
- Status questions are matched by a short en/ru phrase list; anything else is work.
- Intervals (reminder 2 min, progress 1 min) are fixed defaults, not settings.

## CI: passing

- deploy to GitHub Pages: skipped
- standard-pr: passing
- opentui native (darwin-arm64): passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- opentui native (linux-arm64): passing
- dependency-audit: passing
- typecheck-and-tests: passing
- client matrix (cancel-resume): passing
- client matrix (runtime): passing
- standard-baseline: passing
- AC8 full suite (5000 ms, preload): passing
- vscode-extension: passing
- opentui native (darwin-x64): passing
- linux sandbox (bubblewrap) live smoke: passing
- opentui native (linux-x64): passing
- wiki validate (gate) + freshness (report): passing
- client matrix (streaming): passing
- client matrix (terminal): passing
- metrics-contract: passing
- mkdocs build --strict: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

