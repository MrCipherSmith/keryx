# Acceptance criteria

- AC1: Discover stock, absent, empty, partial and unavailable OpenSpec sources. Enforce checkout containment and bounds, with working Graph and Wiki when OpenSpec is unavailable. [verify: exec `bun test src/openspec/catalog.test.ts src/integrations/metaproject-explorer.test.ts`]
- AC2: Read requirements, scenarios, exact delta operations and archived history with source paths and line ranges. Preserve unknown or unresolved syntax as such. [verify: exec `bun test src/openspec/history.test.ts`]
- AC3: Search checkout-local specs, changes and optional archive by title, path, heading and body, with stable scoped cursors and section-level navigation on coherent snapshots. [verify: exec `bun test src/openspec/search.test.ts src/integrations/metaproject-explorer.test.ts`]
- AC4: Project evidence-backed spec/change links to Graph and Wiki in both navigation directions, using explicit links and actual OpenSpec delta paths. Respect graph bounds and keep archive out of the default overview. [verify: exec `bun test src/integrations/metaproject-explorer.test.ts`]
- AC5: Give CLI and Explorer v2 callers the same root-scoped identities and evidence; keep Explorer v1 valid and handle legacy CLI fallback at the fixed probe boundary. [verify: exec `bun test src/commands/openspec.test.ts src/integrations/metaproject-explorer.test.ts`]
- AC6: Provide an accessible OpenSpec Desktop tab with shared search, details and graph selection, distinct source/error states, checkout switching and safe inert Markdown rendering. [verify: exec `cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx src/platform/metaproject.test.ts`]
- AC7: Demonstrate Specs, Changes, Archive, linked Graph/Wiki navigation, large fixture behavior and matching Shell/CLI citations in a packaged Desktop build according to the implementation plan. [verify: judged]

## Outcome criteria

- In an initial project pilot, observe a reviewer trace one requirement to an archived change and linked component and record steps that still required manual lookup.
