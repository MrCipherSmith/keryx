// Sidebar geometry, in its own module.
//
// `SIDEBAR_WIDTH` is read by three places that must agree: the chrome that
// paints the column (`shell-chrome.ts`), the splash that centres itself in the
// remaining columns (`boot-animation.ts`), and the modal host's pre-layout
// fallback (`modal-host.ts`). It lives here rather than in `shell-chrome.ts`
// because that file imports `destroyModalHost` from `modal-host.ts`, so a value
// import back the other way would be a cycle — and the copy the modal host used
// to keep is exactly the duplicate PR #591's F-013 named.

/**
 * The sidebar column. FIXED, not flexible: a column that resized with its
 * content would move the transcript's left edge on every repaint.
 *
 * 34, not 30: the panels fit a label to `SIDEBAR_TEXT_WIDTH`, and at 30 the
 * text budget is 26 columns — narrow enough that `shortenCwd` cut the working
 * directory and workspace titles mid-segment on a normal path.
 */
export const SIDEBAR_WIDTH = 34;
