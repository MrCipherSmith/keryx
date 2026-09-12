# The SHAs these reports were written against

This branch was rebased onto `main` four times while the review rounds ran, so
most of the commit ids the reports quote no longer exist on it. The reports are
left as they were written — they are a record of what was checked and when — and
this table is how a reader resolves a citation that `git show` cannot find. The
verifier claims in `flow.json` and the findings packages were re-anchored onto
the right-hand column; the report bodies were not.

| as written in the reports | on the branch today | what it is |
|---|---|---|
| `50d2dd0c` | `b6dfa8cd` | the tree round 1 reviewed — after T18 moved the tokenizer |
| `62cd9424` | `0a4b9430` | the stale-build sweep cannot delete outside the installed tree |
| `ce8e43c9` | `fc8323ea` | the anatomy checks read substance, and the ceiling ratchet is a test |
| `580dc5c2` | `9a1b0e74` | point the clauses, commands and rules at what is actually there |
| `437a6f3e` | `bb28ab6a` | the rank-1 record is two integers |
| `5eee9eed` | `6a74e1b4` | sweep companion prompts, parse frontmatter, stop hardcoding npx tsc |
| `03c2d1c6` | `7ee6a712` | the tree round 2 reviewed |
| `a91679b9` | `953f1c35` | a successful removal is a notice |
| `731a8ef1` | `d09f28d0` | the tree round 3 reviewed |
| `aa209ae4` | `bbd6e7ce` | the symlink test drives the sweep |
| `ae2ff9b7` | `ae2ff9b7` | the tree round 4 reviewed (survived the last rebase) |
| `162e34db` | `162e34db` | the comment claims only the coverage that exists |
| `a1ea358c` | `a1ea358c` | an install-level test for the symlinked category |
| `a13c0e8b` | `a13c0e8b` | the copy follows a symlinked category, and the test says so |

Written when flow 257 closed. If the branch is rebased again before it merges,
the right-hand column moves and this table is the thing to update — or delete,
once the work is a single squashed commit on `main` and none of these ids
resolves anyway.
