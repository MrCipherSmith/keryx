import type { MetaprojectEdgeKind, MetaprojectRequest } from "../integrations/metaproject-explorer-contract";
import { metaprojectExplorer } from "../integrations/service";

const EDGE_KINDS: MetaprojectEdgeKind[] = ["imports", "asset", "describes", "links", "contains", "defines", "calls"];

export function parseExplorerRequest(value: unknown): MetaprojectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const exact = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));
  if (input.action === "catalog" && exact("action")) return { action: "catalog" };
  if (input.action === "detail" && exact("action", "id") && typeof input.id === "string" && input.id.length <= 4096) return { action: "detail", id: input.id };
  if (input.action === "search" && exact("action", "query") && typeof input.query === "string" && input.query.length <= 4096) return { action: "search", query: input.query };
  if (input.action === "neighbors" && exact("action", "id", "depth", "direction", "kinds") && typeof input.id === "string" && input.id.length <= 4096 && (input.depth === 1 || input.depth === 2) && (input.direction === "both" || input.direction === "incoming" || input.direction === "outgoing") && Array.isArray(input.kinds) && input.kinds.every((kind) => EDGE_KINDS.includes(kind))) {
    return { action: "neighbors", id: input.id, depth: input.depth, direction: input.direction, kinds: input.kinds };
  }
  throw new Error("Invalid request");
}

export async function metaprojectExplorerCommand(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--request" || !args[1] || args[1].length > 32_768) throw new Error("Usage: keryx metaproject-explorer --request '<json>'");
  const request = parseExplorerRequest(JSON.parse(args[1]) as unknown);
  const output = `${JSON.stringify(await metaprojectExplorer(process.cwd(), request))}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
  });
}
