# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: After `git pull` on a clone, `keryx flow list` has no duplicate id, `keryx flow check` reports all flows consistent, and `keryx product index` lists as many flows as there are flow folders in git. Shown on this clone after the renumbering and the folder commit PR, and on a second clone.
- AC2: `keryx flow init` in a clone that is behind origin does not take a number used by a flow folder on any `refs/remotes/*` branch it already knows (no network call); a test builds a repo whose remote branch holds flow 5 and the next init gets 6 or higher.
- AC3: `keryx flow complete` refuses with a message that names the folder and the fix when the flow folder is not tracked in git or has uncommitted changes; the green path still completes. Covered by tests for both.
- AC4: `keryx flow check` reports a flow number that exists locally and on a known remote branch under a different folder name, and names `keryx flow renumber`. A test covers it; a flow present under the same folder name on both sides is not reported.
- AC5: Every flow folder, review record and review note that was untracked is in main after the PR; no reference to the old ids 360–365 of the renumbered flows lacks an entry in `.metaproject/flows/id-map.json`.
- AC6: The rule "the flow folder is committed in the same PR as the code and at closing" is written in the flow skill/rule files, `docs/docs/cli-reference.md` and CHANGELOG, together with the cross-clone id behaviour; docs and README stay consistent with the code.
- AC7: In the TUI, the `/governance` flow list and `keryx flow check` show a duplicate-id or untracked-folder warning for the affected flow; a test renders it.
