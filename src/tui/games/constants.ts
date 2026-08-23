// Shared game-modal constants: the model-turn deadline (raised from 12s to
// 60s, flow 174 — local models are slow, and the point of the stats panel is
// to observe that latency, not to race it) and the modal footer hints.
// `/game <seconds>` overrides the deadline per modal.

export const GAME_MODEL_TIMEOUT_MS = 60_000;

export const GAMES_FOOTER = [
  { key: "arrows", label: "move" },
  { key: "enter", label: "place" },
  { key: "r", label: "new game" },
  { key: "tab", label: "games" },
  { key: "esc", label: "minimize" },
] as const;
