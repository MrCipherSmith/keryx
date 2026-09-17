# Review round 1 — flow 267 (background task execution P3, the documentation sweep)

Reviewed by the orchestrator against `origin/main`, by re-reading the rewritten
page rather than by trusting the edits that produced it. Recorded as
`orchestrator-self-review`: no reviewer skill ran.

A documentation phase has a narrower failure surface than code, and exactly two
questions worth asking: does the page now say things that are TRUE, and does it
still say the true things it said before. Two findings, both from the second
question — the phase's own edits, not the original page, introduced them.

Deterministic guards for the round: `keryx review floor --ref origin/main`
reported 0 findings; `keryx wiki validate` passes; the routed diff restricted to
`src` reports 0 changed files, so nothing behavioural moved; the full suite is
10 425 pass / 20 skip / 0 fail.

## F-001 (minor) — the page's `Describes:` list pointed away from the code it now describes

The front-matter listed the five flow-173 files. After the rewrite the page's
subject includes completion delivery (`src/commands/agent.ts`), the `/demote`
parser (`src/commands/agent-commands.ts`) and the roster that carries the
observer split (`src/commands/interactive-agent-tools.ts`). That list is not
decoration: the wiki's page↔code linkage is built from it, so a reader following
the page to the implementation would have been sent to the flow-173 modules only.

## F-002 (info) — the targeted edits left two sections about the same thing

Inserting a task-tool table near the summary left the older `### Model-facing
tools` heading in Details describing risk, approval and the budget split — two
headings for one subject, which is how a page starts drifting again. The Details
heading now says what its content is (`### Tool safety and budget`), and the TUI
paragraph names the sidebar's label as the interface's own name rather than
framing the page around it.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "orchestrator-self-review",
    "severity": "minor",
    "file": ".metaproject/wiki/architecture/background-jobs.md",
    "quote": "Describes:",
    "problem": "The page's front-matter `Describes:` list still named only the five flow-173 source files, while the rewritten page's subject now includes completion delivery, the /demote parser and the tool roster with the observer split.",
    "impact": "The wiki's page-to-code linkage is derived from that list, so an agent or a person following this page to the implementation would be pointed at the flow-173 modules only, and would not find the code that implements most of what the page now claims.",
    "suggested_fix": "Add src/commands/agent.ts, src/commands/agent-commands.ts and src/commands/interactive-agent-tools.ts to the Describes list.",
    "evidence": "Read of the rewritten page's front-matter at lines 6-11 against its own body, which documents delivery (agent.ts), /demote (agent-commands.ts) and the observer split on the roster (interactive-agent-tools.ts).",
    "confidence": "high"
  },
  {
    "id": "F-002",
    "reviewer": "orchestrator-self-review",
    "severity": "info",
    "file": ".metaproject/wiki/architecture/background-jobs.md",
    "quote": "### Model-facing tools",
    "problem": "After the targeted edits the page carried two sections about the tool surface: the new task-tool table near the summary, and the older Details heading whose content had become risk classification, approval and the tool-call budget.",
    "impact": "Two headings for one subject is the shape a page drifts back into being wrong from: the next edit lands in whichever section the editor happens to open.",
    "suggested_fix": "Retitle the Details heading to what its content actually is, and keep the surface description in one place.",
    "evidence": "Read of the page after the edits: the table sits under the summary while `### Model-facing tools` in Details holds only the risk/approval/budget paragraphs.",
    "confidence": "high"
  }
]
```
