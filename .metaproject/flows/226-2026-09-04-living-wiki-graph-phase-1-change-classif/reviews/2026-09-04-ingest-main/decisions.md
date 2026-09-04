# Decisions

- F-NEW-001: acted-on — Keys are now path#container.name, with the trade-off recorded at the site: same-named siblings collapse into one key, under-reporting a same-name overload change, which is the safe direction against firing on every reflow. Fixed on the reviewed branch at affe3337, merged into main as 060453b6. (valid_followup, post_flow_feedback).
- F-NEW-002: acted-on — Quoted paths now set truncated=true and the entry is recorded rather than skipped; the probe reports two queue lines with the second carrying paths: []. Fixed on the reviewed branch at affe3337, merged into main as 060453b6. (valid_followup, post_flow_feedback).
- F-NEW-003: acted-on — Now diffs `<base> HEAD` and reads the after side via `git show HEAD:<file>`, falling back to the worktree only where git cannot answer. Fixed on the reviewed branch at affe3337, merged into main as 060453b6. (valid_followup, post_flow_feedback).
- F-NEW-004: acted-on — Reasons are deduplicated by source and class, keeping the shortest edge path. Fixed on the reviewed branch at affe3337, merged into main as 060453b6. (valid_followup, post_flow_feedback).
