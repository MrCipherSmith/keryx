# Flow 490 worker brief (shared by every implement dispatch)

Root: `/Users/Goodea/goodea/keryx/.worktrees/review-lens-contract` (branch `chore/review-lens-contract`). Before the first write run `cd /Users/Goodea/goodea/keryx/.worktrees/review-lens-contract && pwd && git branch --show-current`; run every git command as `git -C <root>`. Several workers edit this worktree at the same time, each on its own files: touch ONLY the files your task names. Never `git stash`, never `git add` anything, never commit, never run `keryx update`.

Read first: the flow's `description.md`, `plan.md` and `acceptance-criteria.md` in `.metaproject/flows/490-2026-11-14-review-lenses-one-reviewer-contract-one-/`. Search code with `keryx ctx rg <pattern> <path>` (bare rg/grep/cat are refused by a hook).

The canonical rubric every lens must agree with lives in `src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md`: sections "Severity (canonical)" (blocker / major / minor / info and the boundary test) and "Shared laws (every reviewer)". A lens may say which canonical condition a kind of finding usually meets and what evidence it needs; it may not assign a level the canonical text places elsewhere, set its own floor, or assume facts (load, reachability) the evidence does not show.

Rules for every lens edit:
- Edit `src/gdskills/bundled/skills/review/<lens>/SKILL.md`, then copy it byte-for-byte to `.metaproject/skills/gdskills/review/<lens>/SKILL.md` (same for any other file you change under a skill directory).
- Bump the skill's `metadata.version` (minor bump).
- Keep the net line count at or below the current count (`src/gdskills/skill-length-ceilings.ts` pins it exactly and may only go down). If you cannot, say how many lines over and why in your reply.
- Do not touch the shared laws block, the class-scope block or the `<!-- keryx:layers-block -->` block: tests derive them from the orchestrator and pin them identical across lenses.
- Keep every detection check (what to look for). You are fixing contradictions, side effects, stale references and targeting — not deleting coverage. When you move a check, keep its condition.
- Run `bun test src/gdskills` at the end and report failures that your files cause (ignore failures in files other workers own; name them).

Reply format: first line `STATUS: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`, then `changed_files:` (every path you changed, one per line), new line counts per edited SKILL.md, a short list of what you changed per file with the old→new severity where you changed one, and any concern.
