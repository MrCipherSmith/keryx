# PRD — OpenSpec in Keryx Metaproject
Version: 0.1.1

Status: Contract for Flow 514. The Flow journal records implementation and verification progress.

## Problem

Desktop can explain existing architecture through Wiki and trace source dependencies through Graph. A developer still leaves the app to find the specification, distinguish current requirements from active proposals, or see why a specific behavior changed. Team Hub can import the underlying Markdown into a connected project, but that documents workflow does not supply a local catalog, requirement search or graph relationships in the open checkout.

A reviewer needs to see whether a statement comes from a current spec, an active delta or an archived artifact. Blending them can turn a proposal into an apparent current requirement or an archived folder into a claim that a specific release shipped the behavior.

## Goal and users

Give developers, reviewers, product owners and agents the same path from a behavior to its evidence, on the current checkout. Product owners can read scenarios and change history, developers can find relevant code and Wiki pages, and reviewers can see which requirement changed and the source revision that supports the claim.

| Source | Question it answers |
|---|---|
| Graph | What is connected, and what can this change affect? |
| Wiki | How does it work and why was it designed this way? |
| OpenSpec | What behavior is expected, what is proposed, and how did the spec evolve? |
| Flow | What is being delivered and which evidence satisfies its criteria? |

## User journeys

1. A developer opens **Metaproject → OpenSpec → Specs**, searches for “publish finished review” and lands on a scenario. The detail shows the relative source path, current requirement, relevant active changes and archive entries for that capability.
2. A reviewer selects an active change, opens its **Modified** or **Removed** requirement and follows its relation to the spec. An archived change opens its original delta even if the capability has since been retired.
3. A product owner selects a spec in Graph, follows an explicitly linked Wiki page and then a linked code module. Selecting the module returns its linked specs. The graph explains each relationship at the point of use.
4. An agent uses Keryx from Shell or an external harness, searches the same local source, and cites the exact checkout-relative file and section. It preserves the distinction between intended behavior and current implementation evidence.
5. In the later Flow increment, the developer selects **Create Flow from change**, reviews proposed criteria and deliberately creates a draft. A later source edit is visible as drift with the existing criteria retained.

## Requirements

### R1 — Discover OpenSpec in the open checkout

Discover standard OpenSpec directories and serve them without a Hub account, model, package install or OpenSpec binary. Distinguish missing, empty, ready, partial and unavailable. Existing Graph and Wiki remain usable across those states.

Verification: exec `bun test src/openspec/catalog.test.ts src/integrations/metaproject-explorer.test.ts`

### R2 — Browse specs, changes and archive

The Desktop tab shows all three collections. Specs expose requirements and scenarios. Active changes expose familiar artifacts and a requirement delta. Archives show retained historical artifacts and the archive date when recorded. A missing baseline, ambiguous requirement, or unsupported delta gets an explicit explanation and a readable source excerpt.

Verification: exec `bun test src/openspec/history.test.ts && (cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx)`

### R3 — Search and navigate across sources

Use the shared Metaproject search to find OpenSpec titles, paths, requirement/scenario labels and body text with source labels and excerpts. A result opens the matching section. Scope filters include Specs, Changes and Archive. Default search includes the first two and excludes Archive so old wording stays distinguishable from current results.

Verification: exec `bun test src/openspec/search.test.ts src/integrations/metaproject-explorer.test.ts && (cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx)`

### R4 — Trace inspectable links in both directions

A change links to capabilities it addresses, including retired capabilities shown as historical context in the change view. Explicit project links connect specs or changes to Wiki pages, files and modules. Selecting either endpoint reveals the bounded neighborhood and the source of every edge. Requirements and scenarios stay in detail views so large projects can use the graph.

Verification: exec `bun test src/integrations/metaproject-explorer.test.ts && (cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx)`

### R5 — Maintain parity across reading surfaces

Desktop, Keryx Shell and external harnesses through the CLI share a local query service. They can list, read and search, and obtain source references and diagnostics consistently for the same checkout and snapshot. Existing Explorer v1 callers continue to receive the original contract.

Verification: exec `bun test src/commands/openspec.test.ts src/integrations/metaproject-explorer.test.ts && (cd apps/desktop && bun test src/platform/metaproject.test.ts)`

### R6 — Handle untrusted local content and large repositories

Keep reads within the selected checkout, cap scan and response sizes, and preserve the current selection during refresh. A partial result visibly reports its limits. Repository content cannot issue commands, upload files, fetch previews or activate Markdown HTML. Stale data from a previous checkout or from an invalidated snapshot must not be presented as current.

Verification: invariant `bun test src/openspec/catalog.test.ts src/integrations/metaproject-explorer.test.ts && (cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx)`

### R7 — Verify usability in native Desktop

The experience follows existing Graph/Wiki navigation, buttons and detail layouts. Keyboard navigation reaches search, filters, results, history and links, with visible focus. A fixture project demonstrates three views, cross-source selection, degraded states and switching checkouts in the packaged Desktop app.

Verification: judged

### R8 — Hand off a change to a draft Flow (later)

A separate opt-in operation shows a proposal to import the change. A confirmed create uses the existing Flow lifecycle, retains a revision and content fingerprint, and leaves criteria editable before Freeze. Duplicate and stale requests are handled explicitly. Opening an already-created draft and upgrading its source remain deliberate operations.

Verification: exec `bun test src/flow/openspec-intake.test.ts && (cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx)`

## Success criteria

### Release criteria

- R1–R6 automated checks pass in GitHub CI. Existing Graph/Wiki and platform compatibility checks remain green.
- R7 passes the packaged macOS Desktop walkthrough and Shell/CLI parity check defined in the implementation plan.
- The user guide shows how to configure explicit links and distinguishes archived changes from confirmed delivery.
- R8 is a separate release gate for the later Flow increment.

### Outcome criteria

- In the first project pilot, observe a reviewer use one Desktop search to open a scenario, inspect its change history and reach linked code. Record which steps required manual file lookup.
- During the same pilot, have an external harness and Keryx Shell cite the same requirement path and section as Desktop against the same checkout. Record mismatches with the checkout revision and query.
- Long-term adoption is not measured — this package does not introduce telemetry or identify users across sessions.

## Risks and product decisions

| Risk | Decision |
|---|---|
| Proposed or archived wording looks current | Label source state in every list, search hit and detail. Change history is scoped to OpenSpec artifacts present in the checkout. |
| Historical delta is shown as a reliable before/after without the old baseline | Show original archived delta, optional contextual links and an explicit missing-baseline state. |
| Graph implies a component implements a spec | Use a neutral explicit relationship and show the declaring path. OpenSpec delta paths justify change-to-spec edges only. |
| A global cache or branch switch leaks another checkout's context | Scope reads, cache and async results to the selected checkout. |
| Large archives overwhelm the graph or search | Keep archive separate, bound reads and rank search per source. Load related history on demand. |
| Teams maintain two task lists | Treat OpenSpec tasks as readable artifacts and Flow as delivery state; the later bridge keeps a source reference. |

## Recommendation

Deliver the local reader and Desktop experience as the first complete increment. Add the draft Flow handoff after users can reliably find a change and verify its evidence. Keep the initial release compatible with stock OpenSpec directory layout and custom Markdown artifacts within a change, with bounds and diagnostics.
