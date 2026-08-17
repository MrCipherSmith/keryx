# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: No slate-owned code path calls `flow complete`, `workspace propose`,
  or `workspace review` on behalf of a subagent.
- AC2: A subagent's Seeds/Anchors/Course never appear in the parent's own
  `slate.anchors`/`slate.course`/`slate.seeds` fields — only inside
  `parent.slate.childDispatches[dispatchId]`, a structural invariant, not a
  behavioral one.
- AC3: A subagent's slate is unreachable by any code path after the dispatch
  returns, except via its immutable `childDispatches` snapshot.
- AC4: Two wrap-up triggers firing close together for the same flow
  transition produce at most one accepted evidence set.
- AC5: Zero proposals created via this path ever reference
  `session-evidence/*.md` full-archive dumps.
- AC6: Wrap-up never attempts `propose` without a captured `workspaceId`;
  without one, it writes an `unbound-candidate` artifact instead.
- AC7: Wrap-up never invents/guesses a `kind` — untagged Seeds go to
  `follow-up`.
- AC8: A one-shot `keryx harness run`/`--goal` invocation with no Flow and no
  human "done" command still reaches wrap-up on process termination; a
  `keryx shell` REPL session never triggers wrap-up this way.
