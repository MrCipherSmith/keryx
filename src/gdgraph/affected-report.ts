// Flow 308 (W8, Lane B, T6): the one builder behind BOTH `keryx gdgraph
// affected <target> --json` (src/commands/gdgraph.ts#runAffected) and the
// impact-evidence "importers" section (src/security/impact-evidence). AC9
// requires those two to be byte-for-byte the same JSON at the same graph
// state — this module is that shared source, so there is exactly one place
// that decides what the affected-report JSON looks like.
//
// This is a straight extraction of `runAffected`'s `--json` branch (and the
// checks that feed it) out of `src/commands/gdgraph.ts`, with every
// `process.cwd()` replaced by an explicit `root` parameter. `runAffected`
// itself now delegates to `buildAffectedReport` for its `--json` path and is
// otherwise untouched — its non-JSON rendering stays exactly as it was.
//
// Core zone (`src/lib/import-zones.ts`): this module must never import from
// `src/commands` or any other adapter — only from other core modules.

import { loadGraph } from "./query";
import { computeAffected, type AffectedResult } from "./affected";
import { resolveSymbols } from "./symbol";
import { loadGdgraphConfig } from "./config";
import { checkGraphStaleness, type StalenessCheck } from "./staleness";
import { RETRIEVAL_NEXT_ACTIONS, retrievalOutcome } from "../lib/retrieval-codes";
import { explainAbsentGraphTarget, loadDeletionTrail } from "../forgetting/service";

export interface AffectedReportOptions {
  depth?: number;
  ranked?: boolean;
}

export interface AffectedReport {
  // The exit code `runAffected --json` would set for this exact answer.
  exitCode: 0 | 1;
  // The exact object `runAffected --json` prints via
  // `JSON.stringify(json, null, 2)` — one of the three shapes described at
  // the top: index-incomplete, target-not-indexed (with `removal`), or the
  // success `{...affected, freshness}` shape.
  json: Record<string, unknown>;
  // The symbol->file resolution note `runAffected` prints above its text
  // output (non-JSON only) — carried here so a caller that wants it (none do
  // today) does not have to re-derive it.
  resolutionNote: string;
}

/**
 * Build the affected report for `target` under `root`, reproducing
 * `runAffected --json` exactly. A caller error (an ambiguous suffix — see
 * `./target.ts#resolveGraphTarget`) is NOT caught here: it is thrown, the
 * same way `computeAffected` throws it, so a caller maps it to whatever
 * "bad argument" handling it already has (`runAffected`'s `--json` branch
 * catches it and reproduces its existing stderr+exit-1 behavior).
 */
export async function buildAffectedReport(
  root: string,
  targetInput: string,
  opts: AffectedReportOptions = {},
): Promise<AffectedReport> {
  const config = await loadGdgraphConfig(root);
  const depth = opts.depth !== undefined && Number.isFinite(opts.depth) ? opts.depth : config.affected.defaultDepth;
  const ranked = opts.ranked ?? true;

  const graph = await loadGraph(root);

  // Symbol-aware: if the target isn't a known file but names a symbol,
  // resolve it to its owning file — mirrors `runAffected`'s own resolution.
  let target = targetInput;
  const isFile = graph.nodes.some((n) => n.kind === "file" && n.path === target);
  let resolutionNote = "";
  if (!isFile && graph.symbols && graph.symbols.length > 0) {
    const hits = resolveSymbols(graph.symbols, target, 5);
    const files = [...new Set(hits.map((s) => s.path))];
    if (files.length > 0) {
      resolutionNote = `resolved symbol "${target}" → ${files[0]}${files.length > 1 ? ` (+${files.length - 1} more file)` : ""}`;
      target = files[0]!;
    }
  }

  // Caller error (ambiguous suffix): let it throw. See doc comment above.
  const affected: AffectedResult = computeAffected(graph, target, { depth, ranked });

  if (graph.nodes.length === 0) {
    const outcome = retrievalOutcome(
      "index-incomplete",
      "the graph index holds no file nodes — it was never built here, or its storage is unreadable. " +
        "No claim is being made about whether this target exists.",
    );
    const freshness = await checkGraphStaleness(root);
    return {
      exitCode: 1,
      resolutionNote,
      json: {
        schemaVersion: 1,
        code: outcome.code,
        error: outcome.code,
        reason: outcome.reason,
        nextActions: outcome.nextActions,
        target,
        dependencies: [],
        dependents: [],
        freshness,
      },
    };
  }

  const isKnownNode = graph.nodes.some((node) => node.path === affected.target);
  if (!isKnownNode) {
    const absence = explainAbsentGraphTarget(graph, affected.target, await loadDeletionTrail(root));
    const message =
      `gdgraph: "${target}" is not a node in the built graph (never indexed, or the ` +
      `path/symbol does not exist) — this is not the same as an indexed target with ` +
      `zero edges. Run \`keryx gdgraph build\` if the file is new, or double-check the path.`;
    const freshness = await checkGraphStaleness(root);
    return {
      exitCode: 1,
      resolutionNote,
      json: {
        schemaVersion: 1,
        code: "target-not-indexed",
        error: "target-not-indexed",
        reason: message,
        nextActions: RETRIEVAL_NEXT_ACTIONS["target-not-indexed"],
        target,
        dependencies: [],
        dependents: [],
        removal: {
          verdict: absence.verdict,
          reason: absence.reason,
          referencedBy: absence.referencedBy,
          trailPath: absence.removal.path,
        },
        freshness,
      },
    };
  }

  const freshness: StalenessCheck = await checkGraphStaleness(root);
  return {
    exitCode: 0,
    resolutionNote,
    json: { ...affected, freshness },
  };
}
