// The zone table (flow 239, AC-20 / AFC-20) — what each top-level `src/`
// directory IS, for import-direction policy.
//
// This is a DATA CONSTANT, not test logic, and it is shared: `import-policy.ts`
// consumes it to classify a resolved module path, and any other lane that needs
// to know "is this directory core, client, adapter or shared primitives" reads
// it from here rather than re-deriving its own copy. It was NOT embedded in a
// test file on purpose — a fixture test and a future live-source gate both need
// the same table, and a table living inside one test's file would make the
// other a hidden dependency on that file's internals.
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
//               budgets. Never imports CLI/MCP/Shell (client or adapter).
//   - "client"  model/provider auth+registry, turn loop, session
//               streaming/compaction, vendor-agent orchestration, TUI/readline.
//               May reach a core zone's public `service.ts` facade, never a
//               core module's internals.
//   - "adapter" the CLI and MCP transports that expose core+client to a caller.
//               Same restriction as client: facade only into core internals.
//   - "shared"  independent primitives (types, parsing, hashing, paths) below
//               both core and client. Not itself restricted by this table;
//               nothing here enforces a rule FROM shared, only classifies it as
//               a valid TARGET for anyone.
//
// Two directories the spec calls out by name as MISFILED rather than correctly
// classified — `src/lib/narrate.ts` (client narration) and `src/lib/serve-*.ts`
// (adapter server routing) sitting inside the shared-primitives directory — are
// deliberately left mapped to "shared" here, matching their CURRENT location.
// Moving them is Lane A/B's work; this table describes the tree as it is, not
// as the spec says it should end up, so it stays true until that move lands.
export type ImportZone = "core" | "client" | "adapter" | "shared";

export interface ZoneEntry {
  /** The top-level segment directly under `src/`, e.g. `"gdgraph"`. */
  readonly dir: string;
  readonly zone: ImportZone;
}

export const ZONE_TABLE: readonly ZoneEntry[] = [
  // Adapters — CLI and MCP transports.
  { dir: "commands", zone: "adapter" },
  { dir: "mcp", zone: "adapter" },

  // Client — model/provider registry, turn loop, session, TUI, agents.
  { dir: "harness", zone: "client" },
  { dir: "tui", zone: "client" },
  { dir: "session", zone: "client" },
  { dir: "mcp-client", zone: "client" },
  { dir: "agents", zone: "client" },

  // Shared primitives — independent, below both core and client.
  { dir: "lib", zone: "shared" },
  { dir: "contracts", zone: "shared" },
  { dir: "assets", zone: "shared" },
  { dir: "rules", zone: "shared" },

  // Core owners — deterministic operations, policies, source owners, budgets.
  { dir: "gdgraph", zone: "core" },
  { dir: "wiki", zone: "core" },
  { dir: "memory", zone: "core" },
  { dir: "health", zone: "core" },
  { dir: "testing", zone: "core" },
  { dir: "ctx", zone: "core" },
  { dir: "security", zone: "core" },
  { dir: "sac", zone: "core" },
  { dir: "flow", zone: "core" },
  { dir: "standard", zone: "core" },
  { dir: "gdskills", zone: "core" },
  { dir: "metrics", zone: "core" },
  { dir: "review", zone: "core" },
  { dir: "capability", zone: "core" },
  { dir: "job", zone: "core" },
];

const ZONE_BY_DIR: ReadonlyMap<string, ImportZone> = new Map(
  ZONE_TABLE.map((entry) => [entry.dir, entry.zone]),
);

/**
 * The zone of a source path, given the `src/`-equivalent root it is under.
 *
 * `root` is deliberately a parameter rather than a hardcoded `src/` constant:
 * a fixture test roots the same table under a fixture directory (see
 * `import-policy.fixtures.test.ts`) so it exercises the identical
 * classification the real tree would get, without needing a second table.
 *
 * Returns `undefined` for a top-level segment this table does not name (for
 * example a directory added after this table was written) — an unclassified
 * path is neither a target this policy restricts nor one it clears, and the
 * caller decides what silence means for its own check.
 */
export function zoneOf(root: string, absolutePath: string): ImportZone | undefined {
  const relative = absolutePath.startsWith(root) ? absolutePath.slice(root.length) : absolutePath;
  const trimmed = relative.replace(/^[/\\]+/, "");
  const top = trimmed.split(/[/\\]/)[0];
  if (top === undefined || top === "") {
    return undefined;
  }
  return ZONE_BY_DIR.get(top);
}
