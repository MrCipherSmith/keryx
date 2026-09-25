// Flow 338 — the routing classifier's shell-side wiring: turns one user
// request line into a routed provider/model, or `undefined` when nothing
// should override the session's own model (routing off, a slash command, a
// pinned session model, or every classifier stage came back empty).
//
// `src/tui/` is a CLIENT zone and may import both the decision-layer
// classifiers and the routing table freely — same shape `turn-guard-
// source.ts` already uses for `../review/turn-guard` + `../harness/decision/
// jev-client`.

import {
  classifyTurn,
  CLASSIFY_TURN_TIMEOUT_MS,
  type ClassifyTurnResult,
} from "../harness/decision/classify-turn";
import type { TaskClassifierUsage } from "../harness/decision/classifier";
import {
  connectedPredicateFrom,
  describeAssignment,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  type CategoryAssignment,
  type FlatPickerProvider,
  type RoutingCategory,
  type RoutingTable,
} from "../harness/routing/table";
import { loadRoutingConfig, type RoutingConfigLocation } from "../harness/routing/config";
import { deriveDefaultTable } from "../harness/routing/derive-default-table";
import { availablePredicateFromProfiles, loadModelProfiles } from "../harness/routing/model-profile";

/**
 * The interactive turn's candidate vocabulary: every catalogue category
 * (PRD §4) EXCEPT `"default"` — picking `"default"` would mean "use the
 * session's own model", which is exactly what happens when nothing routes
 * at all, so it is never a useful classifier answer. Deliberately wider
 * than `WIRED_ROUTING_CATEGORIES` (`table.ts`) — that set tracks which
 * categories a call site ALREADY consults the table for (`review`,
 * `subagents`, flow 305); this flow's classifier is the first caller that
 * needs the full catalogue as its own candidate list for an interactive
 * turn, independent of that narrower "wired" bookkeeping.
 */
const TURN_CLASSIFIER_CATEGORIES: readonly RoutingCategory[] = ROUTING_CATEGORIES.filter((c) => c !== "default");

export interface RoutingClassifierTurnOptions {
  readonly enabled: boolean;
  readonly jevEnabled: boolean;
  readonly cwd: string;
  readonly detected: readonly FlatPickerProvider[];
  readonly sessionProvider: string;
  readonly sessionModel: string;
  readonly env?: Record<string, string | undefined>;
  readonly userConfigDir?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface RoutingClassifierTurnResult {
  readonly classification: ClassifyTurnResult;
  readonly category: RoutingCategory;
  readonly assignment: CategoryAssignment;
  /** `undefined` when the resolved assignment is `session-default` — nothing to route to, the session's own model applies unchanged. */
  readonly routed?: { readonly providerId: string; readonly modelId: string };
}

/**
 * AC5/AC6/AC7: run the classifier chain, then resolve the winning category
 * through the SAME `resolveCategoryDetailed` — project + user + `derived`
 * layers, exactly what `keryx routing list` (`../commands/routing.ts`) and
 * `/routing` (`./routing-inspector.ts`) already build via `deriveDefaultTable`
 * (flow 327, PRD §6.3). Unlike those two call sites, this one is ALWAYS
 * inside a live turn — `opts.sessionProvider`/`opts.sessionModel` are
 * required fields here, never `undefined` — so the derived table always
 * builds; there is no "session not known yet" branch to guard for.
 *
 * This intentionally reaches further than `review`/`subagents`
 * (`commands/review.ts`, `spawn-subagent-tool.ts`), which still resolve from
 * project + user only (flow 305's original scope, predating the derived
 * layer). Without `derived` here, an operator who has configured nothing —
 * the common case — would see every category resolve to `session-default`,
 * making `/route on` a no-op: the whole point of this flow is to route an
 * UNCONFIGURED operator to the derived table's per-category pick (the
 * strongest model for planning/review, one step down for
 * subagents/docs/unattended, the smallest for quick), not just to honor
 * explicit configuration. Returns `undefined` when routing is off, the line
 * is a slash command / pinned / empty-vocabulary case (`classifyTurn` itself
 * returns `undefined`), or every stage refused.
 */
export async function runRoutingClassifierForTurn(
  line: string,
  opts: RoutingClassifierTurnOptions,
): Promise<RoutingClassifierTurnResult | undefined> {
  if (!opts.enabled) return undefined;

  const classification = await classifyTurn(line, TURN_CLASSIFIER_CATEGORIES, {
    jevEnabled: opts.jevEnabled,
    sessionProvider: opts.sessionProvider,
    sessionModel: opts.sessionModel,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    timeoutMs: opts.timeoutMs ?? CLASSIFY_TURN_TIMEOUT_MS,
  });
  if (classification === undefined || !classification.result.ok) return undefined;

  const category = classification.result.category;
  const location: RoutingConfigLocation = { cwd: opts.cwd, ...(opts.userConfigDir !== undefined ? { userConfigDir: opts.userConfigDir } : {}) };
  const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
  const connected = connectedPredicateFrom(opts.detected);
  const profiles = loadModelProfiles(opts.userConfigDir);
  const available = availablePredicateFromProfiles(profiles);
  // Flow 327's `derived` layer, built from the SAME provider list already on
  // hand (`opts.detected`, no extra probe) against the session's own
  // provider/model — the same shape `keryx routing list` and `/routing` use.
  const sessionProvider = opts.detected.find((p) => p.name === opts.sessionProvider);
  const models = sessionProvider?.models ?? [opts.sessionModel];
  const derived: RoutingTable = deriveDefaultTable(opts.sessionProvider, models, profiles, opts.sessionModel);
  const resolved = resolveCategoryDetailed(category, { project: project.table, user: user.table, derived }, connected, available);

  if (resolved.assignment.kind === "session-default") {
    return { classification, category, assignment: resolved.assignment };
  }
  if (resolved.assignment.kind === "model") {
    return { classification, category, assignment: resolved.assignment, routed: { providerId: resolved.assignment.providerId, modelId: resolved.assignment.modelId } };
  }
  // "provider-default" — resolved to a concrete model id is the modal/CLI's
  // job (`categoryAssignmentToChildModelRequest`); a turn-routing call site
  // that cannot name a concrete model falls back to the session's own model
  // rather than guessing one, same fail-closed spirit as every other stage
  // in this chain.
  return { classification, category, assignment: resolved.assignment };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** AC8: the per-turn tag line, e.g. `[quick -> claude-haiku-4.5]` — shown only when a turn actually routed to something other than the session's own model. */
export function renderRoutingTagLine(result: RoutingClassifierTurnResult): string | undefined {
  if (result.routed === undefined) return undefined;
  const source = result.classification.result.ok ? result.classification.result.source : "none";
  const confidence = result.classification.result.ok ? ` ${pct(result.classification.result.confidence)}` : "";
  return `[${result.category} -> ${result.routed.providerId}/${result.routed.modelId}] (${source}${confidence})`;
}

/** AC9: the per-turn tag's usage detail line, when the classifying stage reached a real client. */
export function renderRoutingUsageLine(usage: TaskClassifierUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const parts = [
    usage.inputTokens !== undefined ? `↑${usage.inputTokens}` : undefined,
    usage.outputTokens !== undefined ? `↓${usage.outputTokens}` : undefined,
    usage.cost !== undefined ? `$${usage.cost.toFixed(4)}` : undefined,
    usage.latencyMs !== undefined ? `${usage.latencyMs}ms` : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? `usage: ${parts.join(" ")}` : undefined;
}

/** AC8: the `sb-route` sidebar line — `"on · N routed"` / `"off"`. */
export function renderRoutingSidebarValue(enabled: boolean, routedCount: number, lastCategory?: RoutingCategory): string {
  if (!enabled) return "off";
  return `on · ${routedCount} routed${lastCategory !== undefined ? ` (last: ${lastCategory})` : ""}`;
}

/** Shared with the CLI/other surfaces — kept here rather than duplicated (`describeAssignment` already does the same for `table.ts`'s own callers). */
export { describeAssignment };
