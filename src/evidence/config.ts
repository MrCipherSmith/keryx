import path from "node:path";
export const evidenceDefaults = {
  schemaVersion: 1 as const, enabled: false, automatic: false, mode: "lexical" as "lexical" | "hybrid",
  roots: [] as string[], sessionArchives: false, maxSourceBytes: 8 * 1024 * 1024,
  maxIndexBytes: 256 * 1024 * 1024, maxChunks: 100000, maxResults: 10, maxTokens: 2000, timeoutMs: 1000,
};
export type EvidenceConfig = typeof evidenceDefaults;
export function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    !value.includes("\\") && !path.isAbsolute(value) && !/^[a-zA-Z]:/.test(value) &&
    !value.split("/").some(part => part === ".." || part === "");
}
export function parseEvidenceConfig(input: unknown): { ok: true; config: EvidenceConfig } | { ok: false; diagnostics: string[] } {
  const invalid = { ok: false as const, diagnostics: ["invalid-config"] };
  if (input === undefined) return { ok: true, config: { ...evidenceDefaults, roots: [] } };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid;
  const data = input as Record<string, unknown>;
  if (data.schemaVersion !== 1 || Object.keys(data).some(k => !Object.hasOwn(evidenceDefaults, k) || data[k] === undefined)) return invalid;
  for (const key of ["enabled", "automatic", "sessionArchives"]) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") return invalid;
  }
  if (data.mode !== undefined && data.mode !== "lexical" && data.mode !== "hybrid") return invalid;
  if (data.roots !== undefined && (!Array.isArray(data.roots) || data.roots.length > 32 ||
      !data.roots.every(safeRelativePath) || new Set(data.roots).size !== data.roots.length)) return invalid;
  for (const key of ["maxSourceBytes", "maxIndexBytes", "maxChunks", "maxResults", "maxTokens", "timeoutMs"] as const) {
    const value = data[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > evidenceDefaults[key])) return invalid;
  }
  if (data.automatic === true && data.enabled !== true) return invalid;
  return { ok: true, config: { ...evidenceDefaults, ...data, roots: [...((data.roots as string[] | undefined) ?? [])] } as EvidenceConfig };
}
