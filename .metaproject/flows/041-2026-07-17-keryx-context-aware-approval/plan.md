# Implementation Plan

Status: formalized

## Approach

Advisory, agent-side context: a MetaprojectPort-backed helper builds a short
context line shown before the shell_exec [y/N] prompt. The default-deny gate and
the frozen harness policy engine are untouched. TDD via task-implementer.

## Steps

1. NEW `src/commands/agent-approval-context.ts`: `buildApprovalContext(port, command)`
   — token-scan the command for file paths; graphAffected(first resolvable) →
   blast-radius; memorySearch(command) → top note; compose a dim one/two-line
   string; empty on nothing/error (never throws).
2. `src/commands/shell.ts`: pass the MetaprojectPort into runAgentRepl; in
   `requestApproval`, await buildApprovalContext and print it before `[y/N]`.
3. Tests (injected fake port): command with a project file → blast-radius line;
   memory hit → note line; plain command / port error → empty; never throws.

## Risks

- Latency in the approval path — the helper is best-effort and bounded; a port
  error yields empty context, never blocking approval.
- Scope discipline — advisory only; do NOT change allow/deny outcomes or the
  policy engine.
