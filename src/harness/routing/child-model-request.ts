// Flow 305 (Flow A), AC6/AC7 — turn the `subagents` category's resolved
// `CategoryAssignment` into a `ChildModelRequest`, for a caller to pass to
// `resolveChildModel`/`spawnSubagent` BEFORE the gates run. This module never
// calls `resolveChildModel` itself and never touches its G1/G2/G3 gates —
// those stay exactly as `src/harness/child/model.ts` already has them (AC7):
// this only constructs the REQUEST the gates are then applied to, the same
// way `parseDispatchModel` already does for the declarative dispatch-document
// path.
import type { ChildModelRequest } from "../child/model";
import type { CategoryAssignment } from "./table";
import { resolveProviderDefaultModelId } from "./provider-default";

/**
 * `{kind:"session-default"}` means "inherit the parent verbatim" — the same
 * meaning an omitted/`{kind:"inherit"}` `ChildModelRequest` already has, so
 * this returns `undefined` and the caller passes no `modelRequest` at all
 * (`spawnSubagent`'s existing terminal rung, unmodified).
 *
 * `{kind:"model"}` becomes `{kind:"explicit", providerId, modelId}` directly.
 *
 * `{kind:"provider-default"}` is resolved to a concrete model id first
 * (`resolveProviderDefaultModelId`, PRD §5) and ALSO becomes `{kind:"explicit"}`
 * — there is no `ChildModelRequest` shape for "provider, no model", so the
 * concrete default is resolved here rather than invented downstream. A
 * provider-default that cannot be resolved to any model (an unknown provider,
 * or a provider with no curated models) falls back to `undefined` (inherit) —
 * never a request naming an empty `modelId`.
 *
 * Pure and synchronous.
 */
export function categoryAssignmentToChildModelRequest(assignment: CategoryAssignment): ChildModelRequest | undefined {
  if (assignment.kind === "session-default") return undefined;
  if (assignment.kind === "model") {
    return { kind: "explicit", providerId: assignment.providerId, modelId: assignment.modelId };
  }
  const modelId = resolveProviderDefaultModelId(assignment.providerId);
  if (modelId === undefined) return undefined;
  return { kind: "explicit", providerId: assignment.providerId, modelId };
}
