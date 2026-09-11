# Review round 1 — PR #530 (flow 251, K-012)

Reviewer: `review-logic`, read-only (Read tool only), dispatched against head 6796e74.
It confirmed the fix closes the reported hang and that nothing in the start-up path
can still leak the runtime. Two findings, both acted on in
d57ecbec7dd43075cae17c0e4153fbdb24e31f2a.

## F-001 (minor) — close() left its timers armed, so every close lingered ~4.5 s

`close()` raced its waits against `delay()` timers it never cleared; the CLI exits by
letting the event loop drain, so a close that had finished still held the process for
the full grace. Measured with one probe: 4546 ms before the fix, 38 ms after.

## F-002 (info) — the shell-level survivor check could not fail

After the fix the dial is aborted before the server spawns, so `pgrep` finds nothing
whether or not `close()` tears a connected server down. Now proved at the runtime
level against the stdio fixture.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "close() bounded its waits with Promise.race against delay() timers it never cleared or unref'd, so the losing timer stayed armed after close() returned.",
    "impact": "The CLI exits by letting the event loop drain, so every close kept the process alive ~4.5 s (KILL_GRACE_MS) — after every refused start, with or without MCP servers, and after every keryx shell -p run. It also left the K-012 test's 10 s bound with thin margin on a loaded runner.",
    "suggested_fix": "Clear the losing timer when the race resolves (or unref it), and make close() idempotent so the second call returns the first one's promise.",
    "evidence": "Reviewer traced runtime.ts close() and cli.ts's exitCode-based exit; noted the double close on the normal path restarted both timers.",
    "confidence": "high",
    "file": "src/mcp-servers/runtime.ts",
    "line": 49,
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/mcp-servers/runtime.ts close(): wait for settled dials",
        "src/mcp-servers/runtime.ts close(): wait for aborted dials' kills",
        "src/mcp-servers/runtime.ts close(): repeated calls"
      ],
      "enumeration_method": "Every timer close() arms and every path that calls close() more than once; delay() had exactly two uses, both in close()."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit d57ecbec7dd43075cae17c0e4153fbdb24e31f2a: within() clears its timer when the wait resolves (cleared, not unref'd, so the process cannot exit mid-finally); close() returns one shared promise"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "With the K-012 fix the dial is aborted before the server spawns, so the shell-level test's survivor check returns empty trivially and cannot fail.",
    "impact": "The teardown of a server that HAS connected was not proved by any test, and the changelog line 'the server processes go with it' described a kill that, in the reproduced case, never happens.",
    "suggested_fix": "Add a case where a server really connects before close(), and word the changelog to match.",
    "evidence": "Reviewer traced connectStdioMcpServer: loadCoreSdk() is still pending when the synchronous abort lands, so transport.start() is never reached.",
    "confidence": "high",
    "file": "src/commands/shell-startup-exit.test.ts",
    "line": 63,
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/shell-startup-exit.test.ts survivor check",
        "CHANGELOG.md [Unreleased] K-012 entry"
      ],
      "enumeration_method": "Every place that claims a server process is torn down on a refused start."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit d57ecbec7dd43075cae17c0e4153fbdb24e31f2a: src/mcp-servers/runtime-close.test.ts proves a connected fixture server is torn down; the shell test's comment and the changelog now say what actually happens"
    }
  }
]
```
