// `/routing` category assignments (the routing inspector's Categories tab, `keryx routing list`): every category resolved through the
// shared routing table layers (project file under trust, user layer, the session's derived default), against what THIS native session
// can reach: its locally connected routing candidates, never a provider catalog probe. No terminal rendering is involved.
import { loadRoutingConfig } from "../../harness/routing/config";
import { loadActiveRoutingV2 } from "../../harness/routing/active-v2";
import type { NormalizedRoutingV2Config } from "../../harness/routing/config-v2";
import { deriveDefaultTable } from "../../harness/routing/derive-default-table";
import { resolveRoutingForRuntime } from "../../harness/routing/routing-runtime";
import { availablePredicateFromProfiles, loadModelProfiles } from "../../harness/routing/model-profile";
import { connectedPredicateFrom, describeCategoryResolution, describeRejectionNotice, resolveCategoryDetailed, ROUTING_CATEGORIES, sessionDerivationModels, type FlatPickerProvider, type RoutingTable, type SessionModelRef } from "../../harness/routing/table";
import { readTaskCostStore, taskCostLookupFrom } from "../../harness/routing/task-cost";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import type { NativeModelBinding } from "../model-identity";
import { buildNativeRoutingV2Snapshot } from "../native-routing-v2";
import type { NativeCommandContribution } from "./handlers";

export type RoutingCategoriesResult = { ok: true; data: unknown } | { ok: false; error: { code: "invalid-arguments" | "read-failed" | "quota-exceeded"; message: string } };
const empty: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: {}, required: [] };

/** The session's reachable providers: each available routing candidate under its actual provider/model identity. */
export function sessionRoutingProviders(availability: Control["RoutingAvailability"], bindings: readonly NativeModelBinding[], baselineCandidateId: string): { providers: FlatPickerProvider[]; session: SessionModelRef | undefined } {
  const actual = (candidate: Control["RoutingAvailability"]["candidates"][number]) => bindings.find((binding) => binding.providerId === candidate.providerId && binding.modelId === candidate.modelId);
  const byProvider = new Map<string, string[]>();
  let session: SessionModelRef | undefined;
  for (const candidate of availability.candidates) {
    const binding = actual(candidate); if (binding === undefined || !candidate.available) continue;
    byProvider.set(binding.actualProviderId, [...new Set([...(byProvider.get(binding.actualProviderId) ?? []), binding.actualModelId])]);
    if (candidate.candidateId === baselineCandidateId) session = { providerId: binding.actualProviderId, modelId: binding.actualModelId };
  }
  return { providers: [...byProvider].map(([name, models]) => ({ name, models })), session };
}

export interface NativeRoutingCategoriesV2Context {
  readonly availability: Control["RoutingAvailability"];
  readonly bindings: readonly NativeModelBinding[];
  readonly sessionConfig: Control["SessionConfig"];
  readonly cwd?: string;
  readonly configDir?: string;
}

/** Pure v2 preview over one frozen native availability snapshot; no classifier or provider I/O. */
export function previewNativeRoutingCategoriesV2(
  context: NativeRoutingCategoriesV2Context,
  routingConfig: NormalizedRoutingV2Config,
): unknown {
  const frozen = buildNativeRoutingV2Snapshot({
    sessionConfig: context.sessionConfig,
    availability: context.availability,
    bindings: context.bindings,
    routingConfig,
  });
  const categories = ROUTING_CATEGORIES.map((category) => {
    const receipt = resolveRoutingForRuntime({
      request: {
        requestId: `routing-categories:${category}`,
        category,
        origin: "native-session",
        baseline: frozen.baseline.target,
        requirements: { capabilities: [], inputTokensRequired: 0, outputTokensReserved: 0 },
      },
      snapshot: frozen.snapshot,
      config: routingConfig,
      ...(context.cwd === undefined ? {} : { journal: { cwd: context.cwd, ...(context.configDir === undefined ? {} : { configDir: context.configDir }), kind: "preview" as const } }),
    });
    return { category, assignment: routingConfig.categories[category], receipt, decision: receipt.decision };
  });
  const lines = categories.map(({ category, decision }) => {
    const outcome = decision.status === "selected"
      ? `${decision.selection.providerId}/${decision.selection.modelId}`
      : decision.status === "blocked" ? `blocked: ${decision.reason}`
      : decision.status;
    return `${category.padEnd(12)} ${outcome}  [${decision.assignmentSource}]`;
  });
  return {
    engineVersion: 2,
    configDigest: routingConfig.configDigest,
    snapshotDigest: frozen.snapshot.snapshotDigest,
    categories,
    lines,
    baseline: frozen.baseline.target,
  };
}

export async function executeRoutingCategories(context: { cwd: string; configDir?: string; availability: Control["RoutingAvailability"]; bindings: readonly NativeModelBinding[]; baselineCandidateId: string; sessionConfig?: Control["SessionConfig"] }, input: unknown): Promise<RoutingCategoriesResult> {
  if (!validateArguments(empty, input).ok) return { ok: false, error: { code: "invalid-arguments", message: "The routing categories read takes no arguments." } };
  try {
    const activeV2 = loadActiveRoutingV2(context.cwd, context.configDir);
    if (activeV2 !== undefined) {
      if (context.sessionConfig === undefined) throw new Error("active routing v2 preview requires the frozen session config");
      const data = previewNativeRoutingCategoriesV2({ availability: context.availability, bindings: context.bindings, sessionConfig: context.sessionConfig,
        cwd: context.cwd, ...(context.configDir === undefined ? {} : { configDir: context.configDir }) }, activeV2);
      const json = redactSensitiveText(JSON.stringify(data).replaceAll(context.cwd, "."));
      return Buffer.byteLength(json) > 30000 ? { ok: false, error: { code: "quota-exceeded", message: "The routing table exceeds its remote quota." } } : { ok: true, data: JSON.parse(json) as unknown };
    }
    const location = { cwd: context.cwd, ...(context.configDir === undefined ? {} : { userConfigDir: context.configDir }) };
    const [project, user] = await Promise.all([loadRoutingConfig("project", location), loadRoutingConfig("user", location)]);
    const { providers, session } = sessionRoutingProviders(context.availability, context.bindings, context.baselineCandidateId);
    const profiles = loadModelProfiles(context.configDir);
    let derived: RoutingTable = {};
    if (session !== undefined) derived = deriveDefaultTable(session.providerId, sessionDerivationModels(providers, session), profiles, session.modelId, taskCostLookupFrom(readTaskCostStore(context.configDir)));
    const connected = connectedPredicateFrom(providers, session); const available = availablePredicateFromProfiles(profiles);
    const rows = ROUTING_CATEGORIES.map((category) => ({ category, ...resolveCategoryDetailed(category, { project: project.table, user: user.table, derived }, connected, available) }));
    const data = {
      categories: rows.map((row) => ({ category: row.category, assignment: row.assignment, source: row.source, ...(row.rejected === undefined ? {} : { rejected: row.rejected }) })),
      lines: rows.map((row) => `${row.category.padEnd(12)} ${describeCategoryResolution(row, session?.providerId)}  [${row.source}]${row.rejected === undefined ? "" : `  (${describeRejectionNotice(row.rejected, row.assignment)})`}`),
      ...(session === undefined ? {} : { derivedFrom: session.providerId }),
      ...(project.error === undefined ? {} : { projectError: project.error }), ...(project.untrusted === true ? { projectUntrusted: true } : {}), ...(user.error === undefined ? {} : { userError: user.error }),
    };
    const json = redactSensitiveText(JSON.stringify(data).replaceAll(context.cwd, "."));
    return Buffer.byteLength(json) > 30000 ? { ok: false, error: { code: "quota-exceeded", message: "The routing table exceeds its remote quota." } } : { ok: true, data: JSON.parse(json) as unknown };
  } catch { return { ok: false, error: { code: "read-failed", message: "The routing table could not be read." } }; }
}

export function routingCategoryCommands(): NativeCommandContribution[] {
  return [{
    entry: { commandName: "routing.categories", summary: "Show every routing category's resolved model and the layer that answered", handlerId: "native.routing.categories",
      inputSchema: empty, resultSchema: { type: "string", maxLength: 32768 }, mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none",
      availability: "available", reason: "shared-routing-table-resolver" },
    execute: (context, request) => executeRoutingCategories({ cwd: context.cwd, ...(context.configDir === undefined ? {} : { configDir: context.configDir }),
      availability: context.runtime.routing(context.record.config).availability(), bindings: context.runtime.modelBindings(), baselineCandidateId: context.record.config.baselineCandidateId,
      sessionConfig: context.record.config }, request.arguments),
  }];
}
