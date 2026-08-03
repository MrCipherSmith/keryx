# Community Documentation Plan

Status: proposed
Created: 2026-08-03
Owner: unassigned

## Why this exists

`keryx` is about to be shown to people who have no context for it. Today's
documentation was written *for the people building it* — it is accurate,
detailed, and organised around the source tree. A stranger arriving from a link
has a different problem: they do not yet know what this is, whether it is for
them, or what the first five minutes look like.

This plan covers that gap. It does **not** propose rewriting the developer
documentation, which is good and should stay.

## What is actually wrong today

Measured on 2026-08-03, not asserted:

| Observation | Evidence |
|---|---|
| Six top-level commands were absent from the CLI reference | `shell`, `sessions`, `harness`, `projects`, `serve`, `metrics` — all eleven "serve" hits in the file were `mcp serve`. Fixed in this pass. |
| The README never mentioned the remote entry | `keryx serve` shipped across three flows; the README's last touch was 2026-07-24. Fixed in this pass. |
| The roadmap declared shipped work unstarted | The `R4c` row read `not started` after PR #220 merged. Fixed in this pass. |
| The version number means nothing | `package.json` reads `0.1.0`; the last tag is `v0.1.0`; ~570 commits have merged since. |
| `architecture.md` predates most of the system it describes | Last touched 2026-07-12, before the OS sandbox, the harness expansion, the TUI shell and remote entry. |
| There are no diagrams | Zero rendered images or diagram sources across `docs/`. The architecture is described entirely in prose. |
| There is no published site | No mkdocs, Docusaurus, or Pages workflow. Documentation is readable only by browsing the repo. |

The community-facing surface that *does* exist and is in good shape:
`LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and
GitHub issue templates.

## The principle this plan is built on

The project's own hardest-won lesson applies directly to documentation:

> Every blocker in six review rounds came from **branching on a value whose
> domain was never written down**.
> — `.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md`

The documentation equivalent is a **claim whose evidence was never written
down**. Six review rounds on one branch found the composition of defects
shifting from code toward claims stronger than their evidence. Published
documentation is that failure mode with an audience.

So every phase below has an explicit evidence rule, and the acceptance test for
this plan is not "the pages exist" but **"no page asserts something a reader
can disprove in five minutes"**.

Two standing rules for all phases:

1. **Every command shown must have been executed.** Copy-paste blocks are
   verified by running them, not by reading the source that implements them.
2. **Every limit is stated where the capability is described**, not in a
   separate "limitations" appendix nobody reaches. `serve` has no approvals; the
   proxy is macOS-only; the AST guards are heuristics. A reader meeting the
   feature meets its boundary in the same breath.

## Phases

### Phase 1 — Stop the bleeding (correctness)

**Goal:** nothing published is false. This is a prerequisite for every other
phase and is largely done.

| Item | State |
|---|---|
| Roadmap `R4c` row and package changelog | **done** (this pass) |
| `keryx-remote-entry` package status table | **done** (this pass) |
| README: remote entry section, module list, version caveat | **done** (this pass) |
| `CHANGELOG.md`: sandbox, harness, TUI, remote entry, security, known gaps | **done** (this pass) |
| CLI reference: `shell`, `sessions`, `harness`, `projects`, `serve`, `metrics` | **done** (this pass) |
| `docs/report/release-readiness-2026-08-03/` | **done** (this pass) |
| `docs/docs/README.md` "no always-on HTTP server" claim qualified | **done** (this pass) |
| `keryx metrics` top-level help omits `compare` and `rebuild` | open — a source fix, not a docs fix |

**Evidence rule:** each row cites the file and the command that shows it.

### Phase 2 — Decide the version story — **done**

**Goal:** a reader can tell what they are installing.

| Decision | Outcome |
|---|---|
| Next version | **`0.2.0`**. `1.0.0` would overclaim — R4d–R4f are open, approvals are unimplemented, containment is macOS-only. |
| npm publication | **Yes**, as **`@mrciphersmith/keryx`**. |
| Release automation | `.github/workflows/release.yml`, triggered by a `v*` tag only. |

**The name collision, recorded because it will come up again.** The unscoped
name `keryx` on npm belongs to
[actionhero/keryx](https://github.com/actionhero/keryx) — an actively
maintained fullstack TypeScript framework *for MCP and APIs*, at `0.42.1`, with
its own site at keryxjs.com, published the same day this was discovered. It is
adjacent in subject matter, which makes the collision worse than a random
clash: `npm install -g keryx` silently installs a different program in the same
problem space. The scoped name resolves the packaging problem. It does **not**
resolve the discoverability problem — see Phase 7.

The release workflow enforces three things that are easy to get wrong once and
never notice:

- **The tag and `package.json` must agree**, checked before anything is built.
  Two independent statements of one fact; disagreement is a hard stop.
- **The packed tarball is installed and run** before it is published, so
  "it builds" is never mistaken for "it works".
- **The changelog section for the version must be non-empty**, or the job fails.
  Blank release notes look intentional, which is worse than none.

**Evidence rule:** the release job's own smoke step is the evidence — it installs
the tarball into a clean prefix and runs the binary.

**Outstanding, and needed before the first publish:** an `NPM_TOKEN` repository
secret with publish rights. The workflow uses `--provenance`, which additionally
requires the `id-token: write` permission (already set).

### Phase 3 — The first five minutes

**Goal:** someone who found the repo from a link understands what it is and gets
one real result, without reading the architecture.

- **Rewrite the README's opening.** The current first line — "One project-local
  brain for your AI agents and your team" — is a good tagline attached to a
  paragraph that immediately becomes a feature list. It should instead answer,
  in order: what problem this removes, what it looks like when it works, and who
  it is not for.
- **One honest end-to-end example**, from `keryx init` to a result a reader can
  see, on a small public repository, with the real terminal output pasted in.
  Not a synthetic transcript.
- **A "is this for you?" section** naming who should *not* install it: people
  who want a hosted service, people on Linux who need the network allowlist,
  people who need remote approvals today.
- **Asciinema recordings** of `keryx shell` and one `gdgraph` query. The TUI is
  the most persuasive thing in the project and is currently invisible in text.

**Evidence rule:** the walkthrough is executed end to end on a clean machine
(or a fresh container) and the pasted output comes from that run.

### Phase 4 — Architecture that can be seen — **done**

**Goal:** replace 310 lines of prose with something a reader can hold in their
head.

Five diagrams landed in `docs/docs/architecture.md`, authored as **Mermaid in
Markdown** so they diff in git and need no build step or binary assets. The
document was **corrected rather than rewritten** — most of its 310 lines were
accurate, and replacing good prose with new prose would have traded verified
content for unverified content.

What the audit changed about the plan, which is the interesting part: the
diagrams could not simply illustrate the existing text, because the text was
wrong in ways the source revealed. Three of the five carry a correction:

- The system-context diagram had to stop saying "no HTTP server".
- The harness diagram had to be preceded by **the two-tool-systems table**, and
  by the fact that no shipped path registers a tool at all — a single diagram of
  "the tool loop" would have been false in both directions.
- The containment diagram had to make the **macOS/Linux split structural**,
  because Tier 2 does not degrade on Linux, it refuses.

Also corrected while drawing: the module map gained the eleven missing rows
(harness, sandbox, tui, session, serve, projects, metrics, contracts), and a
module-versus-command discriminator, because listing `serve` and `review` as
modules was an error this plan's own author had introduced.

The original list, for the record:

1. **System context** — the human, the agent runtimes, the repo, and `keryx`
   between them. One picture answering "where does this sit".
2. **The `.metaproject/` workspace** — the directory contract, which module owns
   which path, and what is data versus what is managed. This is the single most
   load-bearing concept and is currently text only.
3. **A turn through the harness** — prompt in, policy decision, tool call,
   session append, result. This is what makes the allow/ask/deny model concrete.
4. **The remote entry request path** — bind, authenticate *before* routing,
   idempotency claim, profile comparison, run, stream. The security properties
   are ordering properties, and ordering is what a diagram shows best.
5. **Containment layers** — policy engine, OS sandbox, allowlist proxy,
   credential masking, and **which of them exist on which platform**. The
   macOS/Linux split must be visible in the picture, not a footnote.

**Evidence rule, applied:** every arrow corresponds to a named module or file,
and the decision nodes carry their `file:line`. The nine-step remote-entry
diagram is the ordered decision path from `security-policy.md`, quoted by
`serve-turn.ts:3-7`, which states that *the order rather than the set is the
control* — so it is drawn rather than listed.

**Still open in this phase:** asciinema recordings (they belong with Phase 3,
which is where the walkthrough lives).

### Phase 5 — Task-shaped guides

**Goal:** documentation organised by what someone is trying to do, not by which
module implements it. `modules.md` (1117 lines) and
`complete-setup-and-agent-workflows.md` (1025 lines) are reference material and
should stay reference material; these are the doors into them.

- *Give an agent context about my repo* — init, graph, wiki, orient.
- *Review a branch with a durable record* — the managed review lifecycle.
- *Run an agent against a repo without giving it my machine* — sandbox and
  policy, with the platform matrix stated up front.
- *Drive keryx from a bot or another product* — `serve`, tokens, the project
  registry, and the approval boundary.
- *Run keryx in CI* — the artifacts, the gates, the exit codes.

**Evidence rule:** each guide ends with the command that verifies the reader got
the intended result.

### Phase 6 — Publish

**Goal:** a URL, not a directory listing.

- **Recommend MkDocs Material.** Rationale: the content is already Markdown with
  relative links; Material renders Mermaid natively; it is a single Python
  dependency in CI and adds nothing to the runtime; and the project's "zero
  runtime dependencies" property stays intact because the site builds outside
  the package. Docusaurus would mean a Node toolchain and a heavier migration
  for no benefit here.
- Publish to GitHub Pages from a workflow on `main`.
- Keep `docs/docs/` as the source. Nothing moves; a config file selects the nav.
- Add a link check to CI so a broken link fails a pull request. `wiki
  check-links` already does this for the wiki (42 pages, 233 links, 0 broken);
  the same discipline should cover `docs/`.

**Evidence rule:** CI fails on a broken link. Not a checklist item — a gate.

### Phase 7 — Announce

**Goal:** the announcement sends people to something that holds up when they
arrive. It is last for that reason, not because it is least important.

**Blocked on Phases 3, 4 and 6.** Announcing to a repository whose architecture
document predates the architecture is how a good project acquires a bad first
impression it then has to argue against.

- **Settle the name question first.** The scope fixes `npm install`; it does not
  fix search. Someone told "keryx" who searches for it finds keryxjs.com — an
  active project in the adjacent MCP space. Three options, in descending order
  of how well they age: rename before there are users; keep the name and always
  write it with the scope and a one-line disambiguation; keep the name and
  accept the confusion. This is cheapest to decide **now** and gets more
  expensive every week.
- **Write the post around one demonstrated thing**, not the feature list. The
  strongest candidate is the property the whole project is organised around:
  agents and humans reading the same versioned context out of the repository,
  with nothing hosted and nothing phoning home. Show it with the asciinema
  recording from Phase 3.
- **State the boundaries in the post itself.** `0.2.0`, approvals not
  implemented, containment macOS-only. A reader who discovers a limit after
  installing feels misled; a reader told up front feels informed. The project's
  entire review history is an argument for the second.
- **Have the answers ready** to the three questions that will be asked: how is
  this different from just using an agent's own memory; what happens to my code;
  why Bun.

**Evidence rule:** every claim in the post links to something in the repository
that supports it. No number appears that a reader cannot re-derive.

## Sequencing

Phases 1 and 2 are **done**. They gated everything else: nothing should be
published while the documentation is false or the version is meaningless.

Phases 3–5 are independent of each other and can be worked in any order or in
parallel. Phase 6 comes after them, because publishing a site freezes the
structure. Phase 7 is last and is blocked on 3, 4 and 6.

Suggested order of remaining value: ~~3 → 4~~ **→ 6 → 5 → 7**, with Phase 3
still open. Phases 1, 2 and 4 are done. Phase 5 is the largest and benefits most
from being written now that the diagrams exist to link into. The one thing worth
pulling forward out of order is the **name decision** in Phase 7 — it gets more
expensive every week and is nearly free today.

## How this plan gets checked

Run against the plan itself before calling it done:

- Does any page state a capability without its boundary? (Phase rule 2)
- Is there a command in any document that nobody has executed? (Phase rule 1)
- Does the architecture doc's date postdate the code it describes?
- Does `CHANGELOG.md`'s known-gaps list match `docs/requirements/roadmap.md`?

The last one is the one most likely to rot, because two files must agree. If
that pair drifts once, generate one from the other rather than maintaining both.
