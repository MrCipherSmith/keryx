# Implementation Plan

Status: ready for verification and verified handoff

## Approach

Use a documentation-first P6 pass against the stable P0–P5 code: refresh
registry/help and generated workspace references, reconcile the package and
roadmap, update the accepted memory wiki page, then run focused suites followed
by TypeScript and the full Bun suite. Record exact command evidence and classify
any warning or exception rather than weakening tests. Retire only the two
tracked legacy latest artifacts after copying exact bytes to the requested
timestamped `/private/tmp` backup and verifying hashes. Keep flow state changes
CLI-owned and finish with a verified handoff, leaving flow 111 in progress.

## Steps

1. Record the P6 context, freeze 11 verifiable criteria, and start flow 111.
2. Update source command metadata, module registry, user/module/architecture/
   setup/workflow/memory manifest/template/skill/index documentation.
3. Update the accepted `src-memory` wiki page and regenerate its wiki index;
   refresh gdgraph and check blast radius and links.
4. Back up/hash/delete only legacy `latest.md` and `latest.json`; verify ignore
   and migration policy.
5. Run targeted memory/integration/init-update/security/embedding/flow suites,
   typecheck, full Bun tests, non-empty memory check, docpack validation, and
   adversarial consistency review.
6. Record AC/evidence mappings, migration guidance, release note, and preserve
   an honest in-progress flow for user completion.

## Risks

- Full-suite or environment warnings may pre-exist; every exception gets exact
  reproduction, scope, owner, and follow-up in metrics-and-validation.md.
- Generated artifacts and flow/test evidence can dirty the worktree; preserve
  all user changes and do not stage them. Only the two explicitly authorized
  legacy latest files may be deleted.
- Documentation must follow runtime behavior, especially direct Markdown recall
  and optional generated catalogs; no claim may make the catalog authoritative.
