# Review — flow 292, keryx as an ACP client (PR #654)

Three security passes ran over the ACP client surface (`src/harness/external/acp-client.ts`,
`acp-fs.ts`, `acp-permission.ts`, `bun-spawn-port.ts`), the confinement primitives it shares with
`search_code`/`serve-mcp`/the shell (`src/harness/tool/metaproject-adapter.ts`,
`src/harness/tool/builtin/interactive-tools.ts`), and the `keryx agents external run` CLI
(`src/commands/agents-external.ts`). The first pass (flow journal T13) found a real-path
confinement bypass shared across three tool surfaces, an unbounded line splitter, a write-time
TOCTOU, a readline leak, a missing session binding, and a `ctx rg` argument-injection bug found
while fixing the confinement issue. The second pass (T14) re-probed for resource exhaustion and
found the run's total output — in particular stderr — was unbounded, reproducing a ~1.5 GB / 12 s
flood, plus a quadratic cost in the line-cap enforcement itself and a misreported overflow reason.
A third pass re-measured memory after both rounds of fixes and found it bounded, with one
optional hardening recorded below rather than filed as a finding. All nine findings were fixed
before merge. PR #654 merged as `9dc5ae43` (squash of head `a34d60043b52e9dbdaa78a693c4833ecf943d27f`)
with 18/18 checks green.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "major",
    "file": "src/harness/tool/metaproject-adapter.ts",
    "quote": "confineToProject",
    "problem": "search_code's confineToProject checked the candidate path lexically rather than by real path, so an in-project symlink pointing outside the confined root let search_code read and return content from outside the project.",
    "impact": "A symlink planted inside the project (or inherited from a checkout) let any caller of search_code -- serve-mcp's tool surface, the shell's search_code tool, and the ACP client's own MCP context offer -- read arbitrary files on the host outside the confined root, defeating the project confinement the whole tool surface relies on.",
    "suggested_fix": "Resolve the candidate through the shared real-path confinement primitive (confineToRoot) and hand ripgrep the resolved real path rather than the symlink name; never pass --follow to ripgrep.",
    "evidence": "Pre-fix, a symlinked directory/file pointing outside cwd was accepted by confineToProject and its content was returned by search_code; reproduced as a failing test before the fix.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/tool/metaproject-adapter.ts confineToProject (search_code / serve-mcp)",
        "src/harness/tool/builtin/interactive-tools.ts confineToRoot (the shared real-path primitive; shell read/write tools)",
        "src/harness/external/acp-fs.ts (ACP fs bridge)",
        "src/harness/tool/builtin/metaproject-tools.ts",
        "src/acp/capability-tools.ts",
        "src/harness/external/acp-permission.ts",
        "src/harness/tool/builtin/apply-patch-tool.ts"
      ],
      "enumeration_method": "Every call site of confineToRoot/confineToProject was enumerated by search; the real-path resolution fix landed once in the shared primitive, so every caller -- search_code, serve-mcp, the shell's interactive read/write tools, apply-patch, and the ACP capability/fs/permission bridges -- was fixed together rather than patched per call site."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "real-path confine via confineToRoot in src/harness/tool/metaproject-adapter.ts and the shared src/harness/tool/builtin/interactive-tools.ts primitive; regression tests in src/harness/tool/search-code-confinement.test.ts (describe \"search_code (the adapter behind serve-mcp and the sessions)\") and src/harness/tool/builtin/confine-to-root.test.ts; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-002",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "major",
    "file": "src/harness/external/bun-spawn-port.ts",
    "quote": "line framing",
    "problem": "The line-stream splitter that frames an external agent's stdout/stderr had no maximum line size, so a child that wrote one line without a newline could grow an unbounded in-memory buffer.",
    "impact": "A malicious or malfunctioning external agent (ACP or line-stream transport) could exhaust host memory with a single oversized, newline-less write, denying service to the machine running the harness.",
    "suggested_fix": "Cap each line at a fixed ceiling (64 MiB, matching ACP_DEFAULT_MAX_LINE_BYTES, injectable for tests); on overflow kill the child and raise a named error (ExternalLineTooLongError) that closes pending requests with that reason.",
    "evidence": "Reproduced pre-fix: a newline-less stream of unbounded length was accepted with no ceiling. Fixed and covered by src/harness/external/bun-spawn-port.test.ts, describe \"the line-size ceiling (flow 292 T13)\".",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/external/bun-spawn-port.ts createBunSpawnPort (the single shared spawn/line-framing primitive)",
        "src/harness/run-external-factory.ts (the line-stream transport: claude-cli, codex-cli)",
        "src/commands/agents-external.ts (the ACP transport: gemini-acp)"
      ],
      "enumeration_method": "createBunSpawnPort has exactly two callers that spawn a real external agent -- the line-stream factory and the ACP CLI command -- both located by searching every call site of createBunSpawnPort. The line-splitter is shared code, so the ceiling fix applies to both transports at once."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "64 MiB line cap in src/harness/external/bun-spawn-port.ts (ACP_DEFAULT_MAX_LINE_BYTES, injectable); ExternalLineTooLongError kills the child and closes pending requests; tests at bun-spawn-port.test.ts:184 \"defaults to the same 64 MiB ceiling...\", :188 \"a newline-less stream past a small injected ceiling throws a named error and kills the child\", :216 \"an ACP run fails with the named reason when its agent overflows the ceiling\"; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-003",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "minor",
    "file": "src/harness/external/acp-fs.ts",
    "quote": "writeTextFileInWorktree",
    "problem": "Between the ancestor-confinement check and the actual write, the parent directory could be swapped for a symlink pointing outside the disposable worktree (a check-then-act window), and the write would follow it.",
    "impact": "A process racing the write (or a symlink planted at exactly the right moment) could escape the worktree confinement and write outside the disposable sandbox that AC5/AC10 rely on as the load-bearing containment.",
    "suggested_fix": "Re-check the parent's real path again after mkdir, immediately before opening, and open the target with O_NOFOLLOW so a symlink planted AT the target between check and write is not followed.",
    "evidence": "Fixed and covered by src/harness/external/acp-fs.test.ts, describe \"writeTextFileInWorktree\".",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "post-mkdir real-path re-check plus O_NOFOLLOW open in src/harness/external/acp-fs.ts; tests at acp-fs.test.ts:38 \"an ancestor swapped for an outward symlink between check and write is refused\" and :50 \"a symlink planted AT the target between check and write is not followed (O_NOFOLLOW)\"; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-004",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "minor",
    "file": "src/commands/agents-external.ts",
    "quote": "terminalApprover",
    "problem": "The terminal approver's readline interface was closed only in the answer callback, so an abandoned prompt (the bridge's approval timeout winning, via meta.signal) never closed its interface.",
    "impact": "A run whose human approver timed out left an open readline interface holding stdin; over repeated timeouts the CLI could hang after the run had already ended.",
    "suggested_fix": "Close the readline interface on every path -- an answer, or meta.signal aborting -- not only in the question callback.",
    "evidence": "Fixed and covered by src/commands/agents-external-run.test.ts, describe \"flow 292 T13 -- the terminal approver never leaks its readline\".",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "src/commands/agents-external.ts terminalApprover now closes the readline on both the answer path and meta.signal abort (see its own docstring, which names flow 292 T13); test at src/commands/agents-external-run.test.ts:251; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-005",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "minor",
    "file": "src/harness/external/acp-client.ts",
    "quote": "session binding",
    "problem": "Incoming session/request_permission, fs/* requests and session/update messages were not checked against the run's own bound session id, so a message naming a different session -- or arriving after the turn had already ended -- could be answered or folded as if it belonged to this run.",
    "impact": "A misbehaving or confused agent (or a bug on the wire) naming a foreign session id could receive a permission decision, a filesystem answer, or have its updates folded into the wrong run's persisted record -- a cross-session leak inside one process.",
    "suggested_fix": "Bind the client to the session id it started with; refuse permission/fs requests naming any other session by name and record the refusal; ignore session/update for another session; stop answering once the turn has ended.",
    "evidence": "Fixed and covered by src/harness/external/acp-client.process.test.ts, describe \"flow 292 T13 -- keryx answers only for this run's session, and only during its turn\".",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "session-bound request/update handling in src/harness/external/acp-client.ts; tests at acp-client.process.test.ts:738 \"a permission or fs request naming another session is refused by name and recorded; an update for another session is ignored\" and :785 \"a permission or fs request sent after the prompt was answered is refused and recorded, never decided\"; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-006",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "minor",
    "file": "src/harness/tool/builtin/metaproject-tools.ts",
    "quote": "ctx rg fallback",
    "problem": "The ctx rg fallback path handed the model's search pattern to ripgrep with no `--` separator, so a pattern that happens to start with `-` (for example `--follow`) was parsed as a ripgrep flag instead of literal search text.",
    "impact": "A pattern that looks like a flag silently changed ripgrep's own behaviour (for example, turning ON symlink-following) instead of erroring or searching for the literal text -- a correctness bug that, combined with F-001, was a second route around the confinement (ripgrep following an outward symlink).",
    "suggested_fix": "Put `--` before the model's pattern in every ctx rg fallback invocation, so ripgrep parses everything after it as positional arguments.",
    "evidence": "Found while fixing F-001 and covered by src/harness/tool/search-code-confinement.test.ts, describe \"the ctx-rg fallback of search_code\".",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "`--` inserted before the pattern in the ctx rg fallback, src/harness/tool/builtin/metaproject-tools.ts; test at search-code-confinement.test.ts:77 \"a model pattern that looks like a flag stays a pattern (`--` precedes it)\"; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-007",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "major",
    "file": "src/harness/external/acp-client.ts",
    "quote": "unbounded output retention",
    "problem": "Nothing bounded the total output a run could accumulate -- assistant text, folded events, and especially the agent's stderr -- so an agent that wrote unbounded stderr could grow the run's retained output without limit.",
    "impact": "Reproduced directly: an agent flooding stderr drove the run's retained memory to roughly 1.5 GB over 12 seconds -- a denial-of-service against the host running the harness, from a single misbehaving or malicious external agent.",
    "suggested_fix": "Bound diagnostic streams (stderr, and stdout for the line-stream transport) to a head+tail retention window; budget the run's produced output (assistant text + events) against a hard ceiling; on overflow name the reason, kill the agent, and close pending requests, exempting the terminal event from the budget so the overflow itself is always reported.",
    "evidence": "Reproduced pre-fix (stderr flood -> ~1.5 GB/12s); fixed with the new src/harness/external/bounded.ts (BoundedTranscript, OutputBudget), wired into both external-agent transports.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/external/acp-client.ts (ACP: stderr retention + output budget)",
        "src/harness/external/supervise.ts (the line-stream supervisor shared by claude/codex: stdout+stderr retention + output budget)"
      ],
      "enumeration_method": "Both places a spawned external agent's output is retained and forwarded were enumerated: the ACP client and the line-stream supervisor. Both were wired to the same BoundedTranscript/OutputBudget primitives from the new src/harness/external/bounded.ts, so the fix covers every external-agent transport keryx supports, not only ACP."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "src/harness/external/bounded.ts (BoundedTranscript head/tail retention, OutputBudget hard ceiling) wired into acp-client.ts and supervise.ts; tests at src/harness/external/bounded.test.ts, describes \"ACP client -- the run's retention is bounded\" and \"line-stream supervisor (claude/codex share it) -- the same bounds\"; merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-008",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "minor",
    "file": "src/harness/external/bun-spawn-port.ts",
    "quote": "readLines",
    "problem": "The line-reading path that enforces the F-002 line cap was itself quadratic -- it re-scanned already-seen bytes on every incoming chunk -- so enforcing even a bounded cap against a flood cost roughly 1 GB of intermediate allocation before the cap took effect.",
    "impact": "The cap-enforcement mechanism was itself a resource-exhaustion vector: a flood could be nearly as expensive to reject as to accept, undermining the point of F-002's fix.",
    "suggested_fix": "Make line reading linear: keep pending chunks in an array with a running byte length, scan each chunk once, and join a line's pieces once rather than once per chunk.",
    "evidence": "Measured pre-fix at ~1 GB intermediate allocation for cap enforcement against a flood; fixed and checked with an indexOf spy and an onScan counter.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "linear readLines in src/harness/external/bun-spawn-port.ts; test at bun-spawn-port.test.ts:256 \"one long line built from many small chunks is scanned about once, not once per chunk\" (describe \"line framing stays linear in its input (flow 292 T14)\"); merged to main in 9dc5ae43 via PR #654."
    }
  },
  {
    "id": "F-009",
    "reviewer": "security-reviewer (acp-client)",
    "severity": "minor",
    "file": "src/harness/external/acp-client.ts",
    "quote": "closed its stdout",
    "problem": "When a stderr line exceeded the F-002 line cap, the run was reported as the agent having \"closed its stdout\" instead of naming the real cause -- a stderr line over the cap.",
    "impact": "An operator debugging an aborted run would be pointed at the wrong stream and the wrong cause, hiding the real (stderr flood / line-cap) condition behind a misleading, unrelated message.",
    "suggested_fix": "When a stderr line trips the line cap, abort the run with that reason explicitly instead of falling through to the generic stdout-closed message.",
    "evidence": "Fixed and covered by src/harness/external/bounded.test.ts.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "stderr-cap overflow now aborts the run with its own named reason in src/harness/external/acp-client.ts; test at bounded.test.ts:136 \"a stderr line past the line ceiling is the run's named reason, not a stdout symptom\" (asserts outcome.failure contains 'stderr sent more than ... bytes without a newline' and does NOT contain 'closed its stdout'); merged to main in 9dc5ae43 via PR #654."
    }
  }
]
```

## Coverage

Reviewed: the ACP client supervisor and its permission/fs/capability bridges
(`src/harness/external/acp-client.ts`, `acp-fs.ts`, `acp-permission.ts`), the spawn-port line
framing shared by every external-agent transport (`bun-spawn-port.ts`), the new output-bounding
module and its wiring into both the ACP client and the line-stream supervisor (`bounded.ts`,
`supervise.ts`), the confinement primitives shared with `search_code`/`serve-mcp`/the shell
(`metaproject-adapter.ts`, `interactive-tools.ts`, `metaproject-tools.ts`), and the
`keryx agents external run` CLI's terminal approver (`agents-external.ts`). Not reviewed: the
rest of the repository, unchanged by this flow.

## Outcome

Nine findings: three major, six minor, all acted on and re-verified; none dismissed. A third,
memory-focused re-measure after both rounds of fixes found retained memory bounded under the
same stderr-flood reproduction that drove F-007. One hardening was considered and NOT filed as a
finding, because it describes a bounded rather than unbounded condition: stderr retention itself
is capped by `BoundedTranscript` (F-007), but stderr volume does not count against the run's
`OutputBudget`, so a stderr-only flood runs for the full run timeout rather than being cut short
by the output budget the way an assistant-text/event flood would be. RSS stays bounded throughout
(the head+tail retention holds), so this is a latency/cost characteristic, not a resource-exhaustion
path. It is recorded here as a follow-up for a later pass to consider (counting stderr bytes
against the run budget, or applying a shorter dedicated ceiling), rather than as a finding against
this PR.
