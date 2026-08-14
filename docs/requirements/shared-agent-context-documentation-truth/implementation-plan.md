# Shared Agent Context — Documentation Truth: Implementation Plan
Version: 0.1.0

## Delivery status

**Future / planned; not implemented by this package.** It addresses verified
obsolete public proposal syntax, historical totals framed as current, missing
SAC graph/wiki coverage, inconsistent capability terms, and status overstatement.

## Dependencies

- Operation contract/registry owner (RP-09 future contract) supplies canonical
surface metadata; docs do not infer it from examples.
- Runtime/service owners supply approved fixture seams and commit/build identity.
- Graph/wiki tooling provides generated navigation projections with revision
markers; generated coverage remains non-authoritative for behavior.
- Release/CI owners define artifact retention and publication thresholds.

## Phased delivery

| Phase | Deliverable | Dependencies | Exit gate |
|---|---|---|---|
| 0 — taxonomy/evidence | Status vocabulary, evidence schema, truth hierarchy, claim annotation rules. | Runtime, docs, release owners. | Conflicting/historical fixtures classify correctly. |
| 1 — registry docs | Operation metadata to help/docs/schema generation or validation. | Phase 0; operation registry. | No syntax/default/risk/transport drift fixture. |
| 2 — executable examples | Isolated local examples plus expected safe outcomes and teardown. | Phase 1; owner test seams. | Examples prove no remote/production/discovery bypass. |
| 3 — graph/wiki | Required SAC coverage manifest, generated revision markers, authored explanations. | Phase 0; graph/wiki tooling. | Required roots/edges/pages resolve or explicit gap recorded. |
| 4 — CI gates | Structure/link/status/evidence/parity/example/coverage/drift checks. | Phases 1–3. | Release fixture fails each gate when intentionally broken. |
| 5 — release adoption | Correct stale guides, pin claims, deprecate obsolete examples, publish evidence. | Phase 4; owner approval. | No affected doc is labelled current without same-commit proof. |

## Migration rules

1. Label existing unpinned implementation/test claims `historical-verified`,
   `stale`, or `unverified` until evidence is regenerated for the current commit.
2. Replace one guide/example family at a time using registry-backed syntax and
   executable fixtures; do not bulk rewrite claims from historical reports.
3. Treat missing graph/wiki coverage as a visible documentation gap, not proof
   that a runtime relation does not exist.
4. Roll back a failed documentation generation by withholding publication and
   retaining prior clearly scoped docs; never rewrite evidence, broaden access,
   or suppress a drift result.

## Explicit deferrals

- Runtime implementation of an operation registry, graph/wiki generator, or CI
  job before their owning requirements are delivered.
- Remote identity/transport, UI documentation portals, and automatic mutation of
  guides/roadmap from CI.
- Use of docs, graph/wiki, or historical reports as authority to override
  Security, ACL, Flow, Context Operations, or knowledge owners.
