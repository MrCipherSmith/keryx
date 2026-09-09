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

## The sixteen sites, each with a verdict

| # | Site | Prints | Verdict | State |
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
| 15 | `src/lib/templates.ts:1090` dashboard hero KPI | `<b>N</b><span>wiki pages</span>` | Found by a verifier: same file as #6/#7, missed the first time. Bare count in the dashboard's top-of-page "at a glance" strip, no caveat anywhere near it — same shape as #1/#5. **Fixed**: the tile now carries a `title` tooltip caveat ("A count of files, not a coverage measure — several wiki page types can hold none"), covered by a regression test (`src/lib/templates.test.ts`) that fails if the caveat is removed | fixed |
| 16 | `src/lib/templates.ts:1091` dashboard hero KPI | `<b>N</b><span>memory entries</span>` | Same finding and fix as #15, for memory entries | fixed |

## How the enumeration was re-checked for completeness

A list that has been found incomplete twice (once against the commit message
that first claimed it, once by the verifier who found #15/#16 in the file
where #6/#7 were declared fixed) does not get a third eyeball pass. This
version was checked two ways, both reproducible:

1. **Exhaustive, in the one file already proven to hide sites**: every
   reference to `wikiPages`, `memoryEntries`, `wikiStatus`, and `memoryStatus`
   in `src/lib/templates.ts` was enumerated with
   `keryx ctx rg "wikiPages|memoryEntries|wikiStatus|memoryStatus" --all -- src/lib/templates.ts`
   (22 matches, all inspected). Of those, exactly four render a count to a
   reader: #6/#7 (`wikiStatus`/`memoryStatus`, already fixed) and #15/#16
   (the hero KPI tiles, fixed here). The rest are data plumbing (building the
   arrays, mapping to table rows, feeding the "no pages yet" attention-item
   check) that never prints a number.
2. **Repo-wide sweep for the same shape elsewhere**: `keryx ctx rg` for
   `.length` used against a variable named `pages`/`entries`, plus literal
   `pages:`/`totalPages` occurrences, across `src/` (91 and 55 matches
   respectively, both reviewed). Every other hit is one of: a length check
   with no count *printed* (`if (entries.length === 0)`), a test assertion,
   an already-tracked row above (`checked pages:` → #10, `pages: N total, M
   fresh` → #8/#9), or a count that is honest about being a scoped subset —
   a search-result count, a cluster's membership, "N related entries" for one
   query, "consulted N entries for this skill" — the same "leave" shape as
   #10–#12, not a bare-total presented as completeness.

Neither sweep is a formal proof of exhaustiveness (a differently-named
variable could still hide a count), but both are commands anyone can re-run
verbatim, unlike the first version's "enumerated" claim which named no method
at all.

## Status

Six fixed (6, 7, 13, 14, 15, 16), five open (1, 2, 5, 8, 9), five deliberately
left (3, 4, 10, 11, 12) because they are honest about what they measure.

Those three counts are read off the table's own Verdict column above (`fixed`
× 6, `open` × 5, `leave` × 5 — 16 rows total), not typed independently beside
it. The first version of this paragraph said "five fixed … four left" and
disagreed with its own fourteen rows — in the one document whose entire
purpose is that a claimed enumeration matches what is on the page. The
`Owner` column also repeated the verdict instead of naming anyone, so the
commit that introduced this file claiming "a verdict and an owner for each"
was still not literally true; the column is now named for what it holds.

The open ones are open. This document exists so that stays visible instead of
living in a commit message that claimed the work was already done.
