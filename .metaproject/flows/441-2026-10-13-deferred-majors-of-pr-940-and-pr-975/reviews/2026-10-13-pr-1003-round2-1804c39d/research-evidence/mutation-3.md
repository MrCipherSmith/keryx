# Mutation pass

Command: `bun test src/tui/turn-loop.test.ts src/tui/busy-dispatch.test.ts src/tui/main-queue.test.ts src/tui/main-queue-drain.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-hold.test.ts src/tui/tui-bus.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 6902 ms). Run in a scratch copy; the worktree was not written.

Killed 2, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N16b-remote-paint-noop | src/tui/turn-loop.ts:80 | `nextId,     paint: deps.paint,` → `nextId,     paint: () => {},` | survived |
| N21-held-notice-banner-dropped | src/tui/tui-shell.ts:8626 | `${leaseView()?.banner() ?? "held"} — queued as q${position} (no side worker while held).` → `held — queued as q${position} (no side worker while held).` | survived |
| N22-held-busy-enqueue-no-return | src/tui/tui-shell.ts:8626 | `(no side worker while held).\n`);           return;` → `(no side worker while held).\n`);` | killed |
| N23-held-idle-enqueue-only-operator-dropped | src/tui/tui-shell.ts:9436 | `if (origin === "operator") {           const position = turnLoop.enqueue(line, displayLine, source);` → `if (true) {           const position = turnLoop.enqueue(line, displayLine, source);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
