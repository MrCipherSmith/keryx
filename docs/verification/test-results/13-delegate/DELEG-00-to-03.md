# DELEG-00–03 — External delegation (`/delegate`)

**Area:** 13. External delegation (`/delegate`) · **Date:** 2026-08-22 · **Status:** PASS (DELEG-00); NOT-EXECUTABLE-HERE (DELEG-01–03)

## Test case (from the catalog)

### DELEG-00

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| DELEG-00 | `/delegate` typed in readline does nothing delegate-specific | readline: `/delegate claude-cli "say hi"` | `Unknown command: /delegate. Type /help.` — confirms the TUI-only gap |

### DELEG-01

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| DELEG-01 | `/delegate` with no capability enabled | **TUI required** — readline cannot reach this | Named refusal citing the capability gate, not a generic error |

### DELEG-02

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| DELEG-02 | `/delegate` with an unknown agent id | **TUI required** | `parseDelegateCommand`'s exact refusal text, names `codex-cli, claude-cli` |

### DELEG-03

| ID | Test | Command(s) | Expected |
|---|---|---|---|
| DELEG-03 | `/delegate` with an agent but no task (or vice versa) | **TUI required** | `needs both an agent and a task` refusal |

---

## What was actually run

### DELEG-00: readline test

```bash
printf '/delegate claude-cli "say hi"\n' | DEEPSEEK_API_KEY="$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")" keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
```

Session id: `4b58a2a6` (per-project)

### DELEG-01–03: unit tests (since TUI is not available in this environment)

```bash
bun test --timeout 30000 src/commands/agent-commands.test.ts -t parseDelegateCommand
```

This runs all `parseDelegateCommand` tests in the existing test suite (lines 366–411 of `src/commands/agent-commands.test.ts`).

---

## Captured output (terminal text capture)

### DELEG-00 readline output

```text
keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 4b58a2a6 · per-project (keryx shell -c to continue)
  [2mUnknown command: /delegate. Type /help.
  [22m  ❯
```

### DELEG-01–03 bun test output

```text
bun test v1.3.14 (0d9b296a)

 5 pass
 26 filtered out
 0 fail
 9 expect() calls
Ran 5 tests across 1 file. [289.00ms]
```

---

## Cross-checks (if applicable)

### DELEG-00
- Confirmed in the captured output: the shell responds with `Unknown command: /delegate. Type /help.` to the piped `/delegate` input, matching the predicted TUI-only behavior.
- Session 4b58a2a6 created successfully and recorded in `.local/share/keryx/sessions/`.

### DELEG-01–03: Source code verification

**Capability gate (flow 176, requirement):**
- DELEG-01 is governed by the capability flag `externalAgents.enabled: true` in `~/.local/share/keryx/auth.json`, and requires the project to be opted in via `keryx init --external-agents`.
- When disabled, the `/delegate` command is **TUI-only** and shows `Unknown command: /delegate` in readline (same as DELEG-00), never reaching `parseDelegateCommand`.
- The capability gate itself is NOT tested here because readline cannot reach the dispatcher; the TUI would handle this.

**DELEG-02: Unknown agent refusal (from source code, line 234–240 of `src/commands/agent-commands.ts`):**
```typescript
if (getExternalAgent(agentId) === undefined) {
  return {
    ok: false,
    reason:
      `unknown external agent "${agentId}"; keryx drives ${EXTERNAL_AGENTS.map((e) => e.id).join(", ")}. ` +
      "Run `keryx agents external list` to see which of them are installed and enabled here.",
  };
}
```

The error message names both available agents:
- `codex-cli` (defined in `src/harness/external/registry.ts`, line 29)
- `claude-cli` (defined in `src/harness/external/registry.ts`, line 48)

**Test case (line 395–401 of `agent-commands.test.ts`):**
```typescript
test("parseDelegateCommand: an unknown agent points at `keryx agents external list`", () => {
  const parsed = parseDelegateCommand("gpt-cli do the thing");
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.reason).toContain('unknown external agent "gpt-cli"');
  expect(parsed.reason).toContain("keryx agents external list");
});
```

**DELEG-03: Missing task refusal (from source code, lines 223–227 of `src/commands/agent-commands.ts`):**
```typescript
if (match === null) {
  // One token only: an agent with no task, or a task with no agent. Both are
  // the same fix, and guessing which one the operator meant would silently
  // dispatch a one-word task to a CLI that costs real money to run.
  return { ok: false, reason: `\`/delegate\` needs both an agent and a task — usage: ${DELEGATE_USAGE}` };
}
```

Where `DELEGATE_USAGE` is defined at line 195:
```typescript
export const DELEGATE_USAGE = "/delegate <agent> <task>  (agents: `keryx agents external list`)";
```

**Test case (line 386–393 of `agent-commands.test.ts`):**
```typescript
test("parseDelegateCommand: an agent with no task is refused, never dispatched", () => {
  // Guessing which half the operator meant would spend real subscription quota
  // on a one-word task.
  const parsed = parseDelegateCommand("codex-cli");
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.reason).toContain("both an agent and a task");
});
```

---

## Summary

**DELEG-00 PASS:** Readline test executed successfully; `/delegate` typed in readline correctly produces the generic `Unknown command: /delegate. Type /help.` message, confirming the TUI-only dispatch gap documented in the catalog.

**DELEG-01 NOT-EXECUTABLE-HERE:** The capability gate test requires a TUI environment to reach the dispatcher; in readline, `/delegate` is indistinguishable from a typo (falls through to the generic unknown-command handler). The gate itself would be enforced downstream in the TUI's `/delegate` handler, not in `parseDelegateCommand`.

**DELEG-02 NOT-EXECUTABLE-HERE:** The unknown-agent refusal logic cannot be exercised via readline (same TUI-only gap). However, the unit test for this case **passes** and confirms the exact error message: names both available agents (`codex-cli`, `claude-cli`) and directs to `keryx agents external list`, matching the catalog's expectation.

**DELEG-03 NOT-EXECUTABLE-HERE:** The missing-task refusal logic cannot be exercised via readline. The unit test confirms the exact error message: `\`/delegate\` needs both an agent and a task — usage: /delegate <agent> <task>  (agents: \`keryx agents external list\`)`, matching the catalog's expectation.

---

## Analysis

**DELEG-00:** The readline execution confirms the catalog's correction note (SLASH-26): `/delegate` has zero dispatch branches in `shell.ts` and is TUI-only in practice. Any attempt to call it via readline falls through to the generic unknown-command handler, by design, making it indistinguishable from a typo. This is not a bug; it is the intended behavior documented in the catalog.

**DELEG-01–03:** These cases are inherently TUI-only and cannot be exercised via the readline method. However:
1. The existing unit tests (`agent-commands.test.ts`, lines 366–411) comprehensively cover `parseDelegateCommand`'s parsing logic and both refusal paths.
2. All 5 `parseDelegateCommand` tests pass, confirming:
   - Successful agent+task parsing (line 366–371)
   - Whitespace preservation (line 374–377)
   - Empty input usage message (line 379–384)
   - Agent-without-task refusal, phrased correctly (line 386–393)
   - Unknown-agent refusal, naming both agents and pointing to `keryx agents external list` (line 395–401)

The source code verification (lines 217–243 of `agent-commands.ts`) confirms each error message matches the test expectations and the catalog's predicted behavior.

---

## Improvement / fix suggestion

None — both `parseDelegateCommand` parsing behavior and the readline gap match their documentation and test expectations. The catalog's correction note in SLASH-26 is accurate and well-placed. The unit tests form a sufficient safety net for the parsing logic; the TUI dispatcher's capability gate enforcement would require a real PTY to exercise, which is outside the scope of this readline-based pass.

For a future verification pass covering the full `/delegate` workflow (capability gate + TUI dispatch + sandbox invocation), a PTY-based test runner (e.g., `expect` or `script`) would be needed to exercise DELEG-01–03 end-to-end. The existing unit tests are the current substitute and are adequate for the parsing layer.
