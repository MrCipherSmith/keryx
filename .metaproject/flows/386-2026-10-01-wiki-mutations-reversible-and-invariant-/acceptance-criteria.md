# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Before `keryx wiki enrich`, `keryx wiki collect` (incl. `--force`/`--changed`), `keryx sync --apply` (collect + orphan prune), `keryx wiki new --force`, `keryx wiki index`, `keryx wiki refresh`, `keryx wiki verify`, `keryx wiki migrate-markers`, `keryx wiki restore`, or the SAC wiki owner-writer overwrites or deletes a page or `index.md` whose content changes, the exact prior bytes are saved as the next `vNNNN-<timestamp>.md` in `.metaproject/data/gdwiki/history/<page-path>/`, and that folder's `index.md` gains a row (version, UTC time, command, run id, sha256, link) and marks the current version; a test per writer proves the saved file is byte-identical to the pre-run page. Nothing is archived (no tar/zip); no version files are written inside `.metaproject/wiki/`. `.sections.json` and create-if-missing templates have no history, as documented.
- AC2: `keryx wiki restore <page> [--version vNNNN]` restores one page and `keryx wiki restore --run <id>` restores every page a run touched to its pre-run version, deleting pages the run created and recreating pages it deleted; on a real store, copy store → change one page through a keryx writer → `restore --run` gives `diff -rq` against the copy with 0 differing files. `keryx wiki history <page>` prints the page's index.
- AC3: A version is recorded only when the sha256 changes; a page edited by hand since its last recorded version is saved first as a `manual (detected)` version before the next keryx write; retention per page is configurable (default documented) and deletes only version files listed in the index; a failure to save the prior version aborts that page's write.
- AC4: A run that aborts mid-way (simulated provider error after K pages) leaves a prior version for each of the K changed pages under one run id, and `keryx wiki restore --run <id>` returns the store to the pre-run state.
- AC5: enrich never writes a page whose output drops an existing `## Changelog` section or any existing changelog entry; a test feeds a model response without the section and asserts the on-disk page still has every prior entry.
- AC6: enrich never alters machine-generated attestation entries byte-for-byte; a test with a model response that rewords an attestation asserts the original entry is on disk unchanged.
- AC7: After enrich or collect writes a page, its front-matter `Version` is greater than or equal to the newest changelog entry's version; a test covers a model response that lowers `Version`.
- AC8: `keryx wiki collect --force` preserves existing front-matter and curated (non-generated) prose of pages it touches; generated sections are replaced, curated ones are not. A test covers a page with both.
- AC9: A page that would violate AC5–AC8 is not written; the command reports it (page path + violated invariant) and exits non-zero if any page was rejected, while other pages proceed.
- AC10: `keryx wiki validate` reports, as errors: `Version` lower than the newest changelog entry, a page whose previous version (in its history folder) had `## Changelog` now missing it, and attestation entries that differ from the previous version; each has a test.
- AC11: No existing page content, `Status`, or `Version` in this repo's `.metaproject/wiki/` is modified by the implementation itself (verified by `git diff --stat` on wiki pages limited to intended fixtures only).
- AC12: The wiki module docs and `keryx wiki --help` describe the per-page history layout, `history`/`restore`, retention, and what is NOT covered (a manual edit is captured only when the next keryx write detects it, so two manual edits in a row keep only the last; history is local, not backed up off-machine; deleting `.metaproject/data/` deletes history).
