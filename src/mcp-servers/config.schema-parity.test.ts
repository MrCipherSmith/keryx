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
];

function schemaAccepts(name: string, entry: Record<string, unknown>): boolean {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
  const doc = { schemaVersion: 1, servers: { [name]: entry } };
  return validateAgainstSchemaObject(schema, doc).errors.length === 0;
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

  test("the corpus exercises both verdicts", () => {
    // A corpus that had drifted to all-valid would pass every case above while
    // proving only that nothing is rejected.
    expect(CORPUS.some((c) => c.valid)).toBe(true);
    expect(CORPUS.some((c) => !c.valid)).toBe(true);
  });
});
