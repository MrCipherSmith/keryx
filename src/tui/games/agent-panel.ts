// The "agent panel": the block under the board showing the system prompt the
// model sees each turn plus per-turn latency/token statistics. Rendered as
// three bordered cards — status, system prompt, and a two-column stats table
// (last turn | session totals) — so the operator can read what agent work
// costs at a glance instead of parsing one undifferentiated line.
// Deliberately separate from game rendering so any game gets it for free.
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

/** A half-width stats card at the modal's minimum width; longer ids clip. */
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

  const statRow = (owner: Box, label: string, value: string, id: string, valueFg: string = theme.text): void => {
    const rowBox = box({ flexDirection: "row", gap: 1 });
    rowBox.add(text({ content: label, fg: theme.muted }));
    rowBox.add(text({ id, content: value, fg: valueFg }));
    owner.add(rowBox);
  };

  // Status card — one colored line: thinking / error / idle hint.
  const idle = args.notice === undefined || args.notice === "";
  const statusCard = card("game-status-card", { width: "100%", marginTop: 1 });
  statusCard.add(
    text({
      id: "game-notice",
      content: args.modelBusy ? "agent is thinking…" : idle ? "waiting for your move" : args.notice,
      fg: args.modelBusy ? theme.focus : idle ? theme.text : theme.error,
    }),
  );
  parent.add(statusCard);

  // System prompt card — what the model sees each turn, wrapped as lines.
  // The FULL prompt renders — no "+N more" cap. The card flexes to absorb the
  // leftover body height below the board, and scrolls (wheel, scrollbar, or
  // j/k/↑/↓ once the scrollbar has focus) when the prompt is taller than the
  // space the layout leaves it.
  const sysCard = new core.ScrollBoxRenderable(renderer, {
    id: "game-system-card",
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
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
  sysCard.add(text({ id: "game-system-title", content: "system prompt", fg: theme.muted }));
  sysCard.add(text({ id: "game-system", content: game.systemPrompt(), fg: theme.muted }));
  parent.add(sysCard);

  // Stats cards — last turn | session totals, side by side.
  const lt = args.lastTurn;
  const tot = args.totals;
  const statsRow = box({ id: "game-stats-row", width: "100%", flexDirection: "row", gap: 1, marginTop: 1 });

  const lastTurnCard = card("game-last-turn", { flexGrow: 1, flexShrink: 0 });
  lastTurnCard.add(text({ id: "game-last-turn-title", content: "last turn", fg: theme.muted }));
  if (lt === undefined) {
    lastTurnCard.add(text({ id: "game-stats-empty", content: "no turns yet", fg: theme.muted }));
  } else {
    const model = lt.provider === "–" ? "–" : truncate(`${lt.provider}/${lt.model}`, MODEL_MAX);
    statRow(lastTurnCard, "model", model, "game-stats-model");
    statRow(lastTurnCard, "first byte", formatMs(lt.latencyMs), "game-stats-latency");
    statRow(lastTurnCard, "total", formatMs(lt.totalMs), "game-stats-total");
    statRow(
      lastTurnCard,
      "tokens",
      `in ${formatTokens(lt.inputTokens)} · out ${formatTokens(lt.outputTokens)}`,
      "game-stats-tokens",
    );
    if (lt.reasoning) {
      statRow(lastTurnCard, "reasoning", "yes", "game-stats-reasoning", theme.focus);
    }
    if (lt.localFallback) {
      statRow(lastTurnCard, "fallback", "local", "game-stats-fallback", theme.error);
    }
    if (lt.error) {
      statRow(lastTurnCard, "error", "yes", "game-stats-error", theme.error);
    }
  }

  const sessionCard = card("game-session", { flexGrow: 1, flexShrink: 0 });
  sessionCard.add(text({ id: "game-session-title", content: "session", fg: theme.muted }));
  statRow(sessionCard, "turns", String(tot.turns), "game-session-turns");
  statRow(sessionCard, "fallbacks", String(tot.localFallbacks), "game-session-fallbacks");
  statRow(sessionCard, "errors", String(tot.errors), "game-session-errors");
  statRow(
    sessionCard,
    "tokens",
    `in ${formatTokens(tot.inputTokens)} · out ${formatTokens(tot.outputTokens)}`,
    "game-session-tokens",
  );

  statsRow.add(lastTurnCard);
  statsRow.add(sessionCard);
  parent.add(statsRow);
}
