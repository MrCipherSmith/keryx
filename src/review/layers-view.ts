// One projection of `layers.json` for every surface that prints it: the CLI, the
// `/review layers` slash command, the readline text and the TUI (flow 431, AC12).

import type { Divergence, LayersFile } from "./layers";

const SHORT = 7;

export function shortSha(sha: string | null): string {
  return sha === null || sha === "" ? "none" : sha.slice(0, SHORT);
}

function divergenceText(divergence: Divergence): string {
  if (divergence.state === "none") return "none";
  if (divergence.state === "unknown") return "unknown";
  const paths = divergence.changedPaths.length;
  return `differs (${divergence.commitsBetween ?? "?"} commit(s), ${paths} wiki/memory path(s))`;
}

/** `head` when the graph was built from the PR head, `differs` otherwise (a failed graph differs). */
export function graphHeadState(layers: LayersFile): "head" | "differs" {
  return layers.graph.status === "ok" && layers.graphCommit !== null && layers.graphCommit === layers.prHead ? "head" : "differs";
}

/** The one-line form: `graph@<sha7> = head|differs; wiki <d>; memory <d>`. */
export function layersSummaryLine(layers: LayersFile): string {
  const graph = layers.graph.status === "ok" ? `graph@${shortSha(layers.graphCommit)} = ${graphHeadState(layers)}` : `graph: ${layers.graph.status}`;
  return `${graph}; wiki ${divergenceText(layers.wiki.divergence)}; memory ${divergenceText(layers.memory.divergence)}`;
}

/** The full lines: one per layer, then the changed paths of a divergence. */
export function layersDetailLines(layers: LayersFile): string[] {
  const lines: string[] = [];
  const graph = layers.graph;
  lines.push(
    graph.status === "ok"
      ? `graph: ok @${shortSha(graph.commit)} = ${graphHeadState(layers)} (PR head ${shortSha(layers.prHead)}), ${graph.nodes} nodes, ${graph.edges} edges, built ${graph.builtAt ?? "?"}`
      : `graph: ${graph.status}${graph.error ? ` — ${graph.error}` : ""}${graph.status === "failed" ? " (not retried automatically for a few minutes at the same head; refresh --force retries now)" : ""}`,
  );
  const wiki = layers.wiki;
  lines.push(
    `wiki: ${wiki.status} @${shortSha(wiki.commit)}, divergence ${divergenceText(wiki.divergence)}, ${wiki.pagesRefreshed} page(s) ${wiki.written ? "refreshed" : "would refresh (dry run)"}, ` +
      `${wiki.pagesStaleProse === null ? "stale prose unknown" : `${wiki.pagesStaleProse} page(s) with stale prose`}${wiki.error ? ` — ${wiki.error}` : ""}`,
  );
  const memory = layers.memory;
  lines.push(
    `memory: ${memory.status} @${shortSha(memory.commit)}, divergence ${divergenceText(memory.divergence)}, ${memory.entries} entr${memory.entries === 1 ? "y" : "ies"}${memory.error ? ` — ${memory.error}` : ""}`,
  );
  for (const [name, divergence] of [["wiki", wiki.divergence], ["memory", memory.divergence]] as const) {
    for (const changed of divergence.changedPaths) lines.push(`  ${name} differs: ${changed}`);
  }
  return lines;
}
