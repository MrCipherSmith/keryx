# The gdwiki freshness route lived only in the generated file, so keryx update deleted it

Status: formalized
Source: user description

## Problem

`.metaproject/skills/gdwiki/SKILL.md` is a generated service file: `keryx init`
(`src/commands/init.ts:809`) and `keryx update` (`src/commands/update.ts`, in the
service-file list) both overwrite it from `renderGdwikiSkillReadme()`
(`src/wiki/templates.ts:146`).

#460 added the 33-line section "Before you trust a page: check whether it is
current" — the only route an agent has from the gdwiki skill to
`wiki_freshness` / `keryx wiki freshness` — by editing the **generated file**.
The generator was never touched: `src/wiki/templates.ts` contains no occurrence
of the word "freshness".

The section therefore survives exactly until the next `keryx update`, in this
repository and in every project that installs the skill. This was found by
running `keryx update` on an unrelated branch: the run silently deleted all 33
lines, and nothing failed.

The failure is the same class the freshness package itself exists to prevent —
an agent reading a document that no longer says what someone wrote — one level
up: the document that teaches agents to check freshness is itself erased by a
routine command.

## Expected Outcome

- The section lives in `renderGdwikiSkillReadme()`, so `init` and `update`
  reproduce it instead of deleting it.
- The committed `.metaproject/skills/gdwiki/SKILL.md` is byte-identical to what
  the generator renders.
- A test fails if either half drifts again: one pinning the freshness route in
  the generator, one pinning the committed artifact to the render.

## Out of Scope

- The wording of the section: it ships as #460 wrote it, minus one stray blank
  line that the hand edit left behind.
- Other generated files whose committed copy is merely older than the generator
  (`skills/catalog.md`, `modules/gdskills.md` regenerate to newer text — drift,
  not data loss).
- A repository-wide "every generated file is in sync" guard. That is a larger
  change and would fail today on the drift above.
