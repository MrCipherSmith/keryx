# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: No file under `src/gdskills/bundled/` names a person, a personal path, or a project-specific convention belonging to one team. A test enumerates the bundled tree and fails on a home-directory path (`~/`, `/home/<user>`) or on the reviewer persona this flow removes.
- AC2: The shipped skill and rule describe the **mechanism**, not a style: that this reviewer learns locally from pull-request comments by people the project names. The text reads identically for a team that has never heard of the original reviewer — replacing a name with a placeholder does not satisfy this.
- AC3: A per-project configuration names the learning sources: which local skill, which repository, and which comment authors. It lives in the project, never in `src/gdskills/bundled/`, and a project without it simply does not learn — absence is not an error.
- AC4: A command turns collected pull-request comments into a learning proposal, filtered to the configured authors. It reuses `keryx review comments collect`'s durable record rather than re-fetching, and reuses `keryx skills learn` rather than writing a second learning path.
- AC5: An author not in the configured list contributes nothing. Proved by a test with two authors where only one is configured, asserting the other's text appears in no proposal.
- AC6: The proposal still mutates nothing. `learn apply` remains the only writer, and it remains refused for any path outside `.metaproject/project-skills/`. This flow adds a producer of proposals, never a second applier.
- AC7: Learned content cannot reach the keryx repository. A test asserts the apply path rejects a target under `src/gdskills/bundled/`, so a misconfigured project cannot teach the shipped template.
- AC8: The operator's existing conventions are seedable into a local skill by a documented path, and the documentation states plainly that their own copies outside this repository are the source. Nothing is silently discarded.
- AC9: The end-to-end loop is proved by a test that runs it: collect (from fixtures) → filter by author → propose → apply → assert the lesson is in the local `SKILL.md` and the version was bumped. Not a unit test over a hand-built proposal — this flow's whole subject is a join that no fixture can prove exists.
- AC10: Every claim the new prose makes about enforcement is wired, or the claim is not made. Softening a verb is not a resolution. This is the same rule Phase 7 was held to, and the reason it is repeated here is that this flow writes new prose about a mechanism.
- AC11: Both trees carry every skill, rule and schema edit — `src/gdskills/bundled/` is the source of truth and `.metaproject/` is overwritten with force on every `keryx update`. Verified by diff; the mirror and build-parity guards still pass.
- AC12: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
