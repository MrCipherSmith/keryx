# Toolbar measurements after T23 (orchestrator)

Working tree on top of `91c37c81b` with the T23 changes (bare count, hidden-attention hint) and the search-field rule
`@container (max-width: 760px) { .review-board .flows-toolbar > .search-field { flex-basis: 80px; min-width: 80px; } }`.
Chromium, Vite dev build of `apps/desktop` on port 1430, no dev bridge (no project open). The real stylesheets were loaded;
the toolbar markup of `ReviewBoard.tsx` was rebuilt in the page with the real class names and stand-ins: count "18 pull requests",
hint "2 waiting on you hidden by filters", Review rules button, PR watcher button with status "Watching · next check in 4 min",
Board/List, Refresh. The toolbar's own width was set (border-box). Height 55 = one row, 87-91 = two rows, 127 = three rows.
`scrollWidth > clientWidth` never happened.

| toolbar width | without hint | with hint |
|---|---|---|
| 340 | 91 | 127 |
| 560 | 55 | 91 |
| 620 | 55 | 55 |
| 700 | 55 | 55 |
| 760 | 55 | 55 |
| 820 | 55 | 91 |
| 1101 | 55 | 55 |
| 1180 | 55 | 91 |
| 1380 | 55 | 55 |

Before the search-field rule, without the hint: one row needed 573px (with the bare count) against 550px (count hidden), so the
560px toolbar of the default window with the PR panel open wrapped to two rows. Hint width: 43px with words hidden, 214px with words.
Not measured: the app with real board data, real label widths of the Review rules button and watcher status.
