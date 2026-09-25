// Flow 305 (Flow A) — the routing table: category -> model. PRD §4/§5,
// docs/requirements/keryx-jev-router/PRD.md.
//
// No classifier anywhere in this file. A category is resolved from whatever
// layers a caller injects (explicit override, per-project config, per-user
// config); resolution falls back to the session's own model (`session-default`)
// when nothing configured it. Pure — no fs/network access itself; every layer
// is handed in already loaded (`config.ts` owns reading `routing.config.json`
// and the per-user shell config).

/**
 * The catalogue of task categories (PRD §4). All eight ship in Flow A; only
 * `review` and `subagents` are actually WIRED to a real call site in v1 (AC5,
 * AC6) — the rest are catalogue entries the table/CLI/TUI already support so a
 * later flow (Flow D) never needs a second migration to add them.
 */
export const ROUTING_CATEGORIES = [
  "default",
  "review",
  "subagents",
  "quick",
  "coding",
  "planning",
  "docs",
  "unattended",
] as const;

export type RoutingCategory = (typeof ROUTING_CATEGORIES)[number];

const ROUTING_CATEGORY_SET: ReadonlySet<string> = new Set(ROUTING_CATEGORIES);

/** Runtime check for a string read off disk / a CLI arg / a modal selection. */
export function isRoutingCategory(value: string): value is RoutingCategory {
  return ROUTING_CATEGORY_SET.has(value);
}

/** Categories an existing call site resolves from the table in Flow A (AC5, AC6). */
export const WIRED_ROUTING_CATEGORIES: ReadonlySet<RoutingCategory> = new Set(["review", "subagents"]);

/**
 * What a category resolves to (PRD §5). `session-default` is the unset state —
 * whatever the session's own provider/model currently is. `model` pins an exact
 * `providerId`/`modelId` pair. `provider-default` pins a provider without
 * pinning an exact model id (resolved to that provider's own notion of a
 * default model at the point of use — see `resolveProviderDefaultModelId` in
 * `provider-default.ts`).
 */
export type CategoryAssignment =
  | { readonly kind: "session-default" }
  | { readonly kind: "model"; readonly providerId: string; readonly modelId: string }
  | { readonly kind: "provider-default"; readonly providerId: string };

export const SESSION_DEFAULT_ASSIGNMENT: CategoryAssignment = { kind: "session-default" };

/** One layer's routing table: a partial map, only the categories it actually sets. */
export type RoutingTable = Partial<Record<RoutingCategory, CategoryAssignment>>;

/** The layers `resolveCategory`/`resolveCategoryDetailed` apply, in precedence order. */
export interface RoutingLayers {
  /** An explicit per-call override (PRD §9.5) — wins over every other layer. */
  readonly override?: CategoryAssignment;
  /** `routing.config.json` at the project root. */
  readonly project?: RoutingTable;
  /** The per-user entry in shell config (`src/lib/shell-config.ts`). */
  readonly user?: RoutingTable;
}

/** Which layer actually produced a resolution — for `keryx routing list` / `/routing`. */
export type RoutingSource = "override" | "project" | "user" | "default";

export interface ResolvedCategory {
  readonly assignment: CategoryAssignment;
  readonly source: RoutingSource;
}

/**
 * Resolve one category against the injected layers, with the precedence order
 * the operator fixed (PRD §5): explicit override > per-project > per-user >
 * `default` (the session's own model, unconditionally available). Reports
 * WHICH layer answered, for display (`keryx routing list`, `/routing`).
 */
export function resolveCategoryDetailed(
  _category: RoutingCategory,
  layers: RoutingLayers,
): ResolvedCategory {
  if (layers.override !== undefined) {
    return { assignment: layers.override, source: "override" };
  }
  const project = layers.project?.[_category];
  if (project !== undefined) {
    return { assignment: project, source: "project" };
  }
  const user = layers.user?.[_category];
  if (user !== undefined) {
    return { assignment: user, source: "user" };
  }
  return { assignment: SESSION_DEFAULT_ASSIGNMENT, source: "default" };
}

/**
 * `resolveCategory(category, layers): CategoryAssignment` (AC1's exact
 * signature) — the assignment alone, for a caller that does not need to know
 * which layer answered.
 */
export function resolveCategory(category: RoutingCategory, layers: RoutingLayers): CategoryAssignment {
  return resolveCategoryDetailed(category, layers).assignment;
}

/** Human-readable form of an assignment, shared by the CLI and the TUI. */
export function describeAssignment(assignment: CategoryAssignment): string {
  switch (assignment.kind) {
    case "session-default":
      return "session default";
    case "model":
      return `${assignment.providerId}/${assignment.modelId}`;
    case "provider-default":
      return `${assignment.providerId} (provider default)`;
    default: {
      const exhaustive: never = assignment;
      return exhaustive;
    }
  }
}

/** Parse a `keryx routing set`/`/routing` picker target into a `CategoryAssignment`. */
export function parseAssignmentTarget(target: string): CategoryAssignment | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    // No slash anywhere — the provider-default form.
    return { kind: "provider-default", providerId: trimmed };
  }
  // A slash IS present but at position 0 (empty provider) or at the very end
  // (empty model) is malformed, not "no slash" — refused, never silently
  // reinterpreted as a provider-default naming the whole (garbled) string.
  if (slash === 0 || slash >= trimmed.length - 1) return undefined;
  const providerId = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (providerId.length === 0 || modelId.length === 0) return undefined;
  return { kind: "model", providerId, modelId };
}

/** One row of the flat model picker (AC4/PRD §7): every connected model, one "provider default" row per connected provider, and one "session default" row. */
export interface FlatModelOption {
  readonly assignment: CategoryAssignment;
  /** `"<providerId>/<modelId>"`, `"<providerId> (provider default)"`, or `"session default"`. */
  readonly label: string;
  /** Lower-cased search text `mountFilterList`'s `matches` filters against. */
  readonly search: string;
}

/** A minimal provider-detection view: just what the flat picker needs. */
export interface FlatPickerProvider {
  readonly name: string;
  readonly models?: readonly string[];
}

/**
 * Flatten every connected provider's models into ONE list (PRD §7,
 * §Non-goals: never a two-step provider-then-model flow), plus one
 * "provider default" row per connected provider and one "session default" row
 * that clears the category back to unset.
 */
export function flatModelOptions(providers: readonly FlatPickerProvider[]): FlatModelOption[] {
  const options: FlatModelOption[] = [
    { assignment: SESSION_DEFAULT_ASSIGNMENT, label: "session default", search: "session default" },
  ];
  for (const provider of providers) {
    options.push({
      assignment: { kind: "provider-default", providerId: provider.name },
      label: `${provider.name} (provider default)`,
      search: `${provider.name} provider default`.toLowerCase(),
    });
    for (const modelId of provider.models ?? []) {
      options.push({
        assignment: { kind: "model", providerId: provider.name, modelId },
        label: `${provider.name}/${modelId}`,
        search: `${provider.name}/${modelId}`.toLowerCase(),
      });
    }
  }
  return options;
}
