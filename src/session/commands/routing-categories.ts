// `/routing` category assignments (the routing inspector's Categories tab, `keryx routing list`): every category resolved through the
// shared routing table layers (project file under trust, user layer, the session's derived default), against what THIS native session
// can reach: its locally connected routing candidates, never a provider catalog probe. No terminal rendering is involved.
import { loadRoutingConfig } from "../../harness/routing/config";
import { deriveDefaultTable } from "../../harness/routing/derive-default-table";
import { availablePredicateFromProfiles, loadModelProfiles } from "../../harness/routing/model-profile";
import { connectedPredicateFrom, describeCategoryResolution, describeRejectionNotice, resolveCategoryDetailed, ROUTING_CATEGORIES, sessionDerivationModels, type FlatPickerProvider, type RoutingTable, type SessionModelRef } from "../../harness/routing/table";
import { readTaskCostStore, taskCostLookupFrom } from "../../harness/routing/task-cost";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import type { NativeModelBinding } from "../model-identity";
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

export async function executeRoutingCategories(context: { cwd: string; configDir?: string; availability: Control["RoutingAvailability"]; bindings: readonly NativeModelBinding[]; baselineCandidateId: string }, input: unknown): Promise<RoutingCategoriesResult> {
  if (!validateArguments(empty, input).ok) return { ok: false, error: { code: "invalid-arguments", message: "The routing categories read takes no arguments." } };
  try {
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
      availability: context.runtime.routing(context.record.config).availability(), bindings: context.runtime.modelBindings(), baselineCandidateId: context.record.config.baselineCandidateId }, request.arguments),
  }];
}
