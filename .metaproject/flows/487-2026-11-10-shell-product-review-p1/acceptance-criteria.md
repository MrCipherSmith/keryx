# Acceptance criteria

- AC1: Startup resume and interactive session switching load the same full stored model context, including messages before the last 200, and preserve the full archive through the next checkpoint. [verify: judged]
- AC2: A successful switch replaces the visible transcript with the destination session preview and resets outgoing block and usage state. A refused or cancelled switch keeps the original session surface. [verify: judged]
- AC3: Escape in the busy recipient picker restores the draft and makes no request to Side-1 or the main queue. Explicit recipients still work. [verify: judged]
- AC4: Escape interrupts an active provider stream in Agent and Chat when no overlay owns input. Both can take a follow-up prompt. Modal Escape keeps its local behavior. [verify: judged]
- AC5: Bare Enter and Escape on a shell command approval deny without running the command. Explicit Allow once runs it once. Readline remains default-deny. [verify: judged]
