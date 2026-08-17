# Give an agent context about my repository

**The problem:** an agent starts each task by re-deriving what your repository
already knows — which files relate, what was decided and why, what broke before.

**What you get:** one index every agent is routed to, holding a code graph, a
wiki, memory and quality artifacts, versioned alongside the code.

Every command below was executed; the output is from those runs.

## 1. Install the workspace

```console
$ cd your-project
$ keryx init --yes
```

`init` scaffolds `.metaproject/`, enables nine modules, installs git hooks, and
wires your existing `AGENTS.md` / `CLAUDE.md` so an agent reading them is routed
to `.metaproject/index.md`.

It is an **idempotent reconciler**: re-running it refreshes managed files and
never clobbers your edits or anything under `.metaproject/data/`.

## 2. Build the code graph

```console
$ keryx gdgraph build
gdgraph build complete: 139 nodes, 153 edges
```

That run is `expressjs/express`, cloned fresh. On this repository the same
command reports 649 nodes and 1,873 edges.

## 3. Ask the question agents waste the most tokens on

```console
$ keryx gdgraph affected lib/express.js
# Affected context for lib/express.js

## Dependencies
- lib/application.js
- lib/request.js
- lib/response.js

## Dependents
- examples/route-map/index.js
- examples/route-middleware/index.js
- index.js
```

*What breaks if I change this* is the answer an agent otherwise reconstructs
from a dozen file reads, and gets wrong on exactly the files where it matters.

Two more that pay for themselves:

```console
$ keryx gdgraph query cycles
No cycles found.

$ keryx gdgraph query orphans
```

## 4. Point agents at it

`init` already did this for the entrypoints it found. For a per-turn
orientation block, install the optional hook:

```console
$ keryx orient install-hook --runtime codex
```

`keryx agents bootstrap install --runtime claude` does the same for the
**global** agent entrypoint, so a runtime discovers the workspace in any
project that has one.

## Verify you got what this guide promises

```console
$ keryx status
Metaproject: ready
Root: .metaproject
Modules:
  gdgraph: enabled
  gdctx: enabled
  gdwiki: enabled
  gdskills: enabled
  memory: enabled
  tasks: enabled
  health: enabled
  testing: enabled
  security: enabled
```

If `gdgraph` reports `0 nodes, 0 edges` on a repository that has code, the
graph has not been built — run `keryx gdgraph build` before reading anything
into the number.

## Where to go next

- [Architecture](../architecture.md) — what the workspace contract actually is,
  and who may write what.
- [Module reference](../modules.md) — one section per module.
- [Shared Agent Context](shared-agent-context.md) — bind a task to a workspace,
  read a bounded FWK overview, propose reviewed knowledge back.
- [Run keryx in CI](run-in-ci.md) — keep these artifacts current without anyone
  remembering to.
