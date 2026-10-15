import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../contracts/validator";
import path from "node:path";

const schemaDir = path.resolve(import.meta.dir, "../../docs/requirements/keryx-evidence-retrieval/schemas");
const configModule = "./config";
async function parse(input: unknown) {
  const { parseEvidenceConfig } = await import(configModule);
  return parseEvidenceConfig(input);
}

describe("ERL configuration contracts (AC1/AC6/AC8)", () => {
  test("absent config applies all finite disabled defaults", async () => {
    expect(await parse(undefined)).toEqual({ ok: true, config: {
      schemaVersion: 1, enabled: false, automatic: false, mode: "lexical",
      roots: [], sessionArchives: false, maxSourceBytes: 8 * 1024 * 1024,
      maxIndexBytes: 256 * 1024 * 1024, maxChunks: 100000,
      maxResults: 10, maxTokens: 2000, timeoutMs: 1000,
    } });
  });
  test("enabling ERL does not enable archives or automatic recall", async () => {
    const result = await parse({ schemaVersion: 1, enabled: true });
    expect(result.ok).toBe(true);
    expect(result.config.automatic).toBe(false);
    expect(result.config.sessionArchives).toBe(false);
    expect(result.config.roots).toEqual([]);
  });
  for (const input of [null, [], {}, { schemaVersion: 2 },
    { schemaVersion: 1, automatic: true },
    { schemaVersion: 1, credentials: "not-authority" },
    { schemaVersion: 1, roots: ["/tmp"] },
    { schemaVersion: 1, roots: ["../outside"] },
    { schemaVersion: 1, roots: ["docs", "docs"] },
    { schemaVersion: 1, maxResults: 11 },
    { schemaVersion: 1, timeoutMs: 0 },
    { schemaVersion: 1, maxTokens: Number.POSITIVE_INFINITY }]) {
    test(`rejects invalid config ${JSON.stringify(input)}`, async () => {
      expect((await parse(input)).ok).toBe(false);
    });
  }
  test("repository validator enforces conditional and closed config shape", () => {
    const validate = (input: unknown) => validateAgainstSchema("config.schema.json", input, { schemaDir });
    expect(validate({ schemaVersion: 1 }).valid).toBe(true);
    expect(validate({ schemaVersion: 1, automatic: true }).valid).toBe(false);
    expect(validate({ schemaVersion: 1, enabled: true, automatic: true }).valid).toBe(true);
    expect(validate({ schemaVersion: 1, remoteConsent: true }).valid).toBe(false);
  });
});

const hash = "a".repeat(64);
const locator = { kind: "file", startByte: 0, endByte: 8, startLine: 1, endLine: 1 };
const item = { sourceId: "s", sourcePath: "docs/note.txt", versionHash: hash, chunkId: hash,
  contentHash: hash, locator, text: "evidence", role: null, timestamp: null,
  trustedAsPolicy: false, redaction: "not-needed", score: 1 };
const result = { schemaVersion: 1, code: "ok", coverage: "full", generation: "g1", items: [item], diagnostics: [] };
const projection = { schemaVersion: 1, requestHash: hash, providerAdapter: "fixture-v1",
  spans: [{ sourceId: "s", versionHash: hash, contentHash: hash, locator, coverage: "exact" }] };
const valid = (name: string, data: unknown) => validateAgainstSchema(name, data, { schemaDir }).valid;
describe("ERL metaschema, refs and result contracts", () => {
  test("all Draft2020 schemas pass full metaschema and compile sibling refs", async () => {
    const { default: Ajv } = await import("ajv/dist/2020");
    const { readFileSync } = await import("node:fs");
    const ajv = new Ajv({ strict: false });
    for (const name of ["config.schema.json", "search-result.schema.json", "visible-projection.schema.json"]) {
      const schema = JSON.parse(readFileSync(path.join(schemaDir, name), "utf8"));
      expect(ajv.validateSchema(schema)).toBe(true); ajv.addSchema(schema, name);
    }
    expect(ajv.getSchema("search-result.schema.json")!(result)).toBe(true);
    expect(ajv.getSchema("visible-projection.schema.json")!(projection)).toBe(true);
  });
  test("repository validator resolves internal and sibling refs", () => {
    expect(valid("search-result.schema.json", result)).toBe(true);
    expect(valid("visible-projection.schema.json", projection)).toBe(true);
    for (const bad of [{ kind: "file", startByte: 0, endByte: 8 }, { kind: "archive", startByte: 0, endByte: 8 }]) expect(valid("visible-projection.schema.json", { ...projection, spans: [{ ...projection.spans[0], locator: bad }] })).toBe(false);
    expect(valid("search-result.schema.json", { ...result, items: [{ ...item, locator: { kind: "archive", startByte: 0, endByte: 8, recordId: "1:hash" } }] })).toBe(true);
  });
  test("codes, coverage and generation enforce empty/refusal distinctions", () => {
    expect(valid("search-result.schema.json", { ...result, items: [] })).toBe(false);
    expect(valid("search-result.schema.json", { ...result, generation: null })).toBe(false);
    for (const code of ["no-match", "disabled", "index-absent", "timeout", "budget-exceeded", "source-unavailable"]) {
      const available = code === "no-match";
      const payload = { ...result, code, items: [], coverage: available ? "partial" : "unknown", generation: available ? "g1" : null };
      expect(valid("search-result.schema.json", payload)).toBe(true);
      expect(valid("search-result.schema.json", { ...payload, items: [item] })).toBe(false);
      expect(valid("search-result.schema.json", { ...payload, coverage: available ? "unknown" : "full" })).toBe(false);
    }
  });
  test("diagnostics are finite bounded codes; item shapes are closed", async () => {
    const { readFileSync } = await import("node:fs");
    const schema = JSON.parse(readFileSync(path.join(schemaDir, "search-result.schema.json"), "utf8"));
    for (const reason of schema.properties.diagnostics.items.enum) expect(valid("search-result.schema.json", { ...result, diagnostics: [reason] })).toBe(true);
    for (const diagnostics of [["private query"], Array(65).fill("source-denied")]) expect(valid("search-result.schema.json", { ...result, diagnostics })).toBe(false);
    for (const bad of [{ ...item, trustedAsPolicy: true }, { ...item, versionHash: "short" }, { ...item, score: Infinity }, { ...item, raw: "opaque" }]) expect(valid("search-result.schema.json", { ...result, items: [bad] })).toBe(false);
    expect(valid("search-result.schema.json", { ...result, items: Array(11).fill(item) })).toBe(false);
  });
});
