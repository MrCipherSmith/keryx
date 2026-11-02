import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDatabaseMarkerNamespace, DATABASE_MARKERS } from "./storage";
import { openHubStore } from "../store";

test("additive migration preserves the exact legacy aggregate and rejects unsupported future schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-migration-red-"));
  try {
    const before = openHubStore(dir); const state = before.load();
    state.sessions.legacy = { principal: { id: "human:operator", kind: "human", role: "operator" }, expiresAt: 9999999999999 };
    before.save(state); before.close();
    const migrated = openHubStore(dir); expect(migrated.load()).toEqual(state); migrated.close();
    const db = new Database(join(dir, "hub.sqlite"));
    expect(db.query("SELECT version FROM remote_schema_version").get()).toEqual({ version: 2 });
    db.exec("UPDATE remote_schema_version SET version=999"); db.close();
    expect(() => openHubStore(dir)).toThrow("Unsupported remote schema");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema and feature writer barriers reserve distinct marker values', () => {
  expect(() => assertDatabaseMarkerNamespace()).not.toThrow();
  expect(() => assertDatabaseMarkerNamespace({...DATABASE_MARKERS,remoteSchema:DATABASE_MARKERS.managedWorkWriter})).toThrow('reserved value');
});
