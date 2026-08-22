# QUEUE-02 through QUEUE-04 and DELEG-04 — Queue/interrupt and external delegation CLI

**Area:** 12. Queue and interrupt (QUEUE-02/03/04) · 13. External delegation / CLI (DELEG-04) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

### QUEUE-02: `/queue remove [N]` removes a queued item
**Note:** Not reachable via readline per catalog section 13 note. Expect generic fallback.
- Command: `/queue remove 1`
- Expected: `Unknown command: /queue. Type /help.` (readline fallback)

### QUEUE-03: `/queue edit [N]` edits a queued item before delivery
**Note:** Not reachable via readline per catalog section 13 note. Expect generic fallback.
- Command: `/queue edit 1`
- Expected: `Unknown command: /queue. Type /help.` (readline fallback)

### QUEUE-04: `/queue force [N]` — force semantics
**Note:** Not reachable via readline per catalog section 13 note. Expect generic fallback.
- Command: `/queue force 1`
- Expected: `Unknown command: /queue. Type /help.` (readline fallback)

### DELEG-04: `keryx agents external list [--json] [--no-probe]`
**Note:** Pure CLI, read-only, no credentials needed.
- Commands: 
  1. `keryx agents external list --json`
  2. `keryx agents external list --no-probe`
- Expected: Reports installed/not-installed/not-probed per agent (`codex-cli`, `claude-cli`), only ever runs `--version` probe

## What was actually run

```bash
# QUEUE-02 test
printf '/queue remove 1\n' | DEEPSEEK_API_KEY="..." keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp

# QUEUE-03 test  
printf '/queue edit 1\n' | DEEPSEEK_API_KEY="..." keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp

# QUEUE-04 test
printf '/queue force 1\n' | DEEPSEEK_API_KEY="..." keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp

# DELEG-04 tests
keryx agents external list --json
keryx agents external list --no-probe
```

Session ids: 
- QUEUE-02: `89ad4eb9`
- QUEUE-03: `080e4286`
- QUEUE-04: `fe717b1d`
- DELEG-04: CLI only (no session)

## Captured output (terminal text capture)

### QUEUE-02 output
```text
  keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 89ad4eb9 · per-project (keryx shell -c to continue)
      Unknown command: /queue. Type /help.
  ❯
```

### QUEUE-03 output
```text
  keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 080e4286 · per-project (keryx shell -c to continue)
      Unknown command: /queue. Type /help.
  ❯
```

### QUEUE-04 output
```text
  keryx — deepseek/deepseek-v4-flash-vision-exp · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session fe717b1d · per-project (keryx shell -c to continue)
      Unknown command: /queue. Type /help.
  ❯
```

### DELEG-04 `--json` output
```json
{
  "capability": {
    "available": false,
    "reason": "the external agent runtime is disabled; set `externalAgents.enabled` to true in the keryx user config to opt in"
  },
  "probed": true,
  "agents": [
    {
      "id": "codex-cli",
      "label": "Codex",
      "binary": "codex",
      "detect": [
        "--version"
      ],
      "knownGoodRange": {
        "min": "0.147.0"
      },
      "sandboxModes": [
        "read-only",
        "worktree-write"
      ],
      "streamingInput": false,
      "resumable": true,
      "reportsCost": false,
      "budgetFlag": false,
      "availability": {
        "state": "available",
        "version": "0.147.0",
        "verdict": {
          "state": "in-range"
        }
      }
    },
    {
      "id": "claude-cli",
      "label": "Claude",
      "binary": "claude",
      "detect": [
        "--version"
      ],
      "knownGoodRange": {
        "min": "2.1.220"
      },
      "sandboxModes": [
        "read-only",
        "worktree-write"
      ],
      "streamingInput": true,
      "resumable": true,
      "reportsCost": true,
      "budgetFlag": true,
      "availability": {
        "state": "available",
        "version": "2.1.239",
        "verdict": {
          "state": "in-range"
        }
      }
    }
  ]
}
```

### DELEG-04 `--no-probe` output
```text
# agents external

capability: unavailable — the external agent runtime is disabled; set `externalAgents.enabled` to true in the keryx user config to opt in

  ? codex-cli  Codex
      not probed — run `keryx agents external probe codex-cli`
      sandbox: read-only, worktree-write  streaming: false  resumable: true  reports cost: false
  ? claude-cli  Claude
      not probed — run `keryx agents external probe claude-cli`
      sandbox: read-only, worktree-write  streaming: true  resumable: true  reports cost: true

A version proves a binary, not a login. keryx never reads a vendor credential store.
```

## Cross-checks

None needed. QUEUE-02/03/04 are readline fallback tests (not TUI-executable), and DELEG-04 is a pure CLI read that affects no on-disk state.

## Summary

All four test cases behaved exactly as expected.

**QUEUE-02/03/04:** All three `/queue` commands (remove, edit, force) correctly fall through to the generic "Unknown command" fallback when invoked via readline in `--no-tui` mode, confirming that `/queue` is not dispatched in the agent-mode readline code path. This is consistent with the catalog's note that these commands are TUI-only and have no readline dispatch branch.

**DELEG-04:** The `keryx agents external list` command correctly reports agent availability status:
- With `--json`: reports both agents (codex-cli, claude-cli) with their probed availability states, versions, and metadata
- With `--no-probe`: reports the same agents as "not probed" instead, avoiding any version check
- Both forms correctly output the capability gate message (external agents disabled) without attempting any network calls or credential access

## Analysis

**QUEUE-02/03/04 behavior confirms the design decision:** The `/queue` family of commands is intentionally TUI-only, not part of the agent-mode readline dispatch chain. This is by design — queuing requires a concurrent UI to show queued items and their positions, which readline cannot provide. The generic "Unknown command" fallback is the correct, expected behavior rather than a bug.

**DELEG-04 behavior confirms the pure-CLI contract:** The command:
1. Never invokes the vendor agent binaries themselves (only runs `--version` detection in the `--json` case)
2. Correctly respects the `--no-probe` flag to skip even version detection
3. Outputs structured data (JSON or text) without any network/credential access
4. Correctly reports the capability gate (external agents disabled) as informational context
5. Names the two known agents (`codex-cli`, `claude-cli`) as documented

Both agents report `available` state with matching version ranges, confirming they are installed and in-range on this machine.

## Improvement / fix suggestion

None — all behaviors match their documented contracts exactly. The QUEUE commands work as specified (readline fallback), and DELEG-04 delivers the pure-CLI interface without side effects.
