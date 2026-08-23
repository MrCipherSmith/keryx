// Games registry: ordered list + id lookup. Kept separate from types.ts so
// types stay declaration-only and the registry stays a pure function.

import type { GameDefinition, GamesRegistry } from "./types";

export function createRegistry(games: readonly GameDefinition[]): GamesRegistry {
  return {
    games,
    get(id: string): GameDefinition | undefined {
      return games.find((game) => game.id === id);
    },
  };
}
