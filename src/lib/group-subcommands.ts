// Flow 353 review round 1 (blocker L1): AC3's "did you mean" was wired for
// the top-level unknown command (`cli.ts`) and for `keryx mcp <sub>` only —
// every other group with real subcommands (`keryx health rn`, `keryx wiki
// serach`, ...) still dumped its full usage on a typo. This is the single
// source of truth `cli.ts`'s central dispatch (`main()`) consults for "does
// this group take a subcommand first, and if so, which ones are real".
//
// NOT derived from `standard/command-registry.ts`: that registry is a
// curated AGENT-CALLABLE subset (its own coverage test enforces "every
// described command belongs to a verb the CLI dispatches", never the
// reverse) — `health`, for one concrete example, has only two descriptors
// (`health run`, `health explain`) while the real CLI has seven subcommands
// (`status`, `gate`, `sources`, `baseline`, `trend` are absent). Using it
// here would make `keryx health status` — a real, working command — report
// itself as unknown.
//
// NOT derived from `cli.ts`'s own `USAGE_BODY`/`groupUsage` either: that
// flat block is also incomplete for some groups (`wiki` lists 5 lines;
// the real dispatch in `commands/wiki.ts` has 15 subcommands — `ask`,
// `freshness`, `sections`, `enrich`, `backlinks`, … never made it into the
// flat summary) and, for a few groups, compresses several subcommands onto
// one line with `|` in a way a generic parser cannot reliably split from
// every other flag/placeholder shape in that same block.
//
// So: read directly from each group's own dispatch code (every literal this
// file's own comment above each entry names the exact lines it came from),
// which is authoritative because it IS what the handler actually accepts.
// Deliberately NOT exhaustive over `CLI_ROUTES` — a group is listed here
// only when its first positional argument is unambiguously a closed,
// literal subcommand vocabulary. Left out, on purpose, because the first
// token is a genuine positional (a path, a free-text prompt, an id, an
// optional runtime name) rather than a subcommand, so guessing wrong would
// break real usage, not just a typo: `orient` (`[<runtime>]`), `sync`
// (`[--apply]`, subcommands are secondary), `harness` (`run` takes a
// free-text prompt as its own first token), `commands` (filters only),
// `skill-verify-skill` (a target, not a subcommand), and every group this
// file does not mention. `agents` and `shell` are `cli.ts`'s own
// `DEEP_HELP_GROUPS` (they answer their own `--help` and, for `agents`,
// already validate `bootstrap`'s own sub-subcommand itself) and are
// deliberately excluded here too, so this module never fights that
// existing special-casing.
export const GROUP_SUBCOMMANDS: ReadonlyMap<string, readonly string[]> = new Map([
  // commands/modules.ts:98,142,149,165
  ["modules", ["status", "list", "enable", "on", "disable", "off", "interactive", "help"]],
  // commands/projects.ts:26,39,56,61
  ["projects", ["list", "register", "forget", "help"]],
  // commands/providers.ts:1310-1326
  ["providers", ["list", "status", "cross-family", "test", "remove"]],
  // commands/routing.ts:373-393
  ["routing", ["list", "set", "unset", "trust", "profile", "stats"]],
  // commands/external.ts:142-150
  ["external", ["on", "off", "status", "list"]],
  // commands/auth.ts:24-36
  ["auth", ["list", "login", "logout", "status"]],
  // commands/approvals.ts (flow 369): list (also the bare default), allow, deny
  ["approvals", ["list", "allow", "deny"]],
  // commands/version.ts:19 (`args[0] !== "check"` is refused)
  ["version", ["check"]],
  // commands/gdgraph.ts:81-206
  ["gdgraph", ["build", "query", "find", "symbol", "symbols", "path", "affected", "repomap", "context", "assets"]],
  // commands/ctx.ts:108-155
  ["ctx", ["status", "diff", "rg", "read", "run", "show", "hook", "install-hook", "uninstall-hook"]],
  // commands/wiki.ts:36-107 — the full real dispatch, not the flat USAGE_BODY slice (see module doc above)
  [
    "wiki",
    [
      "status",
      "new",
      "index",
      "collect",
      "check-links",
      "validate",
      "freshness",
      "refresh",
      "verify",
      "migrate-markers",
      "ask",
      "sections",
      "enrich",
      "context",
      "backlinks",
      "history",
      "restore",
    ],
  ],
  // commands/stack.ts:18
  ["stack", ["detect"]],
  // commands/health.ts:21-45 — real dispatch; command-registry.ts describes only 2 of these 7
  ["health", ["run", "status", "gate", "sources", "explain", "baseline", "trend"]],
  // commands/metrics.ts:64-175
  ["metrics", ["status", "validate", "collect", "latest", "show", "compare", "rebuild", "plan", "benchmark"]],
  // commands/test.ts:23-55
  ["test", ["init", "analyze", "run", "status", "context", "report", "related", "explain", "coverage-map", "suggest"]],
  // commands/memory.ts:47-89
  ["memory", ["new", "index", "search", "supersede", "transition", "assets", "ingest", "check", "reflect", "handoff"]],
  // commands/flow.ts:326-366
  [
    "flow",
    [
      "init",
      "list",
      "status",
      "freeze",
      "start",
      "next",
      "task",
      "ac",
      "check-ac",
      "owner",
      "outcome",
      "implemented",
      "complete",
      "check-complete",
      "confirm",
      "recover",
      "block",
      "unblock",
      "check",
      "renumber",
      "repair-reviews",
      "plan",
      "schema",
    ],
  ],
  // commands/job.ts:76-86
  ["job", ["init", "status", "step", "document", "complete", "list"]],
  // commands/review.ts:544-676
  [
    "review",
    [
      "attach",
      "start",
      "ingest",
      "scope",
      "floor",
      "blast-radius",
      "budget",
      "tier",
      "comments",
      "ci-triage",
      "conform",
      "bot",
      "metrics",
      "jev-rules",
      "jev-edit-guard",
      "jev-risk",
      "jev-scenarios",
      "jev-docs",
      "jev-comments",
      "jev-contract",
      "jev-triage",
      "jev-select",
      "jev-profile",
      "learn",
      "loop",
      "stack",
      "reviewers",
      "import",
      "status",
      "complete",
      "lightweight",
    ],
  ],
  // commands/rules.ts:49 (`sync` | `distill`), :106
  ["rules", ["distill", "sync"]],
  // commands/standard.ts:36-48
  ["standard", ["validate", "doctor", "capabilities", "baseline", "emit"]],
  // commands/security.ts:95-131 (excludes the unrelated redaction-mode switch further down the same file)
  [
    "security",
    [
      "status",
      "scan",
      "scan-mcp",
      "audit-harness",
      "impact-evidence",
      "check-input",
      "check-output",
      "redact",
      "report",
      "policy",
      "incidents",
      "hooks",
      "eval",
    ],
  ],
  // commands/sandbox.ts:181 (only "status" and its bare-alias are real)
  ["sandbox", ["status"]],
  // `integrate` is deliberately NOT here: its first positional is a comma-joined
  // editor list (`keryx integrate cursor,claude`, commands/integrate.ts
  // `parseEditors`), not one literal subcommand — flow 353 review round 2, L3.
  // commands/integrations.ts:36-52
  ["integrations", ["install", "uninstall", "doctor", "matrix"]],
  // commands/workspace.ts:31-270 (bare "help", not just "--help"/"-h", is also real there)
  [
    "workspace",
    [
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
      "dismiss-candidate",
      "handoff",
      "collaboration",
      "policy-readiness",
      "catch-up",
      "list-proposals",
      "help",
    ],
  ],
  // commands/retention.ts:90-93
  ["retention", ["status", "sweep"]],
  // commands/forgetting.ts:41-45
  ["forgetting", ["trail", "lookup"]],
  // commands/trigger.ts:116-128
  ["trigger", ["run", "install", "uninstall", "list", "status", "schedule", "resolve"]],
  // commands/schedule.ts:173-189
  ["schedule", ["add", "list", "show", "pause", "resume", "run", "remove"]],
  // commands/governance.ts:86-90
  ["governance", ["report", "show"]],
  // commands/product.ts (productCommand dispatch)
  ["product", ["index", "open"]],
  // commands/hooks.ts:1247-1271 (excludes the unrelated hook-event-name switch earlier in the same file)
  ["hooks", ["list", "validate", "test", "enable", "disable", "trust", "untrust"]],
  // commands/bundle.ts:52-68
  ["bundle", ["export", "import", "inspect", "verify", "uninstall"]],
  // commands/learn.ts:684-693
  ["learn", ["observe", "extract", "list", "review", "accept", "reject", "apply", "promote", "graduate", "prune"]],
  // commands/sessions.ts:18-155; "session" (singular) routes to the SAME handler
  ["sessions", ["list", "fork", "export", "path", "help"]],
  ["session", ["list", "fork", "export", "path", "help"]],
  // commands/serve.ts:159-167 (top level only — "token"/"config" have their own nested subcommands this file does not check)
  ["serve", ["status", "token", "config"]],
  // commands/bus.ts:72-116
  ["bus", ["list", "log", "send", "pause", "resume", "prune", "help"]],
  // commands/dashboard.ts:20-28
  ["dashboard", ["build", "open"]],
  // commands/skills.ts:110-205 (top-level dispatch only; "contracts validate" nests further)
  [
    "skills",
    [
      "catalog",
      "install",
      "doctor",
      "uninstall",
      "status",
      "list",
      "inspect",
      "route",
      "create",
      "generate",
      "import",
      "update",
      "remove",
      "verify",
      "learn",
      "export",
      "sync",
      "contracts",
      "scout",
      "eval",
      "judge-check",
      "stocktake",
    ],
  ],
]);
