// Flow 338, AC7 — `/route on|off` command matching. No modal (unlike
// `/guard`'s `turn-guard-inspector.ts`): this flow's per-turn visibility is
// the tag under the turn plus the `sb-route` sidebar row
// (`routing-classifier-source.ts`); bare `/route` prints a one-line status
// instead of opening a list+detail modal, kept minimal until a fuller
// history view earns its own flow.

export const ROUTE_COMMAND = "/route";

export function isRouteCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === ROUTE_COMMAND;
}
