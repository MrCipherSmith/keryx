# Pull request context: MrCipherSmith/keryx#1052

Head b1c6da0e6992e4df473bae6b2fde78bc94d28776, collection round 1, collected 2026-10-19T04:06:31.505Z.

## Intent (round 1)

**Operator review confirmations answered in Telegram (flow 464)**

## Summary
- A remote-card answer now records `pressedBy` and `pressedAt`; it is accepted only from an allowed user id, once, for one question, within 1 hour.
- New `review_complete` card (SHA, evidence level, waivers); `review_confirm_plan` and `review_decide_premise` answer through the card too.
- The card says when the Telegram mirror was not delivered; the terminal commands stay as fallback.
- TUI: pending and answered operator cards in the remote status tab, sidebar and `/decisions`.
- Docs: TM-04 section, review guides, cli-reference, review skills. `flow ac confirm` is unchanged (operator decision).

Flow 464, criteria AC1-AC10 (AC9 is the owner's live check from Telegram, AC10 the release).

## Test plan
- [ ] CI green
- [ ] `bun test src/commands/operator-confirm-tools.test.ts src/commands/operator-confirm-review-tools.test.ts src/remote/ src/tui/`
- [ ] Owner live check from the Telegram topic

## CI: passing

- deploy to GitHub Pages: skipped
- standard-pr: passing
- opentui native (darwin-arm64): passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- opentui native (darwin-x64): passing
- opentui native (linux-arm64): passing
- typecheck-and-tests: passing
- client matrix (terminal): passing
- client matrix (runtime): passing
- standard-baseline: passing
- dependency-audit: passing
- metrics-contract: passing
- client matrix (cancel-resume): passing
- linux sandbox (bubblewrap) live smoke: passing
- opentui native (linux-x64): passing
- client matrix (streaming): passing
- AC8 full suite (5000 ms, preload): passing
- wiki validate (gate) + freshness (report): passing
- vscode-extension: passing
- mkdocs build --strict: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

