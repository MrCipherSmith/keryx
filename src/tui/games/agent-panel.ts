// The "agent panel": the dim/secondary block under the board showing the
// system prompt the model sees each turn plus per-turn latency/token stats.
// Deliberately separate from game rendering so any game gets it for free.
import { getTheme } from "../theme";
import type { GameDefinition } from "./types";
import type { AgentTurnStats, AgentTurnTotals } from "./stats";
import { formatMs, formatTokens } from "./stats";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

type Core = {
  TextRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Text;
};

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
  const line = (content: string, fg: string, id?: string): void => {
    parent.add(new core.TextRenderable(renderer, { content, fg, ...(id !== undefined ? { id } : {}) }));
  };
  if (args.modelBusy) {
    line("agent is thinking…", theme.focus, "game-notice");
  } else {
    line(args.notice ?? "", theme.error, "game-notice");
  }
  // The system prompt, dim/secondary: what the model sees each turn.
  const sys = game.systemPrompt().split("\n");
  line(`system: ${sys.join(" · ")}`, theme.muted, "game-system");
  const lt = args.lastTurn;
  const tot = args.totals;
  const model = lt === undefined ? "–" : `${lt.provider}/${lt.model}`;
  const parts = [
    `model: ${model}`,
    `first byte ${formatMs(lt?.latencyMs)}`,
    `total ${formatMs(lt?.totalMs)}`,
    `in ${formatTokens(lt?.inputTokens)}`,
    `out ${formatTokens(lt?.outputTokens)}`,
    lt?.reasoning === true ? "reasoning" : undefined,
    `turns ${tot.turns}`,
    `fallbacks ${tot.localFallbacks}`,
    tot.errors > 0 ? `errors ${tot.errors}` : undefined,
  ];
  line(parts.filter((p): p is string => p !== undefined).join(" · "), theme.muted, "game-stats");
}
