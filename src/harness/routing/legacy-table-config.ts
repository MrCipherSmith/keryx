// The legacy category table earlier releases persisted: a bare category map
// under `auth.json.routing` (user) and `routing.config.json.categories`
// (project), each entry a `CategoryAssignment`. Nothing writes this shape any
// more; `legacy-migration.ts` is its only reader, converting it into the
// canonical routing layer. Pure: no file access here.
import { createHash } from "node:crypto";
import { isRoutingCategory, ROUTING_CATEGORIES, type CategoryAssignment, type RoutingTable } from "./table";

const ASSIGNMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "session-default": ["kind"],
  model: ["kind", "providerId", "modelId"],
  "provider-default": ["kind", "providerId"],
};

function validateAssignment(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
  const kind = (value as { kind?: unknown }).kind;
  // An assignment carries only the fields its kind defines: an extra key is
  // refused rather than carried along unvalidated for some later reader.
  const allowed = typeof kind === "string" ? ASSIGNMENT_KEYS[kind] : undefined;
  if (allowed !== undefined) {
    const extra = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extra.length > 0) return `unexpected field${extra.length > 1 ? "s" : ""} ${extra.map((key) => JSON.stringify(key)).join(", ")} for kind ${JSON.stringify(kind)}`;
  }
  if (kind === "session-default") return undefined;
  if (kind === "model") {
    const providerId = (value as { providerId?: unknown }).providerId;
    const modelId = (value as { modelId?: unknown }).modelId;
    if (typeof providerId !== "string" || providerId.length === 0) return "model.providerId must be a non-empty string";
    if (typeof modelId !== "string" || modelId.length === 0) return "model.modelId must be a non-empty string";
    return undefined;
  }
  if (kind === "provider-default") {
    const providerId = (value as { providerId?: unknown }).providerId;
    if (typeof providerId !== "string" || providerId.length === 0) return "provider-default.providerId must be a non-empty string";
    return undefined;
  }
  return `unknown kind ${JSON.stringify(kind)}`;
}

/**
 * Validate a bare legacy category map. Every unknown category and malformed
 * assignment is reported; the caller decides whether a partial table may be
 * used (migration never does: a legacy entry it cannot read is surfaced).
 */
export function validateLegacyRoutingTable(raw: unknown): { table: RoutingTable; errors: string[] } {
  const table: RoutingTable = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { table, errors: ["legacy routing categories must be an object"] };
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRoutingCategory(key)) {
      errors.push(`unknown category "${key}" (expected one of ${ROUTING_CATEGORIES.join(", ")})`);
      continue;
    }
    const assignmentError = validateAssignment(value);
    if (assignmentError !== undefined) {
      errors.push(`categories.${key}: ${assignmentError}`);
      continue;
    }
    table[key] = value as CategoryAssignment;
  }
  return { table, errors };
}

/**
 * The fingerprint earlier releases recorded in `routing-config-trust.json`
 * when the operator approved a project's legacy table: the validated table,
 * key-order independent. Recomputed only to recognize an existing approval.
 */
export function legacyRoutingTableFingerprint(table: RoutingTable): string {
  const categories = Object.keys(table).sort();
  const material = JSON.stringify(categories.map((category) => [
    category,
    Object.entries(table[category as keyof RoutingTable]!).sort(([a], [b]) => a.localeCompare(b)),
  ]));
  return createHash("sha256").update(material).digest("hex");
}
