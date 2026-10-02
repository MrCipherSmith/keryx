# Built with Keryx

Keryx is developed with Keryx. The repository commits its own `.metaproject/`
directory, so the record of how each change was planned, reviewed and accepted
sits next to the code it produced, and you can read it on GitHub.

This page explains what is in that record, walks through one piece of work end
to end, and says where the record is incomplete.

## The claim

Every non-trivial change to Keryx goes through a *flow*: a directory with a
written problem, acceptance criteria frozen by checksum before work starts, a
task list, a journal, review rounds and the pull request that closed it. A flow
completes only when every criterion is confirmed against recorded evidence and
the completion gate passes.

As of 1 October 2026, measured on `main`, the repository held 343 flows and
1,722 commits since the first commit on 10 July 2026. The full set of figures,
the commit they were measured on and the commands that reproduce them are on
[Project status](status.md#numbers).

## Map of the workspace

The `.metaproject/` directory of this repository has the same layout that
`keryx init` creates in yours. Some parts are written by hand, some are written
by Keryx commands, and some never reach git.

| Path | What it holds | Origin |
|---|---|---|
| `flows/` | One directory per piece of managed work | `flow.json` is written by `keryx flow`; the Markdown files are written by people and agents |
| `wiki/` | Architecture and component pages | Architecture pages are hand-written; component pages are generated summaries |
| `memory/` | Lessons, known mistakes, constraints, review notes | Hand-curated, one file per entry |
| `rules/` | Coding, git, review, testing and security rules | Hand-curated, some installed by Keryx |
| `skills/` | The installed skill tree that agents follow | Installed from the Keryx package |
| `reviews/` | Review packages not attached to a flow | Written by `keryx review` |
| `data/` | Graph summaries, testing context, provenance, freshness records | Generated |
| `index.md`, `routing.md` | The routing pointers an agent reads first | Hand-curated |
| `runtime/`, `data/**/raw`, `data/**/storage` | Caches, raw logs, local state | Generated and git-ignored |

The full layout is described in
[Workspace and lifecycle](../workspace-and-lifecycle.md), and the rules for
what is committed are in
[Versioned vs gitignored](../workspace-and-lifecycle.md#versioned-vs-gitignored).
The repository's own
[`.metaproject/README.md`](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/README.md)
is the entry point.

## Anatomy of a flow

A flow directory is named `<id>-<date>-<slug>/` and contains:

| File | Purpose |
|---|---|
| `description.md` | The problem, the expected outcome and what is out of scope |
| `context.md` | What was read before planning: code paths, prior decisions, constraints |
| `acceptance-criteria.md` | The criteria, frozen by `keryx flow freeze`; the checksum is stored in `flow.json` |
| `plan.md`, `tasks.md` | The approach and the task list with dependencies |
| `journal.md` | A timestamped log of task state, criteria changes and completion attempts, plus free-form notes |
| `reviews/` | One directory per review round: findings, dispositions and the report |
| `flow.json` | State owned by the CLI: status, tasks, confirmations with evidence, signatures, the pull request and the merge commit |

The status moves `initializing → ready → in-progress → implemented → completing
→ done`, with `blocked` available at any point. Criteria can change after the
freeze only through `keryx flow ac update`, which records a reason and voids
earlier confirmations. The directory's own
[`README.md`](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/flows/README.md)
has the short version.

## A worked example

[`225-2026-09-03-living-wiki-graph-phase-0-describes-edge`](https://github.com/MrCipherSmith/keryx/tree/main/.metaproject/flows/225-2026-09-03-living-wiki-graph-phase-0-describes-edge)
connected the wiki to the code graph, so that "which pages describe this file"
became a query instead of a guess. It shows the parts of the process that are
hard to see from the merged code alone.

1. **The problem was measured first.** `description.md` records that 28 of 42
   component pages had drifted from the code they described, and that no page
   recorded what it was last verified against.
2. **Criteria were frozen before code.** Twelve criteria, each one checkable:
   for example, a reverse query for a file covered by two pages returns both and
   nothing else.
3. **The design changed mid-flight, on the record.** The specification put wiki
   pages into the graph's main node file. Implementation found five call sites
   that treat every non-asset node as a source file, so a wiki page would have
   become a fake module. The journal explains the reversal, the criteria were
   re-cut through `keryx flow ac update`, and a thirteenth criterion was added to
   pin the guarantee: the graph's existing files stay byte-identical whether or
   not a wiki exists.
4. **A cost was measured, not assumed.** The plan named hashing every file as a
   risk. The journal records the result: the new layer took 37 ms of a 2,335 ms
   build.
5. **Each criterion was confirmed with evidence.** Every confirmation in
   `flow.json` names the test that proves it.
6. **The completion gate refused five times.** The first attempt had no review
   on record. Later attempts were refused because a finding marked fixed named no
   commit, because a fix had no verifier verdict, and because the last clean
   review ran against a commit that was no longer the pull request head. Six
   review rounds are in `reviews/`. The flow reached `done` only when every
   condition held.

## Review loops

Reviews are stored as packages: findings with a severity and a `class_scope`,
the disposition of each finding, and a verifier's verdict on each fix. A fix
round is reviewed like new code, because experience on this repository showed
that it is new code. The lessons in the next section come from that history.

Across the main branch, 124 flows carry a `reviews/` directory with 284 review
rounds between them (figures as of 1 October 2026; see [Project status](status.md#numbers)). The record is not uniform: some finished flows were
reviewed outside the flow directory, or not at all.

## Memory and rules

`.metaproject/memory/` holds lessons that came out of specific failures. Four of
them, summarised:

- [A fix round needs its own review](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md).
  Three consecutive fix rounds each introduced a new blocker while closing the
  previous one. What stopped it was a test that covers every member of a class,
  not more care: one guard that fails while any sibling is still wrong.
- [An allowlist is not a boundary](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/memory/lessons/allowlist-not-a-boundary.md).
  A glob pattern matched against a command string that a shell later
  re-interprets grants far more than it appears to. The approval gate now relies
  on default-deny, a metacharacter check on the command and a destructive-command
  classifier.
- [Regex guards lose to spellings](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/memory/lessons/regex-guards-lose-to-spellings.md).
  Source-text guards were defeated one spelling per review round, and moving them
  to the syntax tree only slowed that down. The rule that replaced them: look for
  a real oracle first, and if there is none, call the guard a heuristic and keep
  its known gaps as tests.
- [Branching on a value whose domain you never wrote down](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md).
  Every blocker in six review rounds came from an `if` on a value with more
  meanings than the code assumed. The three places that used a total `switch`
  over a union had none.

A lesson becomes binding in two ways. A memory entry with status `accepted` is
included in what the review pipeline gives reviewers, so the next review checks
for it. A review lesson can also be written into a project skill with
`keryx skills learn`. The rules themselves live in `.metaproject/rules/core/`,
for example the
[definition of done](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/rules/core/definition-of-done.mdc).
You can search the memory of this repository with `keryx memory search "<query>"`.

## Wiki and graph

The architecture pages under `.metaproject/wiki/architecture/` (the sandbox,
permission modes, the agent bus, the project map and others) are hand-written.
The component pages are generated module summaries, useful as a generated
reference rather than as curated documentation.

The worked example above is what links the two. Each page can carry a
`VerifiedAt` commit and a `VerifiedScope` hash of the code it describes, and a
graph build adds `describes` edges from pages to files. A change to a file can
then be traced to the pages that may now be wrong. Agents working on this
repository are routed to the graph (`keryx gdgraph`) and to compact search
(`keryx ctx rg`) before raw file search, and to the wiki before deep code reads.

## Honest limits

- **Not every file is curated.** Component wiki pages, the dashboard and most of
  `data/` are generated. Component pages are refreshed by commands, not
  reviewed page by page, and can lag behind the most recent work.
- **Some working notes are in Russian.** Most records are in English, but a
  number of journals and context files are not.
- **Open flows are normal.** Flows in `initializing`, `in-progress` or `blocked`
  are visible, and some were parked rather than finished.
- **Flow ids are allocated per clone.** Two branches can create the same id; the
  second one is renumbered when it merges (`keryx flow renumber`).
- **Records carry identities.** A signature falls back to the local git email
  when no signer is named, so flow records contain the maintainer's public commit
  address.
- **History was rewritten once.** The tag `pre-trailer-strip` marks the state
  before commit trailers were removed from history.
- **One primary maintainer.** Most commits come from one person working with
  agents; the record shows how that work was checked, not that a team reviewed
  it.
- **Only some flows are linked here.** A flow was linked only after a check for
  personal paths, personal addresses and third-party project names. Other flows
  in the directory have not all passed that check.

## Reproduce it

Create the same structure in your own repository and open a flow:

```bash
cd path/to/your-project
keryx init --yes
keryx flow init --title "Add a health badge to the README"
keryx flow list
```

```text
Flows (1)
  001 [initializing] Add a health badge to the README (tasks 0/4)
     .metaproject/flows/001-2026-10-01-add-a-health-badge-to-the-readme
```

The new directory holds `description.md`, `context.md`,
`acceptance-criteria.md`, `plan.md`, `tasks.md`, `journal.md` and `flow.json`.
Write the criteria, then run `keryx flow freeze <id>` and
`keryx flow start <id>`. The full lifecycle is in
[Managed work](../modules/managed-work.md), and the reasoning behind the
workspace is in [The Metaproject](../concepts/metaproject.md).

To read a flow in this repository, start with `description.md`, then
`acceptance-criteria.md`, then the journal from the bottom up: the last entries
say how it ended.
