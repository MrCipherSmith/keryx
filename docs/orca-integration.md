# Experimental Orca lifecycle adapter

This is the **Keryx side only**, not stock Orca support. Orca 1.4.227 does
not implement `/hook/keryx`. Adding Keryx to its catalog does not add that
route or state normalizer. No installed app or user profile is modified.

For a host implementing the native contract, opt in with
`KERYX_ORCA_HOOKS=1 keryx shell`. Both readline and TUI report `working`,
`blocked` (operator input during a turn), and `idle`. Shutdown sends `stopped`;
this is a proposed host-side state, not a confirmed stock Orca feature.

Transport uses Orca's JSON hook envelope (`Content-Type: application/json`): POST to
`http://127.0.0.1:$ORCA_AGENT_HOOK_PORT/hook/keryx`, authenticated by
`X-Orca-Agent-Hook-Token`. Fields: `paneKey`, `tabId`, `worktreeId`,
`launchToken`, `env`, `version`, and an object `payload` containing
`{ "event": "keryx_state", "protocolVersion": 1, "state": "working" }`.
Only states and pane metadata are sent: no prompts, tool inputs, or responses.

`ORCA_AGENT_HOOK_ENDPOINT` is a FILE, not a URL. Only literal port/token
assignments and known hook metadata are accepted, without executing shell code.
File values override hook port, token, environment, and version in the environment.
`ORCA_PANE_KEY` and `ORCA_AGENT_LAUNCH_TOKEN` are required. Invalid configuration
disables reporting. Redirects are refused, requests have a 500 ms deadline,
and pending states are bounded. No retries or spooling. Delivery failure disables
reporting for the session without breaking the shell.

## Local experimental host verification

A separate, locally patched Orca 1.4.227 copy implements `/hook/keryx`,
validates protocol version 1, and normalizes `working` → Working,
`blocked` → Waiting for input, and `idle` / `stopped` → Done.
`stopped` also marks a session boundary. A working event starts a new hook
cycle so events are not suppressed after a previous session exits.

The real reporter was exercised inside a fresh Keryx agent pane: all four
requests returned 204, and both Orca's status snapshot and rendered DOM
indicators matched the expected states. This is a reporter-to-host UI probe,
not a full interactive model/approval end-to-end test. Restored plain-shell
panes without a launch token intentionally do not report. The installed Orca
and its normal profile were not modified. This binary patch is local and
version-specific; it is not an upstream Orca feature and updates can remove it.
