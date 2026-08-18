import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getProjectPermissionMode,
  loadPermissionModeRegistry,
  permissionModeConfigPath,
  setProjectPermissionMode,
} from "./permission-mode-config";

let configDir = "";
let workspace = "";

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-permission-mode-config-"));
  configDir = path.join(base, "config");
  workspace = path.join(base, "work");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

function project(name: string): string {
  const root = path.join(workspace, name);
  mkdirSync(root, { recursive: true });
  return root;
}

test("no stored default returns undefined", () => {
  const root = project("alpha");
  expect(getProjectPermissionMode(root, configDir)).toBeUndefined();
});

test("set then get round-trips the mode for that project", () => {
  const root = project("alpha");
  expect(setProjectPermissionMode(root, "trust", configDir)).toBe(true);
  expect(getProjectPermissionMode(root, configDir)).toBe("trust");
});

test("two different projects carry independent defaults", () => {
  const alpha = project("alpha");
  const beta = project("beta");
  setProjectPermissionMode(alpha, "trust", configDir);
  setProjectPermissionMode(beta, "auto", configDir);
  expect(getProjectPermissionMode(alpha, configDir)).toBe("trust");
  expect(getProjectPermissionMode(beta, configDir)).toBe("auto");
});

test("setting undefined clears a previously stored default", () => {
  const root = project("alpha");
  setProjectPermissionMode(root, "trust", configDir);
  expect(setProjectPermissionMode(root, undefined, configDir)).toBe(true);
  expect(getProjectPermissionMode(root, configDir)).toBeUndefined();
});

test("re-setting the same project overwrites rather than duplicates", () => {
  const root = project("alpha");
  setProjectPermissionMode(root, "trust", configDir);
  setProjectPermissionMode(root, "auto", configDir);
  const registry = loadPermissionModeRegistry(configDir);
  expect(Object.keys(registry.projects)).toHaveLength(1);
  expect(getProjectPermissionMode(root, configDir)).toBe("auto");
});

test("a symlinked path resolves to the same project identity", () => {
  const root = project("alpha");
  const link = path.join(workspace, "alpha-link");
  symlinkSync(root, link);
  setProjectPermissionMode(root, "trust", configDir);
  expect(getProjectPermissionMode(link, configDir)).toBe("trust");
});

test("an unset project falls back to undefined even when other projects are stored", () => {
  const alpha = project("alpha");
  const beta = project("beta");
  setProjectPermissionMode(alpha, "trust", configDir);
  expect(getProjectPermissionMode(beta, configDir)).toBeUndefined();
});

test("a corrupt file is treated as empty, not thrown", () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(permissionModeConfigPath(configDir), "{ not json", "utf8");
  const root = project("alpha");
  expect(getProjectPermissionMode(root, configDir)).toBeUndefined();
});

test("an unknown mode value on disk is dropped rather than trusted", () => {
  mkdirSync(configDir, { recursive: true });
  const root = project("alpha");
  writeFileSync(
    permissionModeConfigPath(configDir),
    JSON.stringify({ schemaVersion: 1, projects: { [root]: "yolo" } }),
    "utf8",
  );
  const registry = loadPermissionModeRegistry(configDir);
  expect(Object.keys(registry.projects)).toHaveLength(0);
});
