// The runtime rules and the specification schema must agree.
//
// `config.ts` validates in code rather than by loading
// `docs/requirements/keryx-mcp-servers/schemas/mcp-servers-config.schema.json`
// at runtime, and its comment says the two are kept in step by this file. That
// claim needs a test or it is the same defect the registry work spent today
// removing: a mechanism asserting a property nothing checks.
//
// So a corpus of server entries is run through BOTH — the project's own schema
// validator against the specification file, and `parseConfigFile` — and their
// accept/reject verdicts must match. Where they legitimately differ, the case
// says why rather than being left out of the corpus.

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { uniqueTestRoot } from "../lib/test-tmp";
import { parseConfigFile } from "./config";

const SCHEMA_FILE = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-mcp-servers",
  "schemas",
  "mcp-servers-config.schema.json",
);

/** Entries the two must agree on, and what the agreement is. */
const CORPUS: Array<{ name: string; entry: Record<string, unknown>; valid: boolean }> = [
  { name: "stdio_minimal", entry: { command: "npx" }, valid: true },
  { name: "stdio_full", entry: { command: "npx", args: ["-y", "pkg"], env: { A: "1" }, cwd: "/tmp" }, valid: true },
  { name: "http_minimal", entry: { url: "https://example.test/mcp" }, valid: true },
  { name: "http_headers", entry: { url: "https://x.test", headers: { Authorization: "Bearer ${T}" } }, valid: true },
  { name: "disabled", entry: { command: "x", enabled: false }, valid: true },
  { name: "timeouts", entry: { command: "x", startup_timeout_sec: 5, tool_timeout_sec: 30 }, valid: true },

  { name: "neither", entry: { enabled: true }, valid: false },
  { name: "both", entry: { command: "x", url: "https://x.test" }, valid: false },
  { name: "empty_command", entry: { command: "" }, valid: false },
  { name: "zero_startup", entry: { command: "x", startup_timeout_sec: 0 }, valid: false },
  { name: "negative_tool_timeout", entry: { command: "x", tool_timeout_sec: -1 }, valid: false },

  // Added after the review of PR #522, which ran these nine through both
  // sides and found the schema rejecting every one while the runtime
  // accepted it. The corpus had only ever varied the four fields
  // `entryProblems` happened to check, so the guard against drift could not
  // see the drift that was already there. Two of them crashed the shell.
  { name: "args_not_array", entry: { command: "x", args: "oops" }, valid: false },
  { name: "args_holding_number", entry: { command: "x", args: ["ok", 5] }, valid: false },
  { name: "env_value_number", entry: { command: "x", env: { A: 5 } }, valid: false },
  { name: "enabled_string", entry: { command: "x", enabled: "no" }, valid: false },
  { name: "tool_timeouts_zero", entry: { command: "x", tool_timeouts: { a: 0 } }, valid: false },
  { name: "bad_type_value", entry: { command: "x", type: "bogus" }, valid: false },
];

/**
 * Entry-level cases where the two are MEANT to disagree, with the reason.
 *
 * One so far. The schema sets `additionalProperties: false` on a server
 * entry; the runtime accepts unknown fields and `store.ts` round-trips
 * them. That is deliberate and load-bearing: `oauth` and `tool_timeouts`
 * already ride through untouched, and an older keryx asked to edit a file a
 * newer one wrote must not delete the fields it does not recognise — or
 * refuse the whole server over them. The schema is the authoring contract
 * and is right to be strict; the runtime has to be forgiving.
 */
const ENTRY_DIVERGENCES: Array<{ name: string; entry: Record<string, unknown>; why: string }> = [
  {
    name: "unknown_entry_field",
    entry: { command: "x", bogus: 1 },
    why: "forward compatibility: the runtime keeps fields it does not know so an older keryx cannot silently strip a newer one's config",
  },
];

/**
 * Whole DOCUMENTS, not entries.
 *
 * `codeAccepts`/`schemaAccepts` wrap every case in a fixed
 * `{schemaVersion: 1, servers: {…}}`, so no top-level rule was ever
 * compared — the review found four divergences hiding behind that wrapper.
 */
const DOCUMENT_CORPUS: Array<{ name: string; doc: unknown; valid: boolean; note: string }> = [
  { name: "minimal", doc: { schemaVersion: 1, servers: {} }, valid: true, note: "the shape everything else assumes" },
  // `schemaVersion` was never validated by the runtime at all. The corpus
  // only ever held 1 and missing, so every other value was a divergence
  // nothing could see — including `2`, which means "written by a later
  // keryx" and was being read with v1 semantics in silence.
  { name: "version_2", doc: { schemaVersion: 2, servers: {} }, valid: false, note: "" },
  { name: "version_0", doc: { schemaVersion: 0, servers: {} }, valid: false, note: "" },
  { name: "version_string", doc: { schemaVersion: "1", servers: {} }, valid: false, note: "" },
  { name: "version_float", doc: { schemaVersion: 1.5, servers: {} }, valid: false, note: "" },
  { name: "version_null", doc: { schemaVersion: null, servers: {} }, valid: false, note: "" },
  {
    name: "missing_schemaVersion",
    doc: { servers: {} },
    valid: true,
    note: "DIVERGENCE, deliberate and now recorded: the schema requires `schemaVersion`, the runtime defaults it to 1. Requiring it would reject every hand-written file that omits it, which is the common case; the runtime is right and the schema is stricter than the product wants to be.",
  },
  {
    name: "unknown_top_level_key",
    doc: { schemaVersion: 1, servers: {}, $comment: "keep me" },
    valid: true,
    note: "DIVERGENCE, deliberate: the schema sets additionalProperties:false at the root, but `store.ts` round-trips unknown top-level keys ON PURPOSE so a rewrite does not silently delete a `$schema` pointer or a future field. The schema is the stricter of the two and the runtime is the one that has to survive an older keryx editing a newer file.",
  },
  { name: "servers_not_object", doc: { schemaVersion: 1, servers: [] }, valid: false, note: "" },
  { name: "no_servers_key", doc: { schemaVersion: 1 }, valid: false, note: "" },
];

function schemaAccepts(name: string, entry: Record<string, unknown>): boolean {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
  const doc = { schemaVersion: 1, servers: { [name]: entry } };
  return validateAgainstSchemaObject(schema, doc).errors.length === 0;
}

async function codeAcceptsDocument(doc: unknown): Promise<boolean> {
  const root = uniqueTestRoot(tmpdir(), "keryx-mcp-parity-doc");
  try {
    const file = path.join(root, "c.json");
    await mkdir(root, { recursive: true });
    await writeFile(file, JSON.stringify(doc), "utf8");
    return parseConfigFile(file).problems.length === 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function codeAccepts(name: string, entry: Record<string, unknown>): Promise<boolean> {
  const root = uniqueTestRoot(tmpdir(), "keryx-mcp-parity");
  try {
    const file = path.join(root, "c.json");
    await mkdir(root, { recursive: true });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, servers: { [name]: entry } }), "utf8");
    const parsed = parseConfigFile(file);
    return parsed.servers[name] !== undefined;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("the code rules and the specification schema agree", () => {
  test("the schema file this asserts against exists and parses", () => {
    // Otherwise every comparison below runs against `{}`, which accepts
    // everything, and the whole file passes while checking nothing.
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
    expect(schema.$defs).toBeDefined();
    expect(schema.properties).toBeDefined();
  });

  for (const { name, entry, valid } of CORPUS) {
    test(`${name} is ${valid ? "accepted" : "rejected"} by both`, async () => {
      expect(schemaAccepts(name, entry)).toBe(valid);
      expect(await codeAccepts(name, entry)).toBe(valid);
    });
  }

  for (const { name, doc, valid, note } of DOCUMENT_CORPUS) {
    test(`document ${name}: runtime ${valid ? "accepts" : "rejects"}${note === "" ? "" : " (see note)"}`, async () => {
      expect(await codeAcceptsDocument(doc)).toBe(valid);
    });
  }

  test("every document divergence from the schema is one this file NAMES", () => {
    // The point of the file. Where the two disagree it must be because
    // somebody decided so and wrote down why — not because nobody looked.
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
    for (const { name, doc, valid, note } of DOCUMENT_CORPUS) {
      const bySchema = validateAgainstSchemaObject(schema, doc).errors.length === 0;
      if (bySchema === valid) continue;
      expect({ name, documented: note.startsWith("DIVERGENCE") }).toEqual({ name, documented: true });
    }
  });

  for (const { name, entry, why } of ENTRY_DIVERGENCES) {
    test(`${name}: schema rejects, runtime accepts — ${why}`, async () => {
      // Asserted in BOTH directions, so this stops being a licence: if the
      // schema is later relaxed, or the runtime tightened, the divergence
      // note has to be removed rather than left describing something that
      // is no longer true.
      expect(schemaAccepts(name, entry)).toBe(false);
      expect(await codeAccepts(name, entry)).toBe(true);
    });
  }

  // SERVER NAMES, which the entry corpus structurally could not vary: both
  // `schemaAccepts` and `codeAccepts` use the case LABEL as the name, so
  // every case ran under a name that happened to be valid. The schema
  // states its name rule in `propertyNames`, which the validator did not
  // implement either — two independent blind spots over the same rule, and
  // it had already drifted.
  const NAME_CORPUS: Array<{ name: string; valid: boolean }> = [
    { name: "linear", valid: true },
    { name: "_internal", valid: true },
    { name: "gh-mcp", valid: true },
    { name: "x1", valid: true },
    { name: "1password", valid: false },
    { name: "-dash", valid: false },
    { name: "9", valid: false },
    { name: "a".repeat(41), valid: false },
    { name: "a".repeat(40), valid: true },
    { name: "has space", valid: false },
    { name: "has.dot", valid: false },
  ];

  for (const { name, valid } of NAME_CORPUS) {
    test(`server name "${name.length > 20 ? `${name.slice(0, 12)}…(${name.length})` : name}" is ${valid ? "accepted" : "rejected"} by both`, async () => {
      expect(schemaAccepts(name, { command: "x" })).toBe(valid);
      expect(await codeAccepts(name, { command: "x" })).toBe(valid);
    });
  }

  test("the corpus exercises both verdicts", () => {
    // A corpus that had drifted to all-valid would pass every case above while
    // proving only that nothing is rejected.
    expect(CORPUS.some((c) => c.valid)).toBe(true);
    expect(CORPUS.some((c) => !c.valid)).toBe(true);
  });
});
