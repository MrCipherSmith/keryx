# Toolbar measurements after T24 (orchestrator)

Working tree on top of `802c3161b` with the T24 changes. Same method as `-r04/research-evidence/layout-measurements-t23.md`:
Chromium, Vite dev build of `apps/desktop` on port 1430, no dev bridge, real stylesheets, the toolbar markup of `ReviewBoard.tsx`
rebuilt with stand-ins (count 18, hint "Show 2 waiting on you" / "2 hidden", Review rules, PR watcher with status text, Board/List,
Refresh); the toolbar's own width set (border-box). Height 55 = one row, 87-91 = two rows, 127 = three rows. No clipping and
`scrollWidth > clientWidth` never happened.

| toolbar width | without hint | with hint |
|---|---|---|
| 340 | 91 | 127 |
| 560 | 55 | 91 |
| 620 | 55 | 87 |
| 700 | 55 | 55 |
| 760 | 55 | 55 |
| 820 | 55 | 91 |
| 900 | 55 | 87 |
| 1101 | 55 | 55 |
| 1180 | 55 | 91 |
| 1250 | 55 | 87 |
| 1380 | 55 | 55 |

Sweep in 2px steps with the hint shown: two or more rows at 340-646, 810-908 and 1150-1290px.
Hint width: 83px in the narrow form ("2 hidden"), 156px with the long label. `.count-word` under 760px: 1x1px, still in the
document (the visually-hidden pattern), so it stays in the accessibility tree.
Not measured: the app with real data, contrast of the hover overlay.
