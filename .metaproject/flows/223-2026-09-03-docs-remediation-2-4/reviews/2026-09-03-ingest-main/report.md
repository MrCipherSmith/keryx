# Review — flow 222, docs remediation phases 2-4 (PR #440)

**This is a self-review, and it is labelled as one.** A single author reviewing
their own change cannot supply the independence a second reader would, and
recording it as anything else would be the exact defect class this flow was
opened to fix: a record asserting something the process did not establish. What
it can supply honestly is the finding record — what was found while doing the
work, by what means, and what became of each one.

The findings below were not found by re-reading the diff. Every one was found by
a mechanism: a mutation run, or a test written to derive an expectation from
code rather than restate it. That is the only reason a self-review is worth
recording here at all.

## Findings

### F1 — the table-contiguity guard passed on the defect it was written to catch

`severity: major`

The first version of `the architecture module map is one contiguous table`
walked forward from the header row while lines still began with `|`, then
asserted every line it had seen began with `|`.

A split table looks exactly like that from the inside. The walk stops at the
blank line, every line it saw was a row, and the assertion holds. Injecting the
blank line the test exists to catch produced **4 pass / 0 fail**.

The guard was also protected by `expect(end - start).toBeGreaterThan(20)`, which
did not help: the surviving first fragment was still 21 rows long. A magnitude
guard does not distinguish "the whole table" from "most of the table".

Rewritten to span the header row to the last row **before the next `##`
heading**, so the blank line falls inside the measured region. Re-mutated:
**3 pass / 1 fail**. Restored: green.

### F2 — the CLI surface was miscounted by reading, and one subcommand was invisible

`severity: major`

The review document behind this flow stated `keryx workspace` has sixteen
subcommands and five were undocumented. Both numbers came from reading the
router.

The test written for AC7 — which scrapes `subcommand === "x"` from
`workspace.ts` rather than restating a list — failed on its first run against a
seventeenth: `dismiss-candidate`. It is fully implemented, takes `--reason` and
`--evidence`, resolves a session id to its newest slate archive, and appeared in
**no** manifest, **no** help banner and **no** documentation page.

Added to `MODULE_COMMANDS.sac`, the help banner and the CLI reference. The
review document is corrected in place rather than silently, because the miss is
the evidence for the guard.

### F3 — `MODULE_COMMANDS` for `sac` was two hand-written copies, both stale

`severity: major`

`workspace-and-lifecycle.md` documents manifest `commands[]` as coming from
`MODULE_COMMANDS`, "single source of truth". For `sac` it came from neither:
one hand-written array in `init.ts` and a second in `update.ts`, both listing
ten of seventeen subcommands, each with a comment explaining why it was written
out by hand.

Same shape as the guard-on-one-write-path-of-two defect 0.2.75 fixed in code: a
list duplicated across write paths is only as accurate as its least-maintained
copy, and here both copies had drifted identically, which is what makes the
duplication invisible to a reader comparing them.

Consolidated into `MODULE_COMMANDS.sac`; both generators call
`moduleCommands("sac")`.

### F4 — a security control shipped in 0.2.75 was undocumented everywhere a user looks

`severity: major`

`--acknowledge-security` on `keryx workspace confirm-review` is the human
acknowledgement gate for a `needs-approval` proposal. It existed in
`src/commands/workspace.ts` and in the CHANGELOG. It was absent from
`cli-reference.md`, from `guides/shared-agent-context.md`, and from the
command's own usage banner — present only inside a thrown error string.

An operator hitting the refusal therefore had no documented way forward. Now
documented in all three, with the 0.2.74/0.2.75 history that got it wrong in
opposite directions.

### F5 — two `architecture.md` caveats warned about bugs that no longer exist

`severity: minor`

The file stated as live caveats that `security` is absent from `keryx modules`'
module list and cannot be toggled there, and that toggling any module drops an
enabled `mcp`.

Both tested on 0.2.76 in a throwaway repository before deletion:
`modules disable security` sets `enabled: false`, and `mcp` survives a toggle
untouched. A stale warning teaches a reader to route around a working command,
which is worse than saying nothing.

### F6 — the site never mentioned the install path the project publishes

`severity: major`

`npm install -g @mrciphersmith/keryx` appeared zero times as an install
instruction on the built site. `docs/docs/README.md` carries it but is excluded
from the build; `cli-reference.md`'s occurrence is the upgrade command, which
presumes the package is already installed. `scripts/install-binary.sh` appeared
nowhere on the site at all.

### F7 — `slate` was exported by the manifest and named by no page

`severity: major`

`expose.modules` lists `slate` in real project manifests. Outside its own guide,
`guides/goal.md` and one line of `guides/shared-agent-context.md`, the word
appeared zero times across `README.md` and every core documentation page.

### F8 — `modules.md` stated a toggle does not exist

`severity: major`

"It is not one of the nine default `init` modules and has no `modules.sac`
toggle". Running `keryx modules enable sac` writes `modules.sac.enabled = true`
with a full module block. The first half is true; the second is false.

## Dismissed, with reasons

- **`install-binary.sh` verifies no checksum on the downloaded binary.** Real,
  and noted in the flow's Out of Scope. It is a supply-chain decision — where
  the expected digest comes from — not a documentation one, and answering it
  inside a docs flow would be answering it badly.
- **`keryx commands` excludes most verbs.** AC12 required the rule be *stated*,
  which it now is. Whether the registry should be wider is a product question
  this flow deliberately does not settle.
- **The top-level usage banner omits `orient`.** Real, and out of the frozen
  criteria. Recorded here rather than fixed silently or forgotten.

## Coverage and limits, stated

- Verification of every documentation claim in the changed pages was **not**
  attempted. The four guards cover structural coverage — verbs, subcommands, nav
  parity, table integrity — and nothing checks that a sentence is true. That gap
  is the subject of the flow, not something it closes.
- `mkdocs build --strict` could not run locally (`python3-venv` absent). It
  passed on the PR's Docs job, which is where that evidence comes from.
- No independent reviewer read this change.
