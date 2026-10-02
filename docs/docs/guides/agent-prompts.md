# Copy-ready agent prompts

These prompts ask a coding agent to work through Keryx. They describe the
outcome in plain language; the agent finds the right `keryx` commands itself,
through `.metaproject/index.md` and the bundled skills. Replace the
`<PLACEHOLDERS>` and paste the prompt into a session opened at the repository
root.

## Before you use them

- The project has a workspace (`keryx init --yes`); see
  [Set up a project end to end](set-up-a-project.md).
- The agent can find the workspace: either its instruction file carries the
  routing block that `keryx init` writes, or you installed the hooks with
  `keryx integrations install`. See [Connect your agents](../modules/integrations.md).
- Every prompt below tells the agent not to commit or push. Keep that line
  unless you want it to.

## Set up and maintain

### Initialize Keryx in a project

```text
Initialize and fully configure keryx in this repository using recommended defaults.
Read .metaproject/index.md immediately after initialization. Build the graph, analyze
the test stack, collect and validate the wiki, run Standard and security validation,
and report every enabled module and any failed gate. Do not commit or push.
```

For an unattended, verifiable version of this, use the
[agent installation playbook](../agent-installation-playbook.md).

### Refresh after a pull

```text
Refresh the existing Metaproject service files without replacing project data.
Then bring the graph, wiki and memory up to date with the code, re-analyze the testing
context, rebuild the dashboard, and validate the workspace. Summarize only material
changes and blockers. Preserve all user-authored wiki, memory, and flow content.
```

## Understand the code

### Orient before investigating

```text
Read .metaproject/index.md first. Use the project graph and wiki to orient yourself
before reading source files. Show the relevant modules, existing wiki pages, graph
relationships, accepted memory, and test context for <TOPIC>. Use keryx ctx for
searches and large outputs; do not run broad raw grep or cat commands.
```

### Find a feature or symbol

```text
Find everything related to <FEATURE_OR_SYMBOL>. Start with keryx gdgraph find,
then inspect exact symbols and affected paths when the symbol layer is available.
Use wiki backlinks and accepted memory for design context. Verify conclusions in
source code and return the smallest relevant file set with relationship explanations.
```

### Explain an area

```text
Explain how <AREA_OR_FLOW> works in this repository. Read the wiki index first,
open only relevant pages, use gdgraph paths and affected context to connect concepts
to code, and verify claims against source. Include entry points, data flow, state
ownership, failure handling, tests, and known constraints. Do not modify files.
```

### Diagnose a bug without changing code

```text
Diagnose <BUG_OR_FAILURE> without implementing a fix. Read .metaproject/index.md,
use gdgraph for affected relationships, keryx ctx for logs and searches, testing
context for related tests, health for normalized findings, and memory for accepted
constraints. Return the root cause, evidence, affected files, risk, and the smallest
safe fix plan.
```

## Keep the wiki useful

### Enrich draft pages

The bundled `gdwiki` skill treats page writing as bounded work for a cheaper
model, with a stronger model reviewing a sample.

```text
Use the project-local gdwiki skill to enrich up to <BATCH_SIZE> highest-priority
draft wiki pages. Read .metaproject/index.md and the gdwiki SKILL.md first.

Prepare deterministically: rebuild the graph only if it is stale, run keryx wiki
collect, and rebuild the wiki index. Prioritize draft pages by how many files depend
on them. For each page, read only the key files listed in its generated Reference
section plus the minimum additional code needed to verify claims.

Use a cheaper model for page enrichment. If subagents are available, dispatch one
per page and keep the batch bounded. Fill Overview, How it works, Key concepts, and
Main flows; preserve the generated Reference section exactly. Ground every claim in
code, set completed pages to Status: accepted, and bump their versions.

Review a sample for accuracy, then run keryx wiki index, keryx wiki check-links,
and keryx wiki validate. Report pages enriched, pages still draft, validation
results, and the recommended next batch. Do not commit or push.
```

### Update pages after recent changes

```text
Use the local gdwiki skill to update wiki coverage for changes since <GIT_REF>.
Run keryx wiki collect --changed --since <GIT_REF>, enrich only the newly created
or refreshed draft pages, preserve generated Reference sections, verify claims
against the listed key files, mark completed pages accepted with bumped versions,
then run wiki index, check-links, and validate. Report changed pages, remaining
drafts, and failures. Do not commit or push.
```

## Do managed work

### Implement a feature through a flow

```text
Create or resume a keryx flow for <ISSUE_OR_FEATURE>. Freeze explicit acceptance
criteria before implementation, create atomic context, implementation, test,
verification, review and docs tasks, and keep every flow state change inside the
keryx flow CLI. Implement on a feature branch, run changed-scope tests and health
checks, update documentation, and stop before commit, push, or pull request unless
I approve them.
```

### Review the current branch

```text
Review the current branch against its merge base. Use keryx ctx for the diff and
keryx gdgraph affected for changed files and shared modules. Check logic,
architecture, security, performance, testing, and repository conventions. Produce
only actionable findings with severity, file, line, evidence, and a concrete fix.
Do not modify code unless I explicitly approve fixes.
```

### Record the review as a managed package

```text
Run a managed review for <TARGET_KIND> <TARGET_REF>. If a matching flow exists,
attach the review to it; otherwise create a standalone review package. Record every
selected and skipped reviewer, findings, decisions, report, and learning candidates.
Validate the package before completion and report its path and status.
```

### Record a decision

```text
Record the accepted decision about <DECISION> in keryx memory. Search for duplicates
and conflicts first, choose the correct memory type and scope, cite the source or
issue, keep the entry in draft unless acceptance is explicit, rebuild the memory
index, run memory check, and report the created path.
```

## Check before handing off

### Verify a change

```text
Verify the current changes without editing them. Run the complete applicable gate:
diff hygiene, type checks, tests, build, related-test discovery, wiki links,
Standard validation, strict code health, and security policy. Return a structured
PASS/FAIL result with exact commands, failures, affected files, and release impact.
```

### Audit before a release

```text
Perform a non-destructive release audit. Check type checks, full tests, build,
package dry-run, Standard validation, strict code health, wiki links, memory
integrity, flow consistency, security policy and evaluation, generated-file policy,
package contents, stale plans, and dead links. Classify findings as P0, P1 or P2,
identify what must not be deleted blindly, and do not remove anything without
separate approval.
```

### Prepare a release without publishing

```text
Prepare release <VERSION> without publishing it. Verify every required gate, confirm
the working tree and package contents, update the changelog, bump package metadata
consistently, draft release notes, and give me the exact commit, tag and publish
commands for approval. Stop before commit, tag, push, publish, or creating a release.
```

## Next steps

- [Give an agent context](give-an-agent-context.md): what the agent sees when it starts.
- [Managed work](../modules/managed-work.md): flows, reviews and their gates.
