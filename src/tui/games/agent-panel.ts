// The "agent panel": the block under the board showing the status line, the
// model-facing prompts (system + the per-turn user prompt with the current
// board state) and the provider/latency/token statistics.
//
// Layout contract (see constants.ts + tic-tac-toe/layout.ts): the panel must
// fit in the modal body TOGETHER with the board — everything on screen, no
// modal-level scroll. The board is sized from the body HEIGHT, the prompt
// card is a BOUNDED block (PROMPT_MIN_ROWS..PROMPT_MAX_ROWS) that scrolls
// only inside itself, and the stats live as compact lines on the status card
// rather than two tall cards. That is what replaces the 0.2.63/0.2.64
// regression: a ScrollBox with `flexGrow: 1` and no height cap measured its
// content at the full parent height, ballooning the card, clipping the
// board below it and pushing the whole modal into a body-wide scroll.
import { getTheme } from "../theme";
import type { GameDefinition } from "./types";
import type { AgentTurnStats, AgentTurnTotals } from "./stats";
import { formatMs, formatTokens } from "./stats";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Text = InstanceType<OpenTui["TextRenderable"]>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type ScrollBox = InstanceType<OpenTui["ScrollBoxRenderable"]>;

type Core = {
  ScrollBoxRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => ScrollBox;
  BoxRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Box;
  TextRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Text;
};

/** A long provider/model id truncates so a status line never clips. */
const MODEL_MAX = 22;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function renderAgentPanel(
  game: GameDefinition,
  parent: { add(child: unknown): void },
  core: Core,
  renderer: Renderer,
  args: {
    notice: string | undefined;
    modelBusy: boolean;
    lastTurn: AgentTurnStats | undefined;
    totals: AgentTurnTotals;
    /** The per-turn user prompt (current board state) the model receives. */
    userPrompt: string;
    /** Fixed height of the prompt card, PROMPT_MIN_ROWS..PROMPT_MAX_ROWS. */
    promptRows: number;
    /** Configured provider/model ("auto/auto" until the first turn). */
    modelParam: string;
  },
): void {
  const theme = getTheme();
  const box = (opts: Record<string, unknown>): Box => new core.BoxRenderable(renderer, opts);
  const text = (opts: Record<string, unknown>): Text => new core.TextRenderable(renderer, opts);

  const card = (id: string, extra: Record<string, unknown> = {}): Box =>
    box({
      id,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.panel,
      paddingLeft: 1,
      paddingRight: 1,
      ...extra,
    });

  // Status card — status line + parameters + compact last-turn/session stats.
  // Three content lines (2 + border + 1 margin = 6 rows) so the board gets
  // the rest of the body; the full two-card table would cost ~13 rows.
  const idle = args.notice === undefined || args.notice === "";
  const statusCard = card("game-status-card", { width: "100%", marginTop: 1 });
  statusCard.add(
    text({
      id: "game-notice",
      content: args.modelBusy ? "agent is thinking…" : idle ? "waiting for your move" : args.notice,
      fg: args.modelBusy ? theme.focus : idle ? theme.text : theme.error,
    }),
  );
  const lt = args.lastTurn;
  const tot = args.totals;
  const shownModel =
    lt !== undefined && lt.provider !== "–" ? truncate(`${lt.provider}/${lt.model}`, MODEL_MAX) : args.modelParam;
  statusCard.add(text({ id: "game-stats-model", content: `model: ${shownModel}`, fg: theme.muted }));
  const lastCore =
    lt === undefined
      ? "no turns yet"
      : `${formatMs(lt.totalMs)} · in ${formatTokens(lt.inputTokens)}/out ${formatTokens(lt.outputTokens)}`;
  const flags: string[] = [];
  if (lt?.reasoning) {
    flags.push("reasoning");
  }
  if (lt?.localFallback) {
    flags.push("fallback");
  }
  if (lt?.error) {
    flags.push("error");
  }
  // One combined stats line keeps the status card at exactly 3 content rows
  // (2 + border + 1 margin = 6), matching PANEL_FIXED_ROWS — four lines would
  // add a row and push the whole modal one row into scroll on a 40-row
  // terminal.
  statusCard.add(
    text({
      id: "game-stats-line",
      content: `last: ${lastCore}${flags.length > 0 ? ` · ${flags.join(", ")}` : ""} · session: ${tot.turns} turn${tot.turns === 1 ? "" : "s"} · ${tot.localFallbacks} fb · ${tot.errors} err · in ${formatTokens(tot.inputTokens)}/out ${formatTokens(tot.outputTokens)}`,
      fg: theme.muted,
    }),
  );
  parent.add(statusCard);

  // Prompt card — system + per-turn user prompt, a BOUNDED minmax-style
  // block: fixed height (promptRows), scrollY, no flexGrow, so it can never
  // absorb the whole modal body. Scrolls only inside itself (wheel / scroll
  // bar / j/k/↑/↓ once focused).
  const sysCard = new core.ScrollBoxRenderable(renderer, {
    id: "game-system-card",
    width: "100%",
    height: args.promptRows,
    minHeight: args.promptRows,
    maxHeight: args.promptRows,
    flexShrink: 0,
    flexGrow: 0,
    marginTop: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.panel,
    paddingLeft: 1,
    paddingRight: 1,
    scrollY: true,
    contentOptions: { flexDirection: "column" },
  });
  // The per-turn user prompt goes FIRST: it changes every move and is what
  // tells the model how the user played; the stable system prompt follows.
  sysCard.add(text({ id: "game-user-title", content: "your turn prompt (board)", fg: theme.muted }));
  sysCard.add(text({ id: "game-user-prompt", content: args.userPrompt, fg: theme.muted }));
  sysCard.add(text({ id: "game-system-title", content: "system prompt", fg: theme.muted }));
  sysCard.add(text({ id: "game-system", content: game.systemPrompt(), fg: theme.muted }));
  parent.add(sysCard);
}
