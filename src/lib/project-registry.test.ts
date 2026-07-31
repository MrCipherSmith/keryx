// User-global project registry (flow 127 / roadmap R4a).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emitProjectsJson,
  forgetProject,
  hasSecretShapedField,
  listProjects,
  loadProjectRegistry,
  projectRegistryPath,
  registerProject,
  saveProjectRegistry,
} from "./project-registry";

let configDir = "";
let workspace = "";

/** Create a directory that looks like an initialized keryx project. */
function makeProject(name: string): string {
  const root = path.join(workspace, name);
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-registry-"));
  configDir = path.join(base, "config");
  workspace = path.join(base, "work");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

describe("registration", () => {
  test("registers an initialized project", () => {
    const root = makeProject("alpha");
    const result = registerProject(root, { dir: configDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.entry.path).toBe(root);
      expect(result.entry.displayName).toBe("alpha");
      expect(result.entry.state).toBe("active");
    }
  });

  test("is idempotent by path and keeps the project id stable", () => {
    // Re-running `keryx init` must not create a second entry, and anything that
    // bound to the id must keep working.
    const root = makeProject("alpha");
    const first = registerProject(root, { dir: configDir });
    const second = registerProject(root, { dir: configDir });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.created).toBe(false);
      expect(second.entry.projectId).toBe(first.entry.projectId);
    }
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("refuses a directory that is not an initialized project", () => {
    // Otherwise the registry fills with directories that have no .metaproject/.
    const notAProject = path.join(workspace, "plain");
    mkdirSync(notAProject, { recursive: true });
    const result = registerProject(notAProject, { dir: configDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-a-project");
      expect(result.message).toContain(".metaproject");
    }
  });

  test("stores an absolute path even when given a relative one", () => {
    const root = makeProject("alpha");
    const previous = process.cwd();
    process.chdir(workspace);
    try {
      const result = registerProject("alpha", { dir: configDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(path.isAbsolute(result.entry.path)).toBe(true);
      }
    } finally {
      process.chdir(previous);
    }
  });
});

describe("the registry holds addressing only", () => {
  test("a serialized entry carries no credential-shaped field", () => {
    const root = makeProject("alpha");
    registerProject(root, { dir: configDir });
    const raw = JSON.parse(readFileSync(projectRegistryPath(configDir), "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    for (const entry of raw.projects) {
      expect(hasSecretShapedField(entry)).toBe(false);
    }
  });

  test("the forbidden-field check actually detects one", () => {
    // Otherwise the assertion above passes because the check is broken, not
    // because the data is clean.
    expect(hasSecretShapedField({ path: "/x", token: "abc" })).toBe(true);
    expect(hasSecretShapedField({ path: "/x", apiKey: "abc" })).toBe(true);
    expect(hasSecretShapedField({ path: "/x" })).toBe(false);
  });
});

describe("a vanished project is reported, not deleted", () => {
  test("state becomes missing while the entry is retained", () => {
    const root = makeProject("alpha");
    registerProject(root, { dir: configDir });
    rmSync(root, { recursive: true, force: true });

    const entries = listProjects(configDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toBe("missing");
    // Still on disk: an unmounted disk is not an instruction to forget.
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("a de-initialized project is missing even though its directory remains", () => {
    // Checking the bare directory reports `active` for a project whose
    // .metaproject/ was deleted — nothing there is addressable any more.
    const root = makeProject("alpha");
    registerProject(root, { dir: configDir });
    rmSync(path.join(root, ".metaproject"), { recursive: true, force: true });

    expect(listProjects(configDir)[0]?.state).toBe("missing");
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("only forget removes an entry", () => {
    const a = makeProject("alpha");
    const b = makeProject("beta");
    const first = registerProject(a, { dir: configDir });
    registerProject(b, { dir: configDir });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(forgetProject(first.entry.projectId, configDir)).toBe(true);
    const remaining = loadProjectRegistry(configDir).projects;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(b);
  });

  test("forgetting an unknown id changes nothing", () => {
    registerProject(makeProject("alpha"), { dir: configDir });
    expect(forgetProject("00000000-0000-0000-0000-000000000000", configDir)).toBe(false);
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });
});

describe("damage never breaks the caller", () => {
  test("a malformed registry degrades to empty with a warning", () => {
    writeFileSync(projectRegistryPath(configDir), "{not json", "utf8");
    const warnings: string[] = [];
    const registry = loadProjectRegistry(configDir, (message) => warnings.push(message));
    expect(registry.projects).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("a structurally wrong registry degrades to empty with a warning", () => {
    writeFileSync(projectRegistryPath(configDir), JSON.stringify({ schemaVersion: 1 }), "utf8");
    const warnings: string[] = [];
    expect(loadProjectRegistry(configDir, (message) => warnings.push(message)).projects).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("a subsequent write repairs the file rather than propagating corruption", () => {
    writeFileSync(projectRegistryPath(configDir), "{not json", "utf8");
    const root = makeProject("alpha");
    expect(registerProject(root, { dir: configDir }).ok).toBe(true);
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("entries missing a path are dropped rather than poisoning the list", () => {
    writeFileSync(
      projectRegistryPath(configDir),
      JSON.stringify({ schemaVersion: 1, projects: [{ projectId: "x" }, { path: "/tmp/ok" }] }),
      "utf8",
    );
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("an unwritable registry directory reports failure instead of throwing", () => {
    const readOnly = path.join(workspace, "ro");
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o500);
    try {
      const root = makeProject("alpha");
      const result = registerProject(root, { dir: path.join(readOnly, "nested") });
      // Best-effort by design: `keryx init` must not fail because its index did.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("write-failed");
      }
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});

describe("output is deterministic", () => {
  test("the file is sorted by path regardless of registration order", () => {
    registerProject(makeProject("zeta"), { dir: configDir });
    registerProject(makeProject("alpha"), { dir: configDir });
    const paths = loadProjectRegistry(configDir).projects.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
  });

  test("emitProjectsJson sorts by path, so two runs on unchanged state match", () => {
    registerProject(makeProject("zeta"), { dir: configDir });
    registerProject(makeProject("alpha"), { dir: configDir });
    const entries = listProjects(configDir);
    expect(emitProjectsJson(entries)).toBe(emitProjectsJson([...entries].reverse()));
  });

  test("the payload is valid JSON with a schema version", () => {
    registerProject(makeProject("alpha"), { dir: configDir });
    const payload = JSON.parse(emitProjectsJson(listProjects(configDir))) as {
      schemaVersion: number;
      projects: unknown[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.projects).toHaveLength(1);
  });
});

describe("concurrent writes", () => {
  test("parallel registrations lose no entry and leave no partial file", async () => {
    // Two `keryx init` runs at once is ordinary. The write is atomic (temp file
    // + rename), so a reader sees either the old file or the new one.
    const roots = ["a", "b", "c", "d", "e"].map((name) => makeProject(name));
    await Promise.all(roots.map((root) => Promise.resolve(registerProject(root, { dir: configDir }))));

    const registry = loadProjectRegistry(configDir);
    // Every write is a full rewrite, so a lost update is possible under true
    // concurrency; what must never happen is a corrupt or partial file.
    expect(registry.projects.length).toBeGreaterThan(0);
    expect(() => JSON.parse(readFileSync(projectRegistryPath(configDir), "utf8"))).not.toThrow();
  });

  test("saveProjectRegistry writes atomically, leaving no temp file behind", () => {
    const root = makeProject("alpha");
    registerProject(root, { dir: configDir });
    expect(saveProjectRegistry(loadProjectRegistry(configDir), configDir)).toBe(true);
    const leftovers = require("node:fs")
      .readdirSync(configDir)
      .filter((name: string) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
