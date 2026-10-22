# Pull request context: MrCipherSmith/keryx#1074

Head 2e1936eeb9760e1bbfb05500bd7479c37d44ba80, collection round 1, collected 2026-10-22T16:17:03.775Z.

## Intent (round 1)

**feat: one /connect modal with Connected and Add provider tabs**

## Summary
- `/connect` is the only command: one "Providers" modal with two tabs. "Connected" is today's rows with [Test] and [Disconnect], plus an [Add provider] button. "Add provider" lists every known provider with [Connect] and [Test].
- [Connect] runs the base-URL, key or device-login steps, checks `/models`, returns to "Connected" and does not switch the session. With nothing connected the modal opens on "Add provider".
- `/provider` is removed (registry, menu, help, README, docs, init hint). Typing it answers with a hint to use `/connect`.
- Telegram `/connect` gains an "Add provider" button, a [Test] per provider, and [Connect] by device login only. A key is never typed in chat (flow 387 AC4).
- `modal-host` gets an optional `footerFor(tabId)` so the footer lists the keys of the active tab.

Flow 471. Operator decisions: polls 248 and 249 (Telegram message 219474).

## Test plan
- [x] `bun test` on connect-modal, connect-provider-buttons, agent-commands, help-groups, shell, modal-host, queue-nav, remote (1327 pass), provider-probe
- [x] `bunx tsc --noEmit -p .`
- [x] AC10 invariant: no `/provider` in README, docs/docs, src/standard, init.ts
- [ ] AC12 live run in a real `keryx shell` with an empty config dir (frames and config file mode go into the flow journal)
- [ ] Review round

## CI: passing

- deploy to GitHub Pages: skipped
- standard-pr: passing
- opentui native (linux-arm64): passing
- metrics-contract: passing
- opentui native (darwin-x64): passing
- opentui native (darwin-arm64): passing
- opentui native (linux-x64): passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- client matrix (runtime): passing
- client matrix (terminal): passing
- dependency-audit: passing
- standard-baseline: passing
- client matrix (cancel-resume): passing
- linux sandbox (bubblewrap) live smoke: passing
- client matrix (streaming): passing
- AC8 full suite (5000 ms, preload): passing
- typecheck-and-tests: passing
- wiki validate (gate) + freshness (report): passing
- vscode-extension: passing
- mkdocs build --strict: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

