# Flow 273 review record (r1 opus at 49c2a2fd, r2 sonnet verify at d1d9bf39)

PR https://github.com/MrCipherSmith/keryx/pull/615. Fix commits: ece841ed (client lane), 6d29f466 (readline lane), 60db5613 (TUI lane). r2: F1-F11 refuted; N1 (info, flaky SIGINT process test) recorded as follow-up.

```json keryx:findings
[
 {
  "id": "F1",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/bus/client.ts",
  "line": 260,
  "problem": "In-flight heartbeat/setSession/rename can recreate presence after leave()",
  "impact": "heartbeat mid-git-rev-parse when /exit leaves; atomic rename recreates file, exit hook already removed",
  "suggested_fix": "guard writeCurrentPresence on left before and after write; unlink if left flipped",
  "evidence": "src/bus/client.ts:260 at head 49c2a2fd; heartbeat mid-git-rev-parse when /exit leaves; atomic rename recreates file, exit hook already removed",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/bus/client.ts:260-274 heartbeatTick",
    "src/bus/client.ts:347 setSession",
    "src/bus/client.ts:351 rename"
   ],
   "enumeration_method": "all callers of writeCurrentPresence in client.ts"
  }
 },
 {
  "id": "F2",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/commands/shell.ts",
  "line": 702,
  "problem": "Bus client refreshes stale lease handle after session switch",
  "impact": "/new swaps lease via holdLease; heartbeat refreshes released handle; new lease owner name stays null",
  "suggested_fix": "pass lease getter or rebind lease in setSession and refresh immediately; refresh at join",
  "evidence": "src/commands/shell.ts:702 at head 49c2a2fd; /new swaps lease via holdLease; heartbeat refreshes released handle; new lease owner name stays null",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/commands/shell.ts:702",
    "src/commands/shell.ts:2032",
    "src/tui/tui-shell.ts:4481",
    "src/tui/tui-bus.test.ts:254"
   ],
   "enumeration_method": "every joinBus call site's sessionLease argument vs lease reassignment paths"
  }
 },
 {
  "id": "F3",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/tui/worker-fleet.ts",
  "line": 219,
  "problem": "Unsanitised peer activity/checkout/branch/lease reason rendered in TUI",
  "impact": "crafted presence activity with OSC/CSI paints into operator terminal",
  "suggested_fix": "displaySafe every free-text field; add escape tests",
  "evidence": "src/tui/worker-fleet.ts:219 at head 49c2a2fd; crafted presence activity with OSC/CSI paints into operator terminal",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/tui/worker-fleet.ts:219-224",
    "src/tui/bus-panel.ts:50-54",
    "src/tui/bus-panel.ts:63-65"
   ],
   "enumeration_method": "schema fields without pattern traced to every TUI formatter"
  }
 },
 {
  "id": "F4",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/commands/shell.ts",
  "line": 254,
  "problem": "/bus reply id never displayed; reply routed by name",
  "impact": "operator sees only the event line or #seq, reply refused; renamed sender misrouted",
  "suggested_fix": "show short id/seq, resolve by prefix/seq, send to from.instanceId",
  "evidence": "src/commands/shell.ts:254 at head 49c2a2fd; operator sees only the event line or #seq, reply refused; renamed sender misrouted",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/commands/shell.ts:254",
    "src/commands/shell.ts:364",
    "src/tui/bus-panel.ts:19",
    "src/tui/bus-panel.ts:76",
    "src/tui/tui-shell.ts runBusCommand reply"
   ],
   "enumeration_method": "all event renderers and reply resolvers on both surfaces"
  }
 },
 {
  "id": "F5",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/shell.ts",
  "line": 860,
  "problem": "setSession rejection escapes REPL / unhandled in TUI",
  "impact": "presence write EACCES during /new crashes shell",
  "suggested_fix": "catch, print a bus: line",
  "evidence": "src/commands/shell.ts:860 at head 49c2a2fd; presence write EACCES during /new crashes shell",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F6",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/tui/tui-shell.ts",
  "line": 4503,
  "problem": "Fire-and-forget TUI join races exit and session switch",
  "impact": "Ctrl+C before join resolves: timers start, paint destroyed renderer",
  "suggested_fix": "destroyed flag; leave after await; resync sessionId",
  "evidence": "src/tui/tui-shell.ts:4503 at head 49c2a2fd; Ctrl+C before join resolves: timers start, paint destroyed renderer",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F7",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/client.ts",
  "line": 255,
  "problem": "Half-failed join orphans presence",
  "impact": "cursorAtEnd throws after presence write",
  "suggested_fix": "try/unlink on post-write failure",
  "evidence": "src/bus/client.ts:255 at head 49c2a2fd; cursorAtEnd throws after presence write",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F8",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/commands/shell-bus.process.test.ts",
  "line": 304,
  "problem": "SIGSTOP stale test tautological",
  "impact": "300ms window < 5s heartbeat reads stale without SIGSTOP",
  "suggested_fix": "assert live first with a window >5s or a shorter gated heartbeat",
  "evidence": "src/commands/shell-bus.process.test.ts:304 at head 49c2a2fd; 300ms window < 5s heartbeat reads stale without SIGSTOP",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F9",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/tui/tui-shell.ts",
  "line": 3020,
  "problem": "TUI releases lease before presence",
  "impact": "contradicts spec 5.4 order",
  "suggested_fix": "leave() first",
  "evidence": "src/tui/tui-shell.ts:3020 at head 49c2a2fd; contradicts spec 5.4 order",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F10",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/client.ts",
  "line": 281,
  "problem": "No onError wiring; cursor advanced before render; showBus uncaught; unbounded map",
  "impact": "silent persistent failures; dropped batch on render throw",
  "suggested_fix": "wire throttled onError; advance per event; catch; bound map",
  "evidence": "src/bus/client.ts:281 at head 49c2a2fd; silent persistent failures; dropped batch on render throw",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F11",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/tui/worker-fleet.ts",
  "line": 219,
  "problem": "Test/AC gaps: operator rate limit untested, AC10 partial, sidebar lacks status, display.ts binary",
  "impact": "ACs asserted without proof",
  "suggested_fix": "add tests; include status; use \\u escapes",
  "evidence": "src/tui/worker-fleet.ts:219 at head 49c2a2fd; ACs asserted without proof",
  "confidence": "high",
  "source": "internal"
 }
]
```
