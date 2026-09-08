// The zone table (flow 239, AC-20 / AFC-20) — what each top-level segment of
// `src/` IS, for import-direction policy.
//
// This is a DATA CONSTANT, not test logic, and it is shared: `import-policy.ts`
// consumes it to classify a resolved module path, `src/core-package.test.ts`
// consumes it to decide what may appear in the published core graph, and any
// other lane that needs to know "is this core, client, adapter or shared
// primitives" reads it from here rather than re-deriving its own copy.
//
// Source: `.metaproject/flows/239-2026-09-06-agent-first-core-phase-7/context.md`
// §2 ("What 'core' and 'client' mean here, derived from the code"), itself
// derived from `docs/requirements/keryx-agent-first-core/implementation-plan.md`
// ("Выделение Shell") and `specification.md` §2 ("Владельцы не импортируют
// CLI/MCP/Shell... narration и model adapters относятся к клиенту, server
// routing — к своему adapter").
//
// Four zones:
//
//   - "core"    deterministic owners: policies, source-owner writers, output
//               budgets, project-state bookkeeping. Never imports CLI/MCP/Shell
//               (client or adapter). This direction has NO exception.
//   - "client"  model/provider auth+registry, turn loop, session
//               streaming/compaction, vendor-agent orchestration, TUI/readline.
//   - "adapter" the CLI and MCP transports that expose core+client to a caller.
//   - "shared"  independent primitives (types, parsing, hashing, paths) below
//               both core and client. Not itself restricted by this table;
//               nothing here enforces a rule FROM shared, only classifies it as
//               a valid TARGET for anyone.
//
// SEGMENTS, NOT ONLY DIRECTORIES
//
// The table originally named directories only, which left the two top-level
// MODULES — `src/cli.ts` and `src/core.ts` — unclassified. That gap was not
// theoretical: `src/core-package.test.ts::forbiddenIn` carries a hardcoded
// `if (module === "src/cli.ts") return true;` immediately before its `zoneOf`
// call, a special case that exists precisely because this table could not
// answer for that file. Both are named here now, and that special case becomes
// redundant rather than load-bearing (removing it belongs to that file's lane).
//
// WHY THIS TABLE AND `src/sac/core-graph.test.ts` READ DIFFERENTLY
//
// That guard's `CLIENT_ZONES` lists `src/commands/`, `src/mcp/` and `src/cli.ts`
// alongside `src/harness/` and `src/tui/`. That is not a contradiction of this
// table, and neither side should be edited to match the other: the two answer
// different questions. `core-graph.test.ts` asks a BINARY packaging question —
// "is this module part of the model runtime AFC-19 keeps out of the shipped
// core graph?" — for which adapters and clients are one bucket. This table asks
// a DIRECTIONAL question — "may a module in zone A import a module in zone B?" —
// for which an adapter (a transport, above both) and a client (the model
// runtime, beside core) have genuinely different import rights. Under this
// table `src/cli.ts` is an adapter; under that guard's coarser partition it
// falls in the not-core bucket it calls "client". Both are correct for their
// own question; only the shared word "client" collides.
//
// Two directories the spec calls out by name as MISFILED rather than correctly
// classified — `src/lib/narrate.ts` (client narration) and `src/lib/serve-*.ts`
// (adapter server routing) sitting inside the shared-primitives directory — are
// deliberately left mapped to "shared" here, matching their CURRENT location.
// Moving them is Lane A/B's work; this table describes the tree as it is, not
// as the spec says it should end up, so it stays true until that move lands.
// The residue is visible in the measured graph as 8 shared→client and 2
// shared→adapter direct edges.

import { readdirSync } from "node:fs";
import path from "node:path";

export type ImportZone = "core" | "client" | "adapter" | "shared";

export interface ZoneEntry {
  /**
   * The top-level segment directly under `src/` — a directory (`"gdgraph"`) or
   * a module (`"cli.ts"`).
   */
  readonly segment: string;
  readonly zone: ImportZone;
}

export const ZONE_TABLE: readonly ZoneEntry[] = [
  // Adapters — CLI and MCP transports.
  { segment: "commands", zone: "adapter" },
  { segment: "mcp", zone: "adapter" },
  // The CLI entry point itself: a transport, not an owner and not the runtime.
  { segment: "cli.ts", zone: "adapter" },

  // Client — model/provider registry, turn loop, session, TUI, agents.
  { segment: "harness", zone: "client" },
  { segment: "tui", zone: "client" },
  { segment: "session", zone: "client" },
  { segment: "mcp-client", zone: "client" },
  { segment: "agents", zone: "client" },

  // Shared primitives — independent, below both core and client.
  { segment: "lib", zone: "shared" },
  { segment: "contracts", zone: "shared" },
  { segment: "assets", zone: "shared" },
  { segment: "rules", zone: "shared" },

  // Core owners — deterministic operations, policies, source owners, budgets.
  { segment: "gdgraph", zone: "core" },
  { segment: "wiki", zone: "core" },
  { segment: "memory", zone: "core" },
  { segment: "health", zone: "core" },
  { segment: "testing", zone: "core" },
  { segment: "ctx", zone: "core" },
  { segment: "security", zone: "core" },
  { segment: "sac", zone: "core" },
  { segment: "flow", zone: "core" },
  { segment: "standard", zone: "core" },
  { segment: "gdskills", zone: "core" },
  { segment: "metrics", zone: "core" },
  { segment: "review", zone: "core" },
  { segment: "capability", zone: "core" },
  { segment: "job", zone: "core" },
  // Added after the original table was written, and unclassified until now —
  // the gap `unclassifiedSegments()` below exists to make impossible to repeat.
  // All three are deterministic project-state bookkeeping with no provider
  // registry, no model selection and no LLM call, and all three are imported by
  // core owners (`src/wiki/staleness.ts` imports `src/sync/provenance.ts`) as
  // well as by adapters, which is the core-zone shape.
  { segment: "eval", zone: "core" },
  { segment: "retention", zone: "core" },
  { segment: "sync", zone: "core" },
  // Cross-layer deletion propagation. Core for the same reason as the three
  // above: deterministic bookkeeping over wiki, memory and graph state with no
  // provider registry and no model call. It was added while this guard was
  // being built and the guard caught it the same day — which is what
  // `unclassifiedSegments()` is for, and worth leaving on the record here
  // rather than quietly registering it as if it had always been named.
  { segment: "forgetting", zone: "core" },
  // The published package's one public door (`exports["."]`), which re-exports
  // the ten declared owner facades and nothing else. It is core BY
  // CONSTRUCTION, and `src/core-package.test.ts` is what proves it stays so.
  { segment: "core.ts", zone: "core" },
];

const ZONE_BY_SEGMENT: ReadonlyMap<string, ImportZone> = new Map(
  ZONE_TABLE.map((entry) => [entry.segment, entry.zone]),
);

/** The top-level segment of `absolutePath` relative to `root`, or `undefined`. */
export function topSegmentOf(root: string, absolutePath: string): string | undefined {
  const relative = absolutePath.startsWith(root) ? absolutePath.slice(root.length) : absolutePath;
  const trimmed = relative.replace(/^[/\\]+/, "");
  const top = trimmed.split(/[/\\]/)[0];
  return top === undefined || top === "" ? undefined : top;
}

/**
 * The zone of a source path, given the `src/`-equivalent root it is under.
 *
 * `root` is deliberately a parameter rather than a hardcoded `src/` constant:
 * a fixture test roots the same table under a fixture directory (see
 * `import-policy.fixtures.test.ts`) so it exercises the identical
 * classification the real tree would get, without needing a second table.
 *
 * Returns `undefined` for a top-level segment this table does not name. That
 * silence is a REPORTABLE STATE, never a clean bill of health: callers must
 * surface it (`import-policy.ts` raises it as an `unclassified-zone` finding)
 * rather than skipping the path. An unclassified module is one this policy has
 * no opinion about, which is not the same as one it has cleared.
 */
export function zoneOf(root: string, absolutePath: string): ImportZone | undefined {
  const top = topSegmentOf(root, absolutePath);
  return top === undefined ? undefined : ZONE_BY_SEGMENT.get(top);
}

/**
 * Every top-level segment that actually exists under `root` and could hold
 * TypeScript source: a directory, or a non-test `.ts`/`.tsx` module.
 *
 * This reads the TREE, on purpose. The table's only previous self-check was
 * `ZONE_TABLE.length > 10`, an assertion that restates the table to itself and
 * therefore cannot notice a directory the table does not cover — which is how
 * `src/eval`, `src/retention` and `src/sync` (the last added by the very commit
 * that wrote the table) stayed unclassified. Deriving the coverage assertion
 * from the filesystem is the difference between a guard that can fail and one
 * that cannot.
 */
export function listZoneSegments(root: string): string[] {
  const segments = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      segments.add(entry.name);
      continue;
    }
    const ext = path.extname(entry.name);
    if (ext !== ".ts" && ext !== ".tsx") {
      continue;
    }
    if (/\.(test|smoke|bench)\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    segments.add(entry.name);
  }
  return [...segments].sort();
}

/** Segments present under `root` that `ZONE_TABLE` does not name. */
export function unclassifiedSegments(root: string): string[] {
  return listZoneSegments(root).filter((segment) => !ZONE_BY_SEGMENT.has(segment));
}

/** Segments `ZONE_TABLE` names that no longer exist under `root`. */
export function staleSegments(root: string): string[] {
  const present = new Set(listZoneSegments(root));
  return ZONE_TABLE.map((entry) => entry.segment)
    .filter((segment) => !present.has(segment))
    .sort();
}
