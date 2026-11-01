import schema from "./domain-schema.json";
import commandSchema from "./command-schema.json";
import type { WorkRecord, WorkCommand } from "./types";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validates the bounded draft domain at the adapter boundary, never infers authority. */
function matches(value: unknown, rule: unknown, depth = 0): boolean {
  if (!object(rule) || depth > 24) return false;
  if (typeof rule.$ref === "string") {
    const name = rule.$ref.split("/").at(-1);
    const defs: Record<string, unknown> = schema.$defs;
    return !!name && matches(value, defs[name], depth + 1);
  }
  for (const key of ["oneOf", "anyOf"]) {
    if (Array.isArray(rule[key])) {
      const count = rule[key].filter((part) =>
        matches(value, part, depth + 1),
      ).length;
      return key === "oneOf" ? count === 1 : count > 0;
    }
  }
  if ("const" in rule && value !== rule.const) return false;
  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return false;
  if (rule.type === "null") return value === null;
  if (rule.type === "boolean") return typeof value === "boolean";
  if (rule.type === "integer" || rule.type === "number")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (rule.type !== "integer" || Number.isInteger(value)) &&
      (typeof rule.minimum !== "number" || value >= rule.minimum)
    );
  if (rule.type === "string")
    return (
      typeof value === "string" &&
      (typeof rule.minLength !== "number" || value.length >= rule.minLength) &&
      (typeof rule.maxLength !== "number" || value.length <= rule.maxLength) &&
      (typeof rule.pattern !== "string" || new RegExp(rule.pattern).test(value))
    );
  if (rule.type === "array")
    return (
      Array.isArray(value) &&
      (typeof rule.maxItems !== "number" || value.length <= rule.maxItems) &&
      (typeof rule.minItems !== "number" || value.length >= rule.minItems) &&
      value.every((entry) => matches(entry, rule.items, depth + 1))
    );
  if (rule.type === "object") {
    if (!object(value)) return false;
    const props = object(rule.properties) ? rule.properties : {};
    if (
      Array.isArray(rule.required) &&
      !rule.required.every((key) => typeof key === "string" && key in value)
    )
      return false;
    return Object.entries(value).every(([key, entry]) =>
      key in props
        ? matches(entry, props[key], depth + 1)
        : rule.additionalProperties !== false,
    );
  }
  return true;
}
export function isWorkRecord(value: unknown): value is WorkRecord {
  return matches(value, schema);
}
export function isWorkCommand(value: unknown): value is WorkCommand {
  return matches(value, commandSchema);
}
export { object as isObject };
