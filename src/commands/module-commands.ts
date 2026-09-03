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
  gdgraph: ["build", "query", "affected", "repomap"],
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
  memory: ["new", "index", "search", "supersede", "transition", "ingest", "check", "reflect"],
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
  security: [
    "status",
    "scan",
    "check-input",
    "check-output",
    "redact",
    "report",
    "policy",
    "incidents",
  ],
  // The CLI namespace is `workspace`, not `sac` — `moduleCommands()` is keyed
  // by `src/commands/<module>.ts` router names and there is no
  // `src/commands/sac.ts`. The list still belongs here rather than inline in
  // the generators: it previously existed as two hand-written copies, one in
  // `init.ts` and one in `update.ts`, and both had drifted to ten of the
  // sixteen subcommands `workspace.ts` actually dispatches. A list duplicated
  // across write paths is only as accurate as its least-maintained copy.
  // `module-commands.test.ts` derives the expected set from `workspace.ts`'s
  // own dispatch and fails when the two diverge. On its first run it found a
  // seventeenth, `dismiss-candidate`, which was absent from the manifest, from
  // the help banner and from every documentation page — reading the router had
  // missed it, which is the argument for deriving rather than restating.
  sac: [
    "create",
    "list",
    "show",
    "add-resource",
    "archive",
    "remove-resource",
    "rename",
    "overview",
    "read",
    "propose",
    "confirm-review",
    "review",
    "collaboration",
    "policy-readiness",
    "catch-up",
    "list-proposals",
    "dismiss-candidate",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ModuleId = keyof typeof MODULE_COMMANDS;

// Returns a fresh mutable copy so callers can embed it in JSON manifests
// without sharing the frozen source array.
export function moduleCommands(id: ModuleId): string[] {
  return [...MODULE_COMMANDS[id]];
}
