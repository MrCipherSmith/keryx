import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { flowStateSchema } from "./schema";

const FLOWS_DIR = ".metaproject/flows";
const DOCPACK_SCHEMA = "docs/requirements/keryx-metaproject-native/schemas/flow-state.schema.json";

function onDiskFlowFiles(): string[] {
  if (!existsSync(FLOWS_DIR)) {
    return [];
  }
  return readdirSync(FLOWS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(FLOWS_DIR, entry.name, "flow.json"))
    .filter((path) => existsSync(path));
}

test("flowStateSchema validates EVERY on-disk flow.json (v1 and v2), zero failures", () => {
  const schema = flowStateSchema();
  const files = onDiskFlowFiles();
  expect(files.length).toBeGreaterThan(0);

  const failures: string[] = [];
  for (const file of files) {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = validateAgainstSchemaObject(schema, data);
    if (!result.valid) {
      failures.push(`${file}: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
    }
  }
  expect(failures).toEqual([]);
});

// This used to assert that the on-disk corpus still CONTAINED a v1 record, which
// made the property depend on repository data rather than on the schema. Flow
// 002 was the last v1 flow, and re-sealing its stale checksum migrated it to v2
// through the ordinary write path — so the assertion failed on a legitimate
// write that changed nothing about what the schema accepts.
//
// The property worth guarding is that the schema accepts BOTH shapes. Fixtures
// state it directly, and cannot be invalidated by the next flow anyone touches.
// The corpus is still covered, by the test above: every on-disk flow validates.
test("flowStateSchema accepts both the v1 and the v2 record shape", () => {
  const schema = flowStateSchema();

  // v1, as flow 002 was written in 2026-07: no per-task `dependsOn`/`attempts`,
  // no `merged`, tasks carrying only id/title/kind/status.
  const v1 = {
    schemaVersion: 1,
    id: "002",
    slug: "gdgraph-java-python-import-resolution",
    title: "gdgraph Java/Python import resolution",
    status: "done",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T17:01:50.445Z",
    source: { type: "description", ref: null },
    acChecksum: "sha256:" + "a".repeat(64),
    acConfirmed: { AC1: { at: "2026-07-10T17:01:50.321Z", note: "evidence" } },
    pr: {},
    tasks: [{ id: "T1", title: "Collect remaining context", kind: "context", status: "done" }],
    history: [],
  };

  const v2 = {
    schemaVersion: 2,
    id: "223",
    slug: "docs-remediation",
    title: "Documentation remediation",
    status: "done",
    createdAt: "2026-09-03T19:00:16.505Z",
    updatedAt: "2026-09-03T21:00:00.000Z",
    source: { type: "description", ref: null },
    acChecksum: "sha256:" + "b".repeat(64),
    acConfirmed: {},
    pr: {},
    tasks: [
      {
        id: "T1",
        title: "Collect remaining context",
        kind: "context",
        status: "done",
        dependsOn: [],
        attempts: { count: 0, log: [] },
      },
    ],
    history: [],
  };

  expect(validateAgainstSchemaObject(schema, v1).valid).toBe(true);
  expect(validateAgainstSchemaObject(schema, v2).valid).toBe(true);
});

test("flowStateSchema rejects a flow.json missing a required field", () => {
  const schema = flowStateSchema();
  const missingId = {
    schemaVersion: 2,
    slug: "x",
    title: "t",
    status: "ready",
    createdAt: "n",
    updatedAt: "n",
    tasks: [],
  };
  expect(validateAgainstSchemaObject(schema, missingId).valid).toBe(false);
});

test("flowStateSchema rejects a task missing a v1 core field", () => {
  const schema = flowStateSchema();
  const badTask = {
    schemaVersion: 2,
    id: "099",
    slug: "x",
    title: "t",
    status: "ready",
    createdAt: "n",
    updatedAt: "n",
    tasks: [{ id: "T1", title: "t", status: "todo" }], // missing kind
  };
  expect(validateAgainstSchemaObject(schema, badTask).valid).toBe(false);
});

test("runtime flowStateSchema() is consistent with the committed docpack schema", () => {
  const docpack = JSON.parse(readFileSync(DOCPACK_SCHEMA, "utf8")) as Record<string, unknown>;
  expect(flowStateSchema()).toEqual(docpack);
});
