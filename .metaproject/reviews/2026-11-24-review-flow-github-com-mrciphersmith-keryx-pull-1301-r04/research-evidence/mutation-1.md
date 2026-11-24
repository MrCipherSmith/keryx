# Mutation pass

Command: `sh -c 'cd apps/desktop && { test -e node_modules || ln -s /Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules node_modules; } && bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts'` (baseline exit 0, 970 ms). Run in a scratch copy; the worktree was not written.

Cost: provenance 428 ms, copy 28789 ms, mutants 4030 ms, load 9.9/9.9/11.1.

started 2026-11-24T09:48:32.375Z, head 0d6df293794f, treeHash 99ef61594901.

Killed 3, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result | Test command | Exit |
|---|---|---|---|---|---|
| M1 | apps/desktop/src/metaproject/MetaprojectTree.tsx:91 | `  return next ?? rows[at];` → `  return next ?? after[0];` | killed | `sh -c 'cd apps/desktop && { test -e node_modules \|\| ln -s /Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules node_modules; } && bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts'` | 1 |
| M2 | apps/desktop/src/metaproject/MetaprojectTree.tsx:90 | `  const next = parent === undefined ? after[0] : after.find(row => row.parent === parent);` → `  const next = after[0];` | killed | `sh -c 'cd apps/desktop && { test -e node_modules \|\| ln -s /Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules node_modules; } && bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts'` | 1 |
| M3 | apps/desktop/src/metaproject/MetaprojectTree.tsx:88 | `  if (at < 0) return undefined;` → `` | survived | `sh -c 'cd apps/desktop && { test -e node_modules \|\| ln -s /Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules node_modules; } && bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts'` | 0 |
| M4 | apps/desktop/src/metaproject/MetaprojectTree.tsx:191 | `      const target = handOffTarget(rows, lost.anchor, lost.parent);` → `      const target = undefined as ReturnType<typeof handOffTarget>;` | killed | `sh -c 'cd apps/desktop && { test -e node_modules \|\| ln -s /Users/tsaitler.aleksandr/work/sandbox/keryx/.claude/worktrees/mp-sidebar-tree/apps/desktop/node_modules node_modules; } && bun test ./src/metaproject/MetaprojectTree.dom.test.tsx ./src/metaproject/MetaprojectView.dom.test.tsx ./src/platform/metaproject.test.ts'` | 1 |

A survivor means no assertion pins that behaviour: the severity audit raises a finding to major only when no mutant in the same file was killed.
