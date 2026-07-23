# Implementation Plan

Status: drafted at init (approach chosen, open questions listed below)

## Approach

Three layers, in this order — prevent, detect, repair:

1. **Prevent (allocation).** Make `nextFlowId` repo-wide instead of
   working-copy-wide. Resolve the allocation root through the git *common* dir
   (`git rev-parse --git-common-dir`), which is shared by every linked worktree,
   and keep both the `.flow-init.lock` and a small append-only allocation ledger
   there. All worktrees of one clone then serialize against the same lock and
   observe the same high-water mark, which is exactly the case that produced
   002/084/103. Fall back to today's local-directory behaviour when the repo is
   not a git checkout, so `flow init` never hard-depends on git.
2. **Detect (resolution + check).** `resolveFlowDir` must stop silently picking
   the lexicographically first candidate: when a bare numeric id matches more
   than one directory it throws with both candidates and the exact unambiguous
   references to use (full directory names). Add a repo-level duplicate-id rule
   to `keryx flow check` so a collision is reported by the existing gate rather
   than discovered by eye in `flow list`. `flow list` marks colliding ids.
3. **Repair (renumber).** Add `keryx flow renumber <dir> --to <id> --reason`,
   the only sanctioned way to change a flow's number: it moves the directory,
   rewrites `flow.json.id`, appends a `renumbered` history event, and records
   the old→new mapping so existing references stay traceable. Apply it to the
   later-created member of each colliding pair (002, 084, 103) — all three are
   `done`/`in-progress` packages whose ids are not load-bearing at runtime.

Rationale: allocation alone leaves the three existing collisions broken;
renumbering alone leaves the door open for the next pair of worktrees. Silent
first-match resolution is the part that can actually corrupt state today
(harness evidence and AC confirmations landing in the wrong package), so it is
fixed independently of both.

### Alternatives considered

- **Ambiguity-safe resolution only** (no allocation change). Cheapest, and it
  removes the corruption risk, but every future parallel-worktree pair still
  mints a duplicate that a human must then repair by hand. Rejected as
  incomplete.
- **Opaque ids (ULID / short hash) instead of `NNN`.** Collision-free by
  construction and clone-safe, but it destroys the readable ordering the whole
  repo, docs and PR titles depend on, and invalidates 115 existing references.
  Rejected: cost far exceeds the problem.
- **Renumber the existing three and change nothing else.** Restores a clean
  listing today, guarantees a repeat tomorrow. Rejected.
- **Global (cross-clone) id service.** Would also cover two independent clones
  of the repo, not just linked worktrees. Rejected as out of proportion — the
  observed failures are all worktree/branch-parallel within one clone, and the
  `flow check` rule catches the residual case at merge time.

## Steps

1. **Allocation root.** Introduce a resolver for the shared flow-allocation root
   (git common dir when available, local `.metaproject/flows` otherwise). Use it
   for both the `.flow-init.lock` path and the high-water-mark scan in
   `nextFlowId` (`src/flow/store.ts:23`, `src/flow/service.ts:133`). The ledger
   records ids already handed out even when the sibling worktree's directory is
   not visible from this checkout.
2. **Ambiguity-safe `resolveFlowDir`** (`src/flow/store.ts:33`): a numeric id
   matching >1 directory throws a listing of the candidates; exact directory
   names and unique slugs keep resolving as they do today. Verify each caller
   surfaces the error usefully: `src/flow/service.ts:55,87`,
   `src/commands/flow.ts:133`, `src/review/managed.ts:34`, and
   `src/harness/flow/managed-flow-port.ts:71` (the harness path must fail
   closed, never write evidence into a guessed package).
3. **`keryx flow check` duplicate rule** + `flow list` collision marker, so the
   condition is visible in the existing gate output.
4. **`keryx flow renumber`** command (move dir, rewrite `flow.json.id`, history
   event, old→new mapping file) with the same file-lock discipline as `init`.
5. **Repair the three collisions** with the new command; record the mapping and
   note the pre-existing checksum failure of
   `002-2026-07-10-gdgraph-java-python-import-resolution` (reported by
   `keryx flow check` today) rather than silently rewriting its criteria.
6. **Document** the worktree rule in the flow skill / memory: parallel work goes
   in worktrees, and ids are now allocated repo-wide — see the existing memory
   entry on concurrent sessions needing worktrees.

## Decisions (settled at init, 2026-07-22)

- **Repair policy:** renumber the *later-created* member of each colliding pair
  (002, 084, 103) through the new `keryx flow renumber` command. `flow.json` is
  CLI-owned, so no hand edits.
- **`flow check` severity:** the duplicate-id rule is a **hard gate failure**.
  Order matters — land the repair (T9) before flipping it hard, otherwise the
  gate is red on `main` for the duration of the flow.

## Risks

- **Renumbering breaks external references.** Old ids appear in merged PR
  bodies, journals and docs. Mitigation: keep the old→new mapping file, and
  never reuse a freed number.
- **git-common-dir resolution is environment-sensitive** (non-git checkouts, CI
  sandboxes, submodules, `keryx` run outside a repo). Mitigation: explicit
  fallback to current behaviour plus tests for the non-git path.
- **Stricter `resolveFlowDir` can break existing callers/tests** that rely on
  first-match. Mitigation: the strictness only triggers when duplicates exist,
  which is already an error condition.
- **The harness path** (`ManagedFlowPort`) is on the evidence-writing route;
  a thrown error there must be handled as a failed gate, not an unhandled
  crash mid-run.
