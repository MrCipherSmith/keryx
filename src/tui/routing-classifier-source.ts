// Flow 338 — the routing classifier's shell-side wiring: turns one user
// request line into a routed provider/model, or `undefined` when nothing
// should override the session's own model (routing off, a slash command, every classifier stage came back empty).
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
  describeRejectionNotice,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  type CategoryAssignment,
  type FlatPickerProvider,
  type RoutingCategory,
  type RoutingTable,
} from "../harness/routing/table";
import { loadRoutingConfig, type RoutingConfigLocation } from "../harness/routing/config";
import { deriveDefaultTable } from "../harness/routing/derive-default-table";
import { resolveProviderDefaultModelId } from "../harness/routing/provider-default";
import { selectClassifierModel } from "../harness/routing/classifier-model";
import { hasCredential, type ProviderFactory } from "../harness/provider/single-turn";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { redactSensitiveText } from "../security/service";
import { resolveJevClassifierCredential } from "../harness/decision/jev-classifier";
import { resolveExternalSetting } from "../lib/external-switch";
import { externalAllowedConnectedPredicate, loadExternalProvidersConfig } from "../lib/external-providers";
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
  /** Separate caller authorization for the JEV service; /external is still enforced by its client. */
  readonly jevAllowed?: boolean;
  readonly cwd: string;
  readonly detected: readonly FlatPickerProvider[];
  readonly sessionProvider: string;
  readonly sessionModel: string;
  readonly env?: Record<string, string | undefined>;
  readonly userConfigDir?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly providerFactory?: ProviderFactory;
  /** Additional caller policy; denial excludes a model. */
  readonly classifierAllowed?: (providerId: string, modelId: string) => boolean;
  /** Executor policy, separate from classifier policy. */
  readonly executorAllowed?: (providerId: string, modelId: string) => boolean;
}

export interface RoutingClassifierTurnResult {
  readonly classification: ClassifyTurnResult;
  readonly category?: RoutingCategory;
  readonly baseline?: { readonly providerId: string; readonly modelId: string };
  readonly assignment: CategoryAssignment;
  /** First rejected provider-default target and safe failure reason. */
  readonly fallbackReason?: string;
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
 * is a slash command / empty-vocabulary case (`classifyTurn` itself
 * returns `undefined`), or every stage refused.
 */
export async function runRoutingClassifierForTurn(
  line: string,
  opts: RoutingClassifierTurnOptions,
): Promise<RoutingClassifierTurnResult | undefined> {
  if (opts.signal?.aborted) return undefined;
  if (!opts.enabled) return undefined;

  const profiles = loadModelProfiles(opts.userConfigDir);
  const env = envWithSavedApiKeys(opts.env ?? process.env);
  // Mandatory privacy gate, refreshed each turn; caller hooks only restrict further.
  const external = await resolveExternalSetting({ cwd: opts.cwd, ...(opts.userConfigDir !== undefined ? { dir: opts.userConfigDir } : {}) });
  if (opts.signal?.aborted) return undefined;
  const externalAllowed = externalAllowedConnectedPredicate(
    connectedPredicateFrom(opts.detected), external.value === "on",
    loadExternalProvidersConfig(opts.userConfigDir).config,
  );
  const fallbackModel = selectClassifierModel(opts.detected, profiles, (providerId, modelId) =>
    externalAllowed(providerId, modelId) &&
    (opts.classifierAllowed?.(providerId, modelId) ?? true) &&
    (opts.providerFactory !== undefined || hasCredential(providerId, env)),
  );
  const classification = await classifyTurn(line, TURN_CLASSIFIER_CATEGORIES, {
    jevEnabled: opts.jevEnabled && opts.jevAllowed !== false,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    fallbackModel: fallbackModel ?? null,
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    timeoutMs: opts.timeoutMs ?? CLASSIFY_TURN_TIMEOUT_MS,
  });
  if (opts.signal?.aborted) return undefined;
  if (classification === undefined) return undefined;
  const baseline = { providerId: opts.sessionProvider, modelId: opts.sessionModel };
  const skippedJev = opts.jevEnabled && opts.jevAllowed === false ? "jev: caller policy denied"
    : opts.jevEnabled && resolveJevClassifierCredential(opts.env).key === undefined ? "jev: credentials unavailable" : undefined;
  if (!classification.result.ok) {
    const failures = classification.trace.flatMap(stage => stage.result.ok ? [] : [`${stage.source}: ${stage.result.reason}`]);
    return { classification, baseline, assignment: { kind: "session-default" },
      fallbackReason: redactSensitiveText([skippedJev, ...failures,
        fallbackModel === undefined ? "no available authorized sufficient classifier" : undefined,
        classification.result.reason].filter(Boolean).join("; ")) };
  }

  const category = classification.result.category;
  const location: RoutingConfigLocation = { cwd: opts.cwd, ...(opts.userConfigDir !== undefined ? { userConfigDir: opts.userConfigDir } : {}) };
  const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
  if (opts.signal?.aborted) return undefined;
  const connected = connectedPredicateFrom(opts.detected);
  const available = availablePredicateFromProfiles(profiles);
  let fallbackReason: string | undefined;
  // Check the concrete default BEFORE accepting a layer, preserving the
  // project > user > derived > session fallback order of the leaf resolver.
  const connectedForTurn = (providerId: string, modelId?: string): boolean => {
    if (modelId !== undefined) {
      const reason = !connected(providerId, modelId) ? "model not connected"
        : !available(providerId, modelId) ? "model unavailable"
        : !(opts.executorAllowed?.(providerId, modelId) ?? true) ? "executor policy denied"
        : undefined;
      if (reason !== undefined) {
        fallbackReason ??= `${providerId}/${modelId}: ${reason}`;
        return false;
      }
      return true;
    }
    const defaultId = resolveProviderDefaultModelId(providerId);
    const reason = !connected(providerId) ? "provider not connected"
      : defaultId === undefined ? "no documented provider default"
      : !connected(providerId, defaultId) ? "default model not connected"
      : !available(providerId, defaultId) ? "default model unavailable"
      : !(opts.executorAllowed?.(providerId, defaultId) ?? true) ? "executor policy denied"
      : opts.providerFactory === undefined && !hasCredential(providerId, env) ? "credentials unavailable"
      : undefined;
    if (reason !== undefined) {
      fallbackReason ??= `${providerId} (provider default): ${reason}`;
      return false;
    }
    return true;
  };
  // Flow 327's `derived` layer, built from the SAME provider list already on
  // hand (`opts.detected`, no extra probe) against the session's own
  // provider/model — the same shape `keryx routing list` and `/routing` use.
  const sessionProvider = opts.detected.find((p) => p.name === opts.sessionProvider);
  const models = sessionProvider?.models ?? [opts.sessionModel];
  const derived: RoutingTable = deriveDefaultTable(opts.sessionProvider, models, profiles, opts.sessionModel);
  const resolved = resolveCategoryDetailed(category, { project: project.table, user: user.table, derived }, connectedForTurn, available);
  fallbackReason ??= resolved.rejected === undefined ? skippedJev : describeRejectionNotice(resolved.rejected, resolved.assignment);
  const stageFailures = classification.trace.flatMap(stage => stage.result.ok ? [] : [`${stage.source}: ${stage.result.reason}`]);
  const reasons = [...new Set([skippedJev, ...stageFailures, fallbackReason].filter((reason): reason is string => reason !== undefined))];
  fallbackReason = reasons.length === 0 ? undefined : redactSensitiveText(reasons.join("; "));
  const result = { classification, category, baseline, assignment: resolved.assignment,
    ...(fallbackReason !== undefined ? { fallbackReason: redactSensitiveText(fallbackReason) } : {}) };
  if (resolved.assignment.kind === "session-default") return result;
  if (resolved.assignment.kind === "model") {
    return { ...result, routed: { providerId: resolved.assignment.providerId, modelId: resolved.assignment.modelId } };
  }
  // Same documented default as the CLI/child requests, never the baseline
  // or an arbitrary live catalogue entry. Already checked above.
  const modelId = resolveProviderDefaultModelId(resolved.assignment.providerId);
  return modelId === undefined ? result : { ...result, routed: { providerId: resolved.assignment.providerId, modelId } };
}

/** An enabled route must never silently look successful while falling back. */
export function renderRoutingFallbackLine(result: RoutingClassifierTurnResult | undefined): string {
  if (result === undefined) return "[route fallback: no classifier category; using session model]";
  const target = result.baseline === undefined ? "session model" : `${result.baseline.providerId}/${result.baseline.modelId}`;
  return redactSensitiveText(`[route fallback: ${result.category ?? "no classifier category"} -> ${describeAssignment(result.assignment)}${result.fallbackReason !== undefined ? `; ${result.fallbackReason}` : ""}; using ${target}]`);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** AC8: the per-turn tag line, e.g. `[quick -> claude-haiku-4.5]` — shown only when a turn actually routed to something other than the session's own model. */
export function renderRoutingTagLine(result: RoutingClassifierTurnResult): string | undefined {
  if (result.routed === undefined) return undefined;
  const source = result.classification.result.ok ? result.classification.result.source : "none";
  const confidence = result.classification.result.ok ? ` ${pct(result.classification.result.confidence)}` : "";
  return `[${result.category} -> ${result.routed.providerId}/${result.routed.modelId}] (${source}${confidence}${result.fallbackReason !== undefined ? `; fallback: ${result.fallbackReason}` : ""})`;
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
