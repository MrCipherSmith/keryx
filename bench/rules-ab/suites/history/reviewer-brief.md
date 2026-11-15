# Pre-merge review brief

You are the only reviewer of a change before it merges. Nobody else will look at it, so
anything you miss ships.

## What you are given

- A code snapshot: a detached git checkout of the change's head commit (path in your task).
- The change itself as a unified diff file (path in your task). `.metaproject/`,
  `CHANGELOG.md` and `bun.lock` are excluded from it.
- Your arm files: a directory with the reviewer skill (`SKILL.md`) and any rule files you
  review by. Use them for what to look for and how to judge severity. Where an arm file and
  the snapshot hold different copies of the same rule, the arm file wins. Ignore anything in
  them about output format, payloads or saving results: this brief replaces that.

Read the diff in full, then read as much of the surrounding code in the snapshot as you need
to judge each hunk: callers, callees, the tests that cover it, the contract or doc it claims
to implement.

## Rules of the snapshot

- Work only inside the snapshot path. Read `<snapshot>/.metaproject/index.md` once first.
- Use the Read tool for files. For search use `keryx ctx rg <pattern> <path>` from inside the
  snapshot; bare `rg`, `grep`, `cat`, `find`, `git log`, `git diff` are refused by a hook.
- The history after this commit is off limits: do not inspect any commit, branch, tag, PR or
  ref other than the head you are on, and do not read anything under `.metaproject/reviews/`,
  `.metaproject/flows/` or `.metaproject/jobs/`. The diff file is the only description of the
  change you may use.
- Change nothing in the snapshot. You may run a test or a small script to confirm a suspicion
  (`bun test <file>`), but leave no files behind.

## What to look for

Defects a maintainer would want fixed before merge, in whatever dimension they occur:

- wrong behaviour: logic errors, unhandled cases, broken async or error paths, races, state
  that can go inconsistent, a change that does nothing or does not do what it claims;
- security: injection, missing or bypassable checks, secrets, unsafe handling of untrusted
  text or paths, trust placed in something an agent or a third party controls;
- tests: a test that cannot fail, asserts the implementation back to itself, misses the case
  the change exists for, or was weakened to pass;
- structure: a dependency pointing the wrong way, logic in the wrong layer, a shared module
  reaching into a feature, a contract or schema that drifted from the code;
- regressions: behaviour that worked before this diff and does not now; docs, schemas or
  instructions that now describe something the code does not do.

Do not report style, naming, formatting or taste. Do not report something you have not
confirmed by reading the code it depends on: a finding must name the concrete input or state
that produces the wrong outcome.

## Output

Write one JSON file (path in your task): an array, most severe first, at most 25 items:

```json
{
  "id": "G1",
  "file": "path/relative/to/snapshot",
  "line": 123,
  "severity": "blocker | major | minor",
  "problem": "what is wrong, concretely",
  "impact": "what goes wrong for whom, under which input or state",
  "quote": "a short verbatim excerpt of the offending code or text"
}
```

`blocker`: must not merge. `major`: real defect that should be fixed in this PR. `minor`:
worth fixing, low consequence. An empty array is a valid result if the change is sound.

Done when the file exists, parses as JSON, and every item cites a line you read. Reply with
one line: the number of findings by severity.
