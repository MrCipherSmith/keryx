// Canonical per-module CLI subcommand lists.
//
// This is the single source of truth for the `commands` arrays written into
// the generated `.metaproject/metaproject.json` manifest by both `init` and
// `update`. Each list must match the subcommands actually dispatched by the
// corresponding `src/commands/<module>.ts` router, so agents that read the
// manifest never invoke a command that does not exist.
//
// When you add or remove a subcommand in a module router, update the matching
// entry here (and only here). The init/update generators consume this map, and
// module-commands.test.ts verifies the generated manifest stays in sync.
export const MODULE_COMMANDS = {
  gdgraph: ["build", "query", "affected"],
  gdctx: ["status", "diff", "rg", "read", "run", "show"],
  gdwiki: ["status", "new", "collect", "index", "check-links", "validate"],
  gdskills: [
    "status",
    "list",
    "inspect",
    "route",
    "catalog",
    "install",
    "create",
    "verify",
    "learn",
    "export",
    "sync",
    "contracts",
  ],
  memory: ["new", "index", "search", "ingest", "check", "reflect"],
  tasks: [
    "init",
    "list",
    "status",
    "freeze",
    "start",
    "task",
    "ac",
    "implemented",
    "complete",
    "block",
    "unblock",
    "check",
  ],
  health: ["run", "status", "gate", "sources", "explain", "baseline", "trend"],
  testing: ["init", "analyze", "run", "status", "context", "explain", "related", "report"],
} as const satisfies Record<string, readonly string[]>;

export type ModuleId = keyof typeof MODULE_COMMANDS;

// Returns a fresh mutable copy so callers can embed it in JSON manifests
// without sharing the frozen source array.
export function moduleCommands(id: ModuleId): string[] {
  return [...MODULE_COMMANDS[id]];
}
