# Block 00 — Capability Seam (Foundation)

Version: 1.0.0
Status: **spec ready**

Block 0 is the **substrate every opt-in feature in Blocks A–E stands on**. It generalizes the
existing `security.backends` idiom into a single, project-wide **Capability Seam**: a uniform
opt-in mechanism (`init` flag + `metaproject.json` manifest capability entry + config toggle +
`resolveCapability(id) → Adapter | null`), backed by `optionalDependencies` with lazy dynamic
import, where the **deterministic fallback is a first-class, TESTED code path** and adapters
**never throw**. It also delivers the shared **Asset Resolver** (three-tier: user-provided path /
explicit `assets pull` with sha256 verified against a committed `assets.lock.json` / well-known
user cache; checksum verified on every load; network only inside an explicit subcommand) and the
reusable **fixture-corpora acceptance harness + false-negative-rate gate**. This block ships **no
end-user feature by itself** — it is the seam A–E instantiate identically.

## Documents

- [prd.md](prd.md) — problem, goals + metrics, non-goals, user/agent stories, and the XP1–XP5
  cross-cutting requirements this block delivers.
- [specification.md](specification.md) — the Capability Seam contract (`resolveCapability`,
  `CapabilityAdapter`, config shape, manifest capability-entry JSON schema), the Asset Resolver
  (`assets.lock.json` schema + `gd-metapro <module> assets pull/list/verify`), the fixture-harness
  contract, and how `init`/`update` register capabilities.
- [acceptance-criteria.md](acceptance-criteria.md) — the hard, testable ACs (empty `dependencies`;
  missing dep/asset → deterministic fallback with warn-once/exit-0; adapters never throw; checksum
  verified; harness runs).
- [tasks.md](tasks.md) — the ordered, atomic task decomposition (T1..Tn) with kinds and
  dependencies, and the constraint that this block MUST land before A–E.

## How to run this block via `gd-metapro flow`

This block is executed as a normal gd-metapro managed flow, driven by the deterministic gates in
`src/commands/flow.ts`:

```bash
# 1. Register the flow from this spec package (task list = tasks.md).
gd-metapro flow init roadmap-2026/00-capability-seam

# 2. Freeze the scope and start work (freeze pins the AC set).
gd-metapro flow freeze  <flow-id>
gd-metapro flow start   <flow-id>

# 3. Drive each task T1..Tn; mark acceptance criteria as they pass.
gd-metapro flow task    <flow-id> <task-id>
gd-metapro flow ac      <flow-id> <ac-id>          # tick an AC from acceptance-criteria.md
gd-metapro flow implemented <flow-id> <task-id>

# 4. Completion is gated — flow complete only succeeds when the AC set, PR link,
#    and the health gate all pass (the deterministic gate contract is preserved).
gd-metapro flow check    <flow-id>
gd-metapro flow complete <flow-id>
```

Because Block 0 ships no runtime feature, its `flow check` health gate is satisfied by the
acceptance harness (fixture round-trips + the no-network sandbox test) rather than by a
capability-metric fixture. Blocks A–E, once this seam exists, reuse the same `flow` cycle and add
their own capability-metric fixture as the acceptance gate.
