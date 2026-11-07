// `/routing` category assignments (the routing inspector's Categories tab, `keryx routing list`): every category resolved through the
// routing settings (trusted project layer, user layer, built-in baseline), against what THIS native session can reach: its locally
// connected routing candidates, never a provider catalog probe. No terminal rendering is involved.
import { normalizeRoutingConfig, type NormalizedRoutingConfig } from "../../harness/routing/config";
import { readRoutingSettings, ROUTING_NORMALIZATION } from "../../harness/routing/settings";
import { resolveRoutingForRuntime } from "../../harness/routing/routing-runtime";
import { ROUTING_CATEGORIES, type FlatPickerProvider, type SessionModelRef } from "../../harness/routing/table";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import type { NativeModelBinding } from "../model-identity";
import { buildNativeRoutingSnapshot } from "../native-routing";
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

export interface NativeRoutingCategoriesContext {
  readonly availability: Control["RoutingAvailability"];
  readonly bindings: readonly NativeModelBinding[];
  readonly sessionConfig: Control["SessionConfig"];
  readonly cwd?: string;
  readonly configDir?: string;
}

/** Pure routing preview over one frozen native availability snapshot; no classifier or provider I/O. */
export function previewNativeRoutingCategories(
  context: NativeRoutingCategoriesContext,
  routingConfig: NormalizedRoutingConfig,
): unknown {
  const frozen = buildNativeRoutingSnapshot({
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
    const settings = readRoutingSettings({ cwd: context.cwd, ...(context.configDir === undefined ? {} : { configDir: context.configDir }) });
    if (context.sessionConfig === undefined) throw new Error("the routing preview requires the frozen session config");
    const preview = previewNativeRoutingCategories({ availability: context.availability, bindings: context.bindings, sessionConfig: context.sessionConfig,
      cwd: context.cwd, ...(context.configDir === undefined ? {} : { configDir: context.configDir }) }, normalizeRoutingConfig(settings.layers, ROUTING_NORMALIZATION));
    const data = { ...(preview as Record<string, unknown>), ...(settings.project.trusted ? {} : { projectUntrusted: true }), ...(settings.notices.length === 0 ? {} : { notices: settings.notices }) };
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
