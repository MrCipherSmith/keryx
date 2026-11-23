# Layout measurements by the orchestrator

Head 53c96b8af. Chromium, Vite dev build of this branch (`apps/desktop`, port 1430), Pull requests tab, board WITHOUT data
(the dev bridge on 1421 belongs to another session): no count label, no "Review rules" button, watcher label "Status unavailable".
Measured with `document.querySelector('.review-board .flows-toolbar')`: clientWidth, scrollWidth, child rects.

| viewport | toolbar clientWidth | scrollWidth | result |
|---|---|---|---|
| 620x800 (board = default 1180 window minus 60 rail minus 560 panel) | 560 | 567 | OVERFLOW 7px: last child (Refresh) right edge 627 > toolbar right 620; search at its 96px minimum, spacer 0 |
| 760x800 | 700 | 700 | fits; last child right 736 vs toolbar right 760 (24px slack before padding) |
| 880x800 | 820 | 820 | fits, one row, 62px spacer |
| 1140x800 | 1080 | 1080 | fits, labels hidden |
| 1210x800 | 1150 | 1150 | fits, labels shown; spacer 113px, search 313px (can shrink to 96px): about 330px of slack |
| 1440x900 | 1380 | 1380 | fits, labels shown |

Reading: LY-001 (review-layout) is CONFIRMED for the no-data board at 560px: the nowrap toolbar overflows where the base wrapped.
With board data the toolbar also holds the "Review rules" button (about 32px + 8px gap collapsed), so the overflow grows and starts
at a wider board (estimated about 740px; not measured). LY-002 / F-003 / UX-005 (overflow just above the 1100px breakpoint) is NOT
confirmed without data: about 330px of slack at 1150px; with data the extra items (count label, "Review rules" label) were not measured.

Dialog check (earlier, same build): PR watcher `.overlay` is a child of `document.body`, rect = full viewport.

## After the fix (working tree on top of 53c96b8af, T13)

Same build and method. Two stand-ins were injected into the toolbar because the board had no data: a clone of the Filters button
as the "Review rules" button, and a `.count-label` span "18 pull requests". `clipped` = children whose right edge passes the toolbar.

| viewport | toolbar clientWidth | scrollWidth | height | clipped | labels | count label | watcher status |
|---|---|---|---|---|---|---|---|
| 400x800 | 340 | 340 | 91 (wrapped to two rows) | 0 | hidden | hidden | hidden |
| 620x800 | 560 | 560 | 55 (one row) | 0 | hidden | hidden | hidden |
| 760x800 | 700 | 700 | 55 | 0 | hidden | hidden | hidden |
| 880x800 | 820 | 820 | 55 | 0 | hidden | shown | shown |
| 1161x800 | 1101 | 1101 | 55 | 0 | hidden (the container width is the content box, 1061px) | shown | shown |
| 1440x900 | 1380 | 1380 | 55 | 0 | shown | shown | shown |

F-001 closed for these widths: no overflow, one row down to 560px, wrapping without clipping at 340px. Not measured: real board data
(the real "Review rules" label width, the longest real watcher status), the detail panel actually open.
