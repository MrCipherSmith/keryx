// One fail-closed model turn for a game, with timing + usage collected into
// an AgentTurnStats. This is the instrumentation the "agent panel" renders:
// provider/model, first-byte latency, total time, token counts, reasoning.
import { runModelTurn } from "../../harness/provider/single-turn";
import type { GameDefinition, GameMove, GameState, GamesModalOptions } from "./types";
import type { AgentTurnStats } from "./stats";

export interface GamesModelTurnResult {
  move: GameMove | undefined;
  error: string | undefined;
  stats: AgentTurnStats;
}

export async function runGameModelTurn(
  game: GameDefinition,
  state: GameState,
  opts: GamesModalOptions,
): Promise<GamesModelTurnResult> {
  const startedAt = performance.now();
  const turn = await runModelTurn({
    system: game.systemPrompt(),
    user: game.stateForModel(state),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    // Not 16 — on a reasoning-capable model the budget covers the thinking
    // pass too; the visible reply is still one character.
    maxOutputTokens: 256,
    requestId: "keryx-game",
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
  const stats: AgentTurnStats = {
    provider: turn.provider,
    model: turn.model,
    latencyMs: turn.latencyMs,
    totalMs,
    inputTokens: turn.usage?.inputTokens,
    outputTokens: turn.usage?.outputTokens,
    reasoning: turn.reasoning === true,
    localFallback: false,
    error: turn.error !== undefined,
  };
  if (turn.error !== undefined) {
    return { move: undefined, error: `model error: ${turn.error.message}`, stats };
  }
  if (!turn.credentialAvailable && opts.providerFactory === undefined) {
    return { move: undefined, error: "no model credential — configure a provider first (/provider)", stats };
  }
  return { move: game.parseMove(turn.text, state), error: undefined, stats };
}
