# Flow 274 review record

r1 was run on opus at 6f01bdde; r2 verified the fixes on sonnet at 8b02cca0.

PR https://github.com/MrCipherSmith/keryx/pull/620. Fix commits: 66faa292 (library lane) and 36866fd9 (surface lane).

```json keryx:findings
[
 {
  "id": "F1",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/tui/tui-shell.ts",
  "line": 6727,
  "problem": "Capped bus-wake notice reprints on every poll",
  "impact": "onPeers runs on every 1.5s poll; with the agent idle, the cap reached and a question pending, the capped line prints every poll until the operator types",
  "suggested_fix": "Print once per pending batch (flag cleared on drain or on an operator line), or only when the poll delivered new events",
  "evidence": "src/tui/tui-shell.ts:6727 at head 6f01bdde; onPeers runs on every 1.5s poll; with the agent idle, the cap reached and a question pending, the capped line prints every poll until the operator types",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/tui/tui-shell.ts:4575",
    "src/tui/tui-shell.ts:6677",
    "src/tui/tui-shell.ts:6727"
   ],
   "enumeration_method": "keryx ctx rg onBusPollSettled|onPeers in tui-shell.ts and client.ts doPoll"
  }
 },
 {
  "id": "F2",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/commands/interactive-agent-tools.ts",
  "line": 235,
  "problem": "bus_* tools are offered when the bus is disabled (AC9)",
  "impact": "Both surfaces pass bus unconditionally; KERYX_BUS=off, sessions off, or a failed join still exposes bus_list/bus_send to the model",
  "suggested_fix": "Add the bus option only when the join succeeds (rebuild the tools then)",
  "evidence": "src/commands/interactive-agent-tools.ts:235 at head 6f01bdde; Both surfaces pass bus unconditionally; KERYX_BUS=off, sessions off, or a failed join still exposes bus_list/bus_send to the model",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/commands/shell.ts:3309",
    "src/commands/shell.ts:3760",
    "src/tui/tui-shell.ts:3061",
    "src/commands/interactive-agent-tools.test.ts:417"
   ],
   "enumeration_method": "diff review of every buildInteractiveAgentTools/makeAgentDeps call site"
  }
 },
 {
  "id": "F3",
  "reviewer": "review-orchestrator",
  "severity": "major",
  "file": "src/bus/agent-tools.ts",
  "line": 197,
  "problem": "Agent sends are written with origin operator",
  "impact": "Model-authored bus_send events carry from.origin operator, contrary to spec 4.2 and D-12; their provenance is misattributed, the agent limit is not counted from the log, and they use up the operator budget",
  "suggested_fix": "Add origin agent to sendMessage with a countRecent 10/min per-instance limit",
  "evidence": "src/bus/agent-tools.ts:197 at head 6f01bdde; Model-authored bus_send events carry from.origin operator, contrary to spec 4.2 and D-12; their provenance is misattributed, the agent limit is not counted from the log, and they use up the operator budget",
  "confidence": "high",
  "source": "internal",
  "class_scope": {
   "sites": [
    "src/bus/agent-tools.ts:197",
    "src/bus/client.ts send/reply",
    "src/bus/send.ts:36"
   ],
   "enumeration_method": "keryx ctx rg origin in src/bus/send.ts and client.ts"
  }
 },
 {
  "id": "F4",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/tui/tui-shell.ts",
  "line": 4608,
  "problem": "Wakes before the join rebuild hit deps without busInbox",
  "impact": "A poll wake during await makeAgentDeps produces an empty turn that burns the cap",
  "suggested_fix": "Attach busInbox/busAck before the await, or skip the wake while deps.busInbox is undefined",
  "evidence": "src/tui/tui-shell.ts:4608 at head 6f01bdde; A poll wake during await makeAgentDeps produces an empty turn that burns the cap",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F5",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/agent-tools.ts",
  "line": 106,
  "problem": "The agent rate window resets on every deps rebuild",
  "impact": "join, /model and /connect each rebuild buildBusTools with a fresh window",
  "suggested_fix": "Count the limit from the log",
  "evidence": "src/bus/agent-tools.ts:106 at head 6f01bdde; join, /model and /connect each rebuild buildBusTools with a fresh window",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F6",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/agent-tools.ts",
  "line": 197,
  "problem": "bus_send can target its own instance",
  "impact": "A send to @self resolves to the agent's own id, so the agent wakes itself and acks its own message",
  "suggested_fix": "Refuse sends whose only resolved recipient is self",
  "evidence": "src/bus/agent-tools.ts:197 at head 6f01bdde; A send to @self resolves to the agent's own id, so the agent wakes itself and acks its own message",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F7",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/tui/tui-shell.ts",
  "line": 4609,
  "problem": "The join rebuild can revert a concurrent /model",
  "impact": "currentSel is captured before the await; a join that finishes later overwrites the new model's deps",
  "suggested_fix": "Re-read currentSel after the await, or serialise rebuilds",
  "evidence": "src/tui/tui-shell.ts:4609 at head 6f01bdde; currentSel is captured before the await; a join that finishes later overwrites the new model's deps",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F8",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/harness/child/quarantine.ts",
  "line": 30,
  "problem": "Quarantine ignores peer-message/task-notification tags",
  "impact": "Forged harness tags are escaped but not flagged",
  "suggested_fix": "Add both tags to the control-tag pattern",
  "evidence": "src/harness/child/quarantine.ts:30 at head 6f01bdde; Forged harness tags are escaped but not flagged",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F9",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/tui/tui-shell.ts",
  "line": 5577,
  "problem": "Side workers get the conduct block without bus_send",
  "impact": "busJoined is true for side-worker deps built with busClientRef",
  "suggested_fix": "Do not pass bus for side workers",
  "evidence": "src/tui/tui-shell.ts:5577 at head 6f01bdde; busJoined is true for side-worker deps built with busClientRef",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F10",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/inbox.ts",
  "line": 67,
  "problem": "Inbox overflow drops are silent",
  "impact": "Beyond 200 pending messages, messages are dropped and droppedCount is never surfaced",
  "suggested_fix": "Show the operator a notice when droppedCount grows",
  "evidence": "src/bus/inbox.ts:67 at head 6f01bdde; Beyond 200 pending messages, messages are dropped and droppedCount is never surfaced",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F11",
  "reviewer": "review-orchestrator",
  "severity": "minor",
  "file": "src/bus/delivery.integration.test.ts",
  "line": 458,
  "problem": "AC5/AC6 wake is proven by a reimplemented loop and source audits",
  "impact": "The real onBusPollSettled counter and reset are never exercised",
  "suggested_fix": "Extract a wake-controller factory and test its behaviour",
  "evidence": "src/bus/delivery.integration.test.ts:458 at head 6f01bdde; The real onBusPollSettled counter and reset are never exercised",
  "confidence": "high",
  "source": "internal"
 },
 {
  "id": "F12",
  "reviewer": "review-orchestrator",
  "severity": "info",
  "file": "src/bus/agent-tools.ts",
  "line": 138,
  "problem": "bus_list peer strings are not quarantined",
  "impact": "Peer status and activity reach the model with only displaySafe applied",
  "suggested_fix": "Quarantine them or frame them as data",
  "evidence": "src/bus/agent-tools.ts:138 at head 6f01bdde; Peer status and activity reach the model with only displaySafe applied",
  "confidence": "high",
  "source": "internal"
 }
]
```
