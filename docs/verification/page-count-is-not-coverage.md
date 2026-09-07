# Where a count is printed as if it were coverage

A commit message in phase 3 said the remaining sites were "enumerated with
owners rather than quietly left". They were not — the enumeration existed in
that message and nowhere else, and an independent review checked and found no
such list in the repository. This is that list, written down where it can be
read and checked.

The wiki holds pages of several types. Five types hold no pages at all. Any
surface that prints a page total without saying what is absent invites the
reader to treat the total as a measure of coverage, which it is not: it is a
count of files.

## The fourteen sites, each with a verdict

| # | Site | Prints | Verdict | Owner |
|---|---|---|---|---|
| 1 | `src/commands/wiki.ts` (`wiki status`) | `total pages: N` | Presented as completeness — the headline line, with nothing naming what is missing | open |
| 2 | `src/wiki/service.ts` `WikiStatusResult.totalPages` | the value behind #1 | Value is fine; needs a sibling field so a consumer *can* state absence | open |
| 3 | `src/commands/wiki.ts` (`wiki index`) | `Generated … (N pages).` | Not completeness — reports an action's scope | leave |
| 4 | `src/wiki/service.ts` index header | `<!-- pages: N -->` | Benign as file metadata | leave |
| 5 | `keryx wiki context` orientation | first line `pages: N` | Presented as completeness, on the surface injected into every agent turn | open |
| 6 | `src/lib/templates.ts` dashboard | `Wiki · N pages` | **Was the worst, now fixed.** The alternative value was `needs content`, so a non-zero count read as "nothing missing" | fixed |
| 7 | `src/lib/templates.ts` dashboard | `Memory · N entries` | Same shape as #6, not previously reported. **Fixed with it** | fixed |
| 8 | `src/wiki/freshness/report.ts`, `run.ts` | `pages: N total, M fresh` | A ratio a reader takes as coverage; mitigated by a `limitations` block, not clean | open |
| 9 | `src/harness/tool/metaproject-operations.ts` (`wiki_freshness`) | same totals, agent-facing | As #8, one surface further from the caveat | open |
| 10 | `src/commands/wiki.ts`, `service.ts` | `checked pages: N` | Completeness *of the check*, honest about its scope | leave |
| 11 | `src/commands/wiki.ts` (`wiki collect`) | `enrichment needed: N` | Inverse coverage — it names what is missing | leave |
| 12 | `src/wiki/enrich.ts` | `n/total` progress | Not completeness | leave |
| 13 | `renderWikiIndexScaffold` | `pages: 0` at a new index head | Fixed: the scaffold now opens by saying the count is a file count | fixed |
| 14 | `renderGdwikiSkillReadme` | the skill every agent loads | Fixed: carries "A page count is not coverage", naming sites 1, 3 and 5 | fixed |

## Status

Five fixed (6, 7, 13, 14, and the templates/validator work behind them), five
open with owners named above, four deliberately left because they are honest
about what they measure.

The open ones are open. This document exists so that stays visible instead of
living in a commit message that claimed the work was already done.
