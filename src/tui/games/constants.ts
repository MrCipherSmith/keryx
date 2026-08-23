// Shared game-modal constants: the model-turn deadline (raised from 12s to
// 60s, flow 174 — local models are slow, and the point of the stats panel is
// to observe that latency, not to race it) and the modal footer hints.
// `/game <seconds>` overrides the deadline per modal.
//
// Panel height budget (terminal rows): the agent panel must fit in the modal
// body TOGETHER with the board — "всё перед глазами", no modal-level scroll.
// The board is sized from the body HEIGHT (see tic-tac-toe/layout.ts), and
// the prompt card is a bounded minmax-style block that scrolls only inside
// itself. The 0.2.64 regression this replaces: a ScrollBox with `flexGrow: 1`
// and no height cap measured its content at the full parent height,
// ballooning the card and pushing the whole modal into scroll.

export const GAME_MODEL_TIMEOUT_MS = 60_000;

/** Height floor of the "system + user prompt" card, in terminal rows. */
export const PROMPT_MIN_ROWS = 5;

/** Height ceiling of the prompt card; it never grows past this. */
export const PROMPT_MAX_ROWS = 14;

/**
 * Rows the agent panel occupies OUTSIDE the prompt card: the status card
 * (2 border + 3 content lines + 1 top margin) plus the prompt card's own
 * 1 top margin. With the stats kept as compact lines on the status card this
 * is 7 — two tall stat cards would cost ~13 and make board + panel + prompt
 * impossible to fit on a normal terminal without scrolling.
 */
export const PANEL_FIXED_ROWS = 7;

/** Minimum vertical space the agent panel needs (fixed rows + prompt floor). */
export const PANEL_MIN_ROWS = PANEL_FIXED_ROWS + PROMPT_MIN_ROWS;

export const GAMES_FOOTER = [
  { key: "arrows", label: "move" },
  { key: "enter", label: "place" },
  { key: "r", label: "new game" },
  { key: "tab", label: "games" },
  { key: "esc", label: "minimize" },
] as const;
