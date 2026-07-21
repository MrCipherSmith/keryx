# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A requirements package exists at `docs/requirements/keryx-os-sandbox/` satisfying `rules/core/requirements-package-standard.mdc`: README, prd and specification present, every Markdown file carries a `Version` directly under its H1, and the README links to every file in the package.
- AC2: The package contains a human-facing operator guide and a separate agent-facing protocol document; each is usable on its own without reading the other, and neither duplicates the other's content wholesale.
- AC3: Every capability claim in the package is labelled with the platform it holds on; specifically the package states that `network: restricted`, the domain allowlist, credential masking and TLS termination are macOS-only today and fail closed on Linux.
- AC4: The project wiki knows about the package: a wiki page of type `architecture` covers the OS sandbox and links the package, `keryx wiki index` has been regenerated so the page appears in `wiki/index.md`, and `.metaproject/index.md` routes a natural-language sandbox question to the package.
- AC5: `docs/requirements/roadmap.md` records the capability with an honest status, and no document claims an implementation that the code does not have.
- AC6: `bun run typecheck` is clean and the full `bun test` suite passes with 0 failures.
