# Roadmap

This page states direction, not commitments. Nothing here has a date, and an
item can move, change shape, or be dropped. What has shipped is in the
[changelog](CHANGELOG.md); the current limits are on the
[Limitations](https://mrciphersmith.github.io/keryx/limitations/) page.

## Stability

Keryx is pre-1.0 and releases often. Until 1.0, a minor version can change a
command, a flag, or a file format; such changes are recorded in the changelog,
and a renamed command keeps working under its old spelling for a while.

| Status | What it covers |
| --- | --- |
| Stable | The nine default modules (code graph, compact command output, wiki, skills, health, testing, memory, task flows, security), `keryx shell`, model providers, flows, review packages. |
| Experimental | Shared Agent Context; the review-service checks for scenarios, docs and comments; per-runtime context hooks for some agents; the seven agent integration adapters marked `experimental` in the integration registry (`keryx integrations matrix` lists them). |
| Opt-in | The MCP server, Shared Agent Context, external agent CLIs, the remote HTTP entry. Off until you enable them. |

Stable means the behaviour is tested and documented and changes are announced,
not that the interface is frozen. 1.0 will mean the interface is frozen.

## Now

Work in progress.

- **A leaner agent-first core.** Better retrieval from the wiki and repo map
  within a fixed output budget, fresher context delivered to agents, atomic
  changes to project state with recovery, a library surface for batch use, and a
  clean split between the deterministic core and the optional shell.
- **Routing by what work costs.** Recording tokens and cost per model and task
  category, so the routing table can prefer the model that is cheaper for a kind
  of work, and sorting each shell request into a category.
- **Model guidance in agent instructions.** Writing which model suits which kind
  of work into the instructions that Claude Code and Codex read.
- **Keeping private work in-house.** A switch that stops private work being sent
  to chosen providers.
- **Providers and sign-in.** OpenAI API and ChatGPT subscription as separate
  working providers; OAuth for remote MCP servers.
- **Review pipeline.** Reviews that fail closed: a plan is display-only,
  exhausted reviewers report, inventories and publication are checked; importing
  reviewers from other sources.
- **Shell polish.** Cancellable foreground operations, a read-only plan mode,
  startup and sidebar improvements.
- **Documentation.** A docs site with guides per area, accurate against the
  code, and this repository's own `.metaproject/` as a worked example.

## Next

Planned once the current work settles.

- **Strict flags everywhere.** Commands that today ignore an unknown flag should
  refuse it and name it.
- **Diffs against the merge base.** Review scope and blast radius should compare
  against the point where a branch forked, not the base tip.
- **Say "could not tell".** Quality runs should report an unmeasurable signal as
  unknown instead of passing it.
- **Forgetting that propagates.** Deleting knowledge removes it across graph,
  wiki and memory, and leaves a trail.
- **Flow records know their base branch**, so completion can check where the
  merge landed; acceptance criteria that cite the CI result on the pull request
  head rather than a local run.
- **Evidence for skills.** Behavioural evaluations of skills with a control arm,
  and re-measuring orchestrators against each other.
- **Scanner hardening.** Closing known gaps in the personal-data patterns.
- **Smaller shell code.** Splitting the two largest shell files once their tests
  stop reading them as text.

## Later

Wanted, but blocked on a host, a design decision, or demand.

- **Windows.** Verification in CI and native containment for agent runs.
- **Stronger Linux sandbox.** Landlock and seccomp hardening, and the domain
  allowlist and credential masking that today exist only on macOS.
- **Optional semantic search.** An embedding runtime for memory search and ML
  classifiers for the scanner; today both run on deterministic rules.
- **Remote approvals for tool-using turns**, which need a tool registry behind
  the remote entry.
- **Merging session branches**, which today diverge permanently.
- **1.0.** A frozen command and file-format surface for the stable set. There
  is no target version or date.

## Influence the roadmap

Open an issue using the feature request form, or comment on an existing one.
Requests that describe the problem you have, not only the feature you imagine,
are the easiest to place. See [SUPPORT.md](SUPPORT.md) for where to ask.
