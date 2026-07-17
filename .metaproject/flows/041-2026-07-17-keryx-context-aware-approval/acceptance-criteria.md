# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/commands/agent-approval-context.ts` exports `buildApprovalContext(port: MetaprojectPort, command: string): Promise<string>` that extracts file-like token(s) from `command`, calls `port.graphAffected` for the first and includes a blast-radius summary (e.g. "affects N file(s)") when there are dependents, and calls `port.memorySearch(command)` including the top related note when there is a hit; it returns a SHORT string (empty when nothing relevant), is best-effort, and NEVER throws (a port error yields an empty/partial string). Deterministic given the injected port.
- AC2: The agent REPL (`runAgentRepl` in src/commands/shell.ts) passes a `MetaprojectPort` and, in `requestApproval`, awaits `buildApprovalContext(port, command)` and prints the non-empty context line(s) BEFORE the `Run <cmd>? [y/N]` prompt. The default-deny approval gate and its outcomes are UNCHANGED (context is advisory; a false/absent answer still denies; no execution without a typed `y`).
- AC3: The harness policy engine (`src/harness/policy/`) and `PolicyContext` are NOT modified; no allowed/denied outcome anywhere changes; no mutating tool is introduced.
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1418 pass / 3 skip / 0 fail with new tests green and 0 fail; OFFLINE/deterministic (injected fake port; no subprocess/graph/network in tests); `dependencies` REMAINS `{}`; the flow-036 approval gate, the chat core, and the flow-037/038/039/040 surfaces are unchanged. Unit tests cover: a command referencing a project file yields a blast-radius line; a memory hit yields a note line; a plain command and a port error yield empty context without throwing.
