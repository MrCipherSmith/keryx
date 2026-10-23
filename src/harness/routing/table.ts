// Flow 305 (Flow A) — the routing table: category -> model. PRD §4/§5,
// docs/requirements/keryx-jev-router/PRD.md.
//
// No classifier anywhere in this file. A category is resolved from whatever
// layers a caller injects (explicit override, per-project config, per-user
// config); resolution falls back to the session's own model (`session-default`)
// when nothing configured it. Pure — no fs/network access itself; every layer
// is handed in already loaded (`config.ts` owns reading `routing.config.json`
// and the per-user shell config).
import { isDeniedModel } from "../../gdskills/model-denylist";

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
  /**
   * Flow 327, PRD §6.3 — the table keryx builds itself from the session
   * provider's own models/profiles when the operator has configured nothing
   * (`deriveDefaultTable`, `./derive-default-table.ts`). Sits below `user`
   * and above `default` in precedence. A caller that never derives anything
   * (Flow A's own tests, unmodified — AC14) simply omits this field, which is
   * byte-identical to before this layer existed.
   */
  readonly derived?: RoutingTable;
}

/**
 * Which layer actually produced a resolution — for `keryx routing list` /
 * `/routing`. `"derived"` (flow 327, PRD §6.3) is a NEW rung between `"user"`
 * and `"default"`: a table keryx builds itself from the session provider's
 * own models when the operator has configured nothing (`deriveDefaultTable`,
 * `./derive-default-table.ts`).
 */
export type RoutingSource = "override" | "project" | "user" | "derived" | "default";

export interface ResolvedCategory {
  readonly assignment: CategoryAssignment;
  readonly source: RoutingSource;
  /**
   * AC10 (flow 305) / AC10 (flow 327) — the FIRST layer's assignment that was
   * skipped, when one was: either because it named an unconnected
   * provider/model (`reason` omitted — the original flow 305 shape, kept
   * byte-identical so `table.test.ts`'s existing `toEqual` assertions never
   * see an extra key, AC14), or because it named a model whose profile is
   * `available: false` (`reason: "unavailable"`, flow 327 — PRD §6.2). A
   * caller distinguishes the two to show the right notice
   * (`describeFallbackNotice` vs `describeUnavailableNotice`, below).
   */
  readonly rejected?: { readonly assignment: CategoryAssignment; readonly source: RoutingSource; readonly reason?: "unavailable" };
}

/**
 * Whether `providerId` (and, when given, `modelId`) is one the operator has
 * actually connected — AC10's "same notion of connected as `/connect`".
 * Pure and synchronous by construction: a caller builds this from whatever
 * provider list it already has on hand (`configuredProviders()`,
 * `detectProviders()`, an injected `getDetectedProviders()`), never a NEW
 * live probe triggered by resolution itself. See `connectedPredicateFrom`
 * (below) for the standard way to build one.
 */
export type ConnectedPredicate = (providerId: string, modelId?: string) => boolean;

/**
 * Flow 327, PRD §6.2 — whether `providerId`/`modelId`'s stored profile is
 * `available: true` (or has no profile at all, which is "no evidence either
 * way", never treated as unavailable). Built from a profile map via
 * `availablePredicateFromProfiles` (`./model-profile.ts`) — this module
 * itself has no dependency on the profile store, mirroring `ConnectedPredicate`'s
 * own "caller builds it from what it already has" contract.
 */
export type AvailablePredicate = (providerId: string, modelId: string) => boolean;

/** The permissive default: everything is "connected" — existing callers that pass no predicate see no behavior change (AC1 unchanged). */
const ALWAYS_CONNECTED: ConnectedPredicate = () => true;

/** The permissive default: everything is "available" — a caller that passes no predicate sees no behavior change (AC14: Flow A's resolution is unaffected). */
const ALWAYS_AVAILABLE: AvailablePredicate = () => true;

/**
 * Why a candidate assignment was skipped, when it was. `undefined` (the
 * ordinary path) means it was accepted. Kept as a private union rather than
 * folded into `ResolvedCategory.rejected.reason` directly so the "not
 * connected" case can still produce a `rejected` object with NO `reason` key
 * at all (AC14 — see `ResolvedCategory`'s doc).
 */
function rejectionReason(assignment: CategoryAssignment, connected: ConnectedPredicate, available: AvailablePredicate): "not-connected" | "unavailable" | undefined {
  if (assignment.kind === "session-default") return undefined;
  if (assignment.kind === "model") {
    if (!connected(assignment.providerId, assignment.modelId)) return "not-connected";
    if (!available(assignment.providerId, assignment.modelId)) return "unavailable";
    return undefined;
  }
  // "provider-default" — only the connected-check applies (flow 305's
  // original scope); resolving it to a concrete model id to also check
  // availability would pull `provider-default.ts` (which itself imports
  // `../../commands/providers`) into this leaf module for a case the PRD's
  // worked examples never exercise. A provider-default row's OWN concrete
  // model, once resolved downstream (`resolveProviderDefaultModelId`), is
  // checked for availability by whatever calls that — not here.
  return connected(assignment.providerId) ? undefined : "not-connected";
}

/**
 * Resolve one category against the injected layers, with the precedence order
 * the operator fixed (PRD §5, extended by §6.3): explicit override >
 * per-project > per-user > **derived** (flow 327) > `default` (the session's
 * own model, unconditionally available). Reports WHICH layer answered, for
 * display (`keryx routing list`, `/routing`).
 *
 * AC10 (flow 305): `connected` (default: everything is connected, i.e.
 * unchanged behavior) is checked against EVERY candidate layer in precedence
 * order; an assignment naming an unconnected provider/model is treated as
 * though that layer had nothing configured for the category and resolution
 * moves to the next layer, all the way down to `default` if every configured
 * layer names something unconnected.
 *
 * AC10 (flow 327): `available` (default: everything is available, i.e.
 * unchanged behavior — AC14) is checked the same way, for a `"model"`
 * assignment whose profile is `available: false` (PRD §6.2). Both checks run
 * per candidate; either one failing rejects that layer's entry.
 */
export function resolveCategoryDetailed(
  category: RoutingCategory,
  layers: RoutingLayers,
  connected: ConnectedPredicate = ALWAYS_CONNECTED,
  available: AvailablePredicate = ALWAYS_AVAILABLE,
): ResolvedCategory {
  const candidates: ReadonlyArray<{ assignment: CategoryAssignment; source: RoutingSource }> = [
    ...(layers.override !== undefined ? [{ assignment: layers.override, source: "override" as const }] : []),
    ...(layers.project?.[category] !== undefined ? [{ assignment: layers.project[category]!, source: "project" as const }] : []),
    ...(layers.user?.[category] !== undefined ? [{ assignment: layers.user[category]!, source: "user" as const }] : []),
    ...(layers.derived?.[category] !== undefined ? [{ assignment: layers.derived[category]!, source: "derived" as const }] : []),
  ];

  let rejected: { assignment: CategoryAssignment; source: RoutingSource; reason?: "unavailable" } | undefined;
  for (const candidate of candidates) {
    const reason = rejectionReason(candidate.assignment, connected, available);
    if (reason === undefined) {
      return { ...candidate, ...(rejected !== undefined ? { rejected } : {}) };
    }
    // Only the FIRST rejection is carried through (matches flow 305's
    // original `rejected ??=` behavior); `reason` is added ONLY for
    // "unavailable" so the "not connected" shape stays exactly
    // `{assignment, source}` — no `reason` key at all — for AC14.
    rejected ??= reason === "unavailable" ? { ...candidate, reason } : { ...candidate };
  }
  return { assignment: SESSION_DEFAULT_ASSIGNMENT, source: "default", ...(rejected !== undefined ? { rejected } : {}) };
}

/**
 * `resolveCategory(category, layers): CategoryAssignment` (AC1's exact
 * signature) — the assignment alone, for a caller that does not need to know
 * which layer answered. `connected`/`available` are optional and additive
 * (AC10); omitted, behavior is byte-identical to before either existed.
 */
export function resolveCategory(
  category: RoutingCategory,
  layers: RoutingLayers,
  connected: ConnectedPredicate = ALWAYS_CONNECTED,
  available: AvailablePredicate = ALWAYS_AVAILABLE,
): CategoryAssignment {
  return resolveCategoryDetailed(category, layers, connected, available).assignment;
}

/** The provider/model the running session uses (flow 468) — always connected and always pickable. */
export interface SessionModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

/** Why a provider/model counts as connected or not against a provider list (flow 468) — the one decision the predicate, the reason text and the picker rows all read, so they cannot drift. */
export type ConnectVerdict = "connected" | "provider-absent" | "provider-auth-failed" | "provider-unlisted" | "model-denied" | "model-absent";

/** `modelId` omitted asks about the provider alone. A row that only reports a status (auth-failed, list unavailable) is never connected. */
function providerVerdict(provider: FlatPickerProvider, modelId?: string): ConnectVerdict {
  if (provider.authFailed === true) return "provider-auth-failed";
  if (provider.listUnavailable !== undefined) return "provider-unlisted";
  if (modelId === undefined) return "connected";
  if (isDeniedModel(modelId)) return "model-denied";
  const models = provider.models;
  // No reported model list at all -> cannot refute a specific model id;
  // treat the PROVIDER's connectedness as the whole answer rather than
  // falsely rejecting a model this list simply never enumerated.
  if (models === undefined || models.length === 0) return "connected";
  return models.includes(modelId) ? "connected" : "model-absent";
}

/** {@link ConnectVerdict} of `providerId`/`modelId` against `providers`; the session shortcut lives in {@link connectedPredicateFrom}, which wraps this. */
export function connectVerdict(providers: readonly FlatPickerProvider[], providerId: string, modelId?: string): ConnectVerdict {
  const provider = providers.find((p) => p.name === providerId);
  return provider === undefined ? "provider-absent" : providerVerdict(provider, modelId);
}

/** Build a `ConnectedPredicate` from a plain provider list (`configuredProviders()`, `detectProviders()`, or an injected `getDetectedProviders()`) — the shared, non-network-probing shape every call site uses. */
export function connectedPredicateFrom(providers: readonly FlatPickerProvider[], session?: SessionModelRef): ConnectedPredicate {
  return (providerId, modelId) => {
    // Flow 468: the provider/model the session is running on is connected by definition, even when the list handed in lacks it (empty or stale catalog).
    if (session !== undefined && providerId === session.providerId && (modelId === undefined || modelId === session.modelId)) return true;
    return connectVerdict(providers, providerId, modelId) === "connected";
  };
}

/**
 * The model ids the `derived` layer is built from (flow 468): the session
 * provider's own list, or just the session model when that provider is absent
 * or only listed as a status row (auth-failed, list unavailable) — the session
 * runs on it regardless, so it must still derive from something.
 */
export function sessionDerivationModels(providers: readonly FlatPickerProvider[], session: SessionModelRef): readonly string[] {
  const provider = providers.find((p) => p.name === session.providerId && providerVerdict(p) === "connected");
  return provider?.models ?? [session.modelId];
}

/** AC10's exact notice text: `"<provider>/<model> - not connected, falling back to <resolved>"`. */
export function describeFallbackNotice(rejected: CategoryAssignment, resolved: CategoryAssignment): string {
  return `${describeAssignment(rejected)} - not connected, falling back to ${describeAssignment(resolved)}`;
}

/** Flow 327 AC11/AC26 exact notice text: `"<provider>/<model> — unavailable, falling back to <resolved>"` (em dash, distinct from the "not connected" notice above). */
export function describeUnavailableNotice(rejected: CategoryAssignment, resolved: CategoryAssignment): string {
  return `${describeAssignment(rejected)} — unavailable, falling back to ${describeAssignment(resolved)}`;
}

/** The provider list a "not connected" verdict was made against (flow 468), and whether loading it failed. */
export interface ProviderListState {
  readonly providers: readonly FlatPickerProvider[];
  /** The load failed or timed out, so `providers` says nothing about what is connected. */
  readonly unavailable?: boolean;
}

/**
 * Picks the right notice for a `ResolvedCategory.rejected` entry (flow 305's "not connected" vs flow 327's "unavailable", `ResolvedCategory`'s own doc).
 * `list` (flow 468, optional) is the provider list the "not connected" verdict was made against; given it, the notice says WHY, in the Model tab's words
 * (see {@link describeNotConnectedReason}). Omitted, the wording is unchanged.
 */
export function describeRejectionNotice(
  rejected: { readonly assignment: CategoryAssignment; readonly reason?: "unavailable" },
  resolved: CategoryAssignment,
  list?: ProviderListState,
): string {
  if (rejected.reason === "unavailable") return describeUnavailableNotice(rejected.assignment, resolved);
  if (list === undefined) return describeFallbackNotice(rejected.assignment, resolved);
  return `${describeAssignment(rejected.assignment)} - ${describeNotConnectedReason(rejected.assignment, list)}, falling back to ${describeAssignment(resolved)}`;
}

/**
 * Why an assignment counted as not connected against `list` (flow 468): the Model tab's words, from the same {@link connectVerdict} the predicate used.
 * "provider list unavailable" only when the load failed; "no providers connected" when it loaded and is empty.
 */
export function describeNotConnectedReason(assignment: CategoryAssignment, list: ProviderListState): string {
  if (assignment.kind === "session-default") return "not connected";
  if (list.unavailable === true) return "provider list unavailable";
  if (list.providers.length === 0) return "no providers connected";
  switch (connectVerdict(list.providers, assignment.providerId, assignment.kind === "model" ? assignment.modelId : undefined)) {
    case "provider-absent":
      return "provider not connected";
    case "provider-unlisted":
      return `model list unavailable (${list.providers.find((p) => p.name === assignment.providerId)?.listUnavailable ?? "no list"})`;
    case "provider-auth-failed":
      return "provider auth failed";
    case "model-absent":
      return `model not in ${assignment.providerId}'s list`;
    case "model-denied":
    case "connected":
      return "not connected";
  }
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

/**
 * AC11/AC20 — the resolved text for one `keryx routing list`/`/routing` row,
 * distinguishing `session default` / `auto (derived from <provider>'s
 * models) -> <resolved>` (flow 327, PRD §6.4) / an explicit
 * `<provider>/<model>` / `<provider> (provider default)`. Shared by the CLI
 * (`src/commands/routing.ts`) and the TUI (`src/tui/routing-inspector.ts`) so
 * the two never drift.
 */
export function describeCategoryResolution(row: { readonly source: RoutingSource; readonly assignment: CategoryAssignment }, sessionProviderId: string | undefined): string {
  if (row.source === "derived" && sessionProviderId !== undefined) {
    return `auto (derived from ${sessionProviderId}'s models) -> ${describeAssignment(row.assignment)}`;
  }
  return describeAssignment(row.assignment);
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
  /**
   * Flow 309, AC4 — `models` is the curated OFFLINE fallback (the provider's
   * live `/models` fetch failed, or it has no live listing endpoint) rather
   * than a live catalog reading. `flatModelOptions` suffixes every model row
   * " (offline list)" so the picker never presents a stale/documentary id as
   * though it were confirmed available. Omitted (the default, `false`) is
   * byte-identical to every caller before flow 309 — `search` is unaffected
   * either way, so filtering by a bare model id still works.
   */
  readonly offline?: boolean;
  /** Flow 468 — the provider is in the catalog but its credential was rejected (`auth-failed`). It carries no models; the Model tab shows it with a `/connect` hint instead of omitting it. */
  readonly authFailed?: boolean;
  /** Flow 468 — the provider is connected but has no model list to show: its live fetch failed (or it has no live endpoint) and there is no curated fallback. The value is the reason ("unreachable", "timed out", "no live listing"); the Model tab shows it instead of omitting the provider, and it is never selectable. */
  readonly listUnavailable?: string;
}

/**
 * Flatten every connected provider's models into ONE list (PRD §7,
 * §Non-goals: never a two-step provider-then-model flow), plus one
 * "provider default" row per connected provider and one "session default" row
 * that clears the category back to unset. What is "connected" is
 * {@link providerVerdict}'s call, the same one resolution makes.
 */
export function flatModelOptions(providers: readonly FlatPickerProvider[], session?: SessionModelRef): FlatModelOption[] {
  const options: FlatModelOption[] = [
    { assignment: SESSION_DEFAULT_ASSIGNMENT, label: "session default", search: "session default" },
  ];
  for (const provider of providers) options.push(...providerOptions(provider, session));
  // Flow 468: the session's own model is always a row, labelled, even when the catalog lacks it (listed once, in place, when it has it).
  if (session !== undefined && !options.some((o) => isSessionAssignment(o.assignment, session))) {
    options.splice(1, 0, sessionModelOption(session));
  }
  return options;
}

const SESSION_SUFFIX = " (current session)";

function isSessionAssignment(assignment: CategoryAssignment, session: SessionModelRef): boolean {
  return assignment.kind === "model" && assignment.providerId === session.providerId && assignment.modelId === session.modelId;
}

function sessionModelOption(session: SessionModelRef): FlatModelOption {
  return {
    assignment: { kind: "model", providerId: session.providerId, modelId: session.modelId },
    label: `${session.providerId}/${session.modelId}${SESSION_SUFFIX}`,
    search: `${session.providerId}/${session.modelId}`.toLowerCase(),
  };
}

/** One provider's picker rows: its "provider default" row, then a row per model it can actually serve. Nothing for a provider that only reports a status. */
function providerOptions(provider: FlatPickerProvider, session?: SessionModelRef): FlatModelOption[] {
  if (providerVerdict(provider) !== "connected") return [];
  const options: FlatModelOption[] = [
    {
      assignment: { kind: "provider-default", providerId: provider.name },
      label: `${provider.name} (provider default)`,
      search: `${provider.name} provider default`.toLowerCase(),
    },
  ];
  const offlineSuffix = provider.offline === true ? " (offline list)" : "";
  for (const modelId of provider.models ?? []) {
    if (providerVerdict(provider, modelId) !== "connected") continue;
    const assignment: CategoryAssignment = { kind: "model", providerId: provider.name, modelId };
    const sessionSuffix = session !== undefined && isSessionAssignment(assignment, session) ? SESSION_SUFFIX : "";
    options.push({ assignment, label: `${provider.name}/${modelId}${offlineSuffix}${sessionSuffix}`, search: `${provider.name}/${modelId}`.toLowerCase() });
  }
  return options;
}
