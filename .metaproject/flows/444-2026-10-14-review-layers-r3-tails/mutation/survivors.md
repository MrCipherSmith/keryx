# Survivors of mutation-1

21 of 22 mutants killed. One survived.

- `ac2-unreadable-page-dropped` (`src/review/layers-payload.ts`, `unreadable.push(page.relativePath);`): the per-page `readFile` in `wikiFor` can only fail if a page disappears or changes mode between `collectPages` and the read, because `collectPages` already reads every page and a permission failure there surfaces as "the wiki could not be read" (pinned by two tests, one for the directory and one for a single page file). That window cannot be hit without injecting a reader. The branch is kept as a guard: without it a race would throw out of the whole layers block. Accepted, not pinned.
