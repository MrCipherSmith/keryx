# Review round 1 — PR #529 (flow 250)

Reviewer: `review-logic`, read-only (Read tool only, no shell), dispatched against the
change diff after the first implementation commit. It reviewed logic and security
together. Four findings: one major, three minor. All four were acted on in this PR and
each fix is covered by a test that fails on the pre-fix code.

## F-001 (major) — the static system prompt contradicted two of the fixes

`buildAgentSystemInstruction` (`src/commands/agent.ts`) named every metaproject tool and
told the model to call `graph_symbol` FIRST whatever the roster held, and said
`read_file` "cannot page forward". After K-009 a project without `.metaproject/` has no
graph tools, and after S-1 `read_file` pages by `start_line`, so the prompt steered the
model into failing calls and away from the new paging.

## F-002 (minor) — read_file miscounted a newline-terminated file

`readFromLine` counted `line` as newlines + 1, so `"a\nb\nc\n"` read as four lines:
`start_line: 4` returned empty success instead of the past-end error, and the error
reported the wrong length.

## F-003 (minor) — the truncation notice compared different units

`read ${part.text.length} of ${size} bytes` compared characters from `start_line` with
the whole file's bytes.

## F-004 (minor) — keryxSelfCommand trusted any entry named src/cli.ts

The regex accepted any `…/src/cli.ts` or `…/dist/cli.js`, so a host application with
that common entry name would have had model-influenced arguments sent to its own CLI.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "buildAgentSystemInstruction is static text: it named every metaproject tool, told the model to call graph_symbol FIRST whatever the roster held, and said read_file cannot page forward.",
    "impact": "In a project without .metaproject/ the roster no longer has graph tools (K-009), so a model following the prompt calls graph_symbol and fails a round — the waste K-009 removed, reintroduced by the prompt. The paging sentence steered the model away from start_line, undoing S-1.",
    "suggested_fix": "Build the tool list and the locate rule from the session's actual tool names; replace the cannot-page sentence with how to page by start_line.",
    "evidence": "Reviewer traced shell.ts's two call sites: neither passed the roster to the instruction builder.",
    "confidence": "high",
    "file": "src/commands/agent.ts",
    "line": 698,
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts tool list sentence",
        "src/commands/agent.ts graph_symbol FIRST rule",
        "src/commands/agent.ts read_file cannot-page sentence",
        "src/commands/agent.ts required-fields example naming read_wiki/wiki_ask",
        "src/commands/agent.ts tool-budget list naming graph_*/wiki_*",
        "src/commands/agent.ts wiki enrich routing naming read_wiki",
        "src/commands/agent.ts other-keryx-work routing naming graph tools"
      ],
      "enumeration_method": "Enumerated every place in the instruction text that names a metaproject tool or describes read_file; the first fix covered three, and the new roster test found the remaining four."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit 03b4cf9 (instruction takes toolNames; every tool mention conditional), and 19de620 (the roster literal kept inline where the shell.ts source audits read it)"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "readFromLine counted line as newlines + 1, so a newline-terminated file read one line longer than it is.",
    "impact": "start_line = length + 1 returned an empty success instead of the past-end error, and the past-end error stated the wrong length to the model.",
    "suggested_fix": "Track whether the file ended with a newline and whether anything was read; count lines from that.",
    "evidence": "Reviewer worked the arithmetic for \"a\\nb\\nc\\n\" with start_line 4 and 10, and for an empty file.",
    "confidence": "high",
    "file": "src/harness/tool/builtin/interactive-tools.ts",
    "line": 82,
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/harness/tool/builtin/interactive-tools.ts readFromLine line count",
        "src/harness/tool/builtin/interactive-tools.ts past-end error message"
      ],
      "enumeration_method": "Every consumer of readFromLine's line count: the past-end decision and the message that reports the length."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e4421a1"
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The truncation notice read `read <characters from start_line> of <whole-file bytes> bytes`, comparing different quantities.",
    "impact": "At start_line 1500 of a 100 KB file it reported about 20,000 of 100,000 bytes when about 25 KB remained, telling the model something false about how much was left.",
    "suggested_fix": "Report the lines shown and the start_line to continue from.",
    "evidence": "Reviewer computed the notice for the test's 2000-line fixture at start_line 1500.",
    "confidence": "high",
    "file": "src/harness/tool/builtin/interactive-tools.ts",
    "line": 229,
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/harness/tool/builtin/interactive-tools.ts paging notice",
        "src/harness/tool/builtin/interactive-tools.ts single-long-line notice"
      ],
      "enumeration_method": "Both branches that build a truncation notice in read_file."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e4421a1"
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "keryxSelfCommand accepted any Bun.main ending in src/cli.ts or dist/cli.js as keryx.",
    "impact": "A host application whose entry shares that common name, building these tools with the default runner, would have received model-influenced arguments at its own CLI instead of keryx or the PATH fallback.",
    "suggested_fix": "Accept Bun.main only when it equals the entry derived from this module's own location.",
    "evidence": "Reviewer read the regex against a hypothetical /app/src/cli.ts host; noted it could not confirm dist/core.js exposes the runner.",
    "confidence": "medium",
    "file": "src/harness/tool/builtin/metaproject-tools.ts",
    "line": 95,
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/harness/tool/builtin/metaproject-tools.ts keryxSelfCommand source/npm branch",
        "src/harness/tool/builtin/metaproject-tools.ts keryxSelfCommand compiled-binary branch"
      ],
      "enumeration_method": "Every branch of keryxSelfCommand that returns an argv other than PATH keryx."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit e4421a1"
    }
  }
]
```
