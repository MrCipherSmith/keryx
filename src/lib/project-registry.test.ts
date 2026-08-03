// User-global project registry (flow 127 / roadmap R4a).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
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
  sanitizeForDisplay,
  saveProjectRegistry,
  stripSecretShapedFields,
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

  test("the same project reached through a symlink is one entry, not two", () => {
    // Lexical resolution is not identity: a symlinked path produced a second
    // entry with a second projectId, which is what idempotency was meant to stop.
    const root = makeProject("alpha");
    const link = path.join(workspace, "alpha-link");
    require("node:fs").symlinkSync(root, link);

    const first = registerProject(root, { dir: configDir });
    const second = registerProject(link, { dir: configDir });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.created).toBe(false);
      expect(second.entry.projectId).toBe(first.entry.projectId);
    }
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("refuses a .metaproject that is a file rather than a directory", () => {
    // existsSync accepts a plain file, so a directory with a stray file named
    // .metaproject registered and then reported active forever.
    const fake = path.join(workspace, "fake");
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, ".metaproject"), "not a directory", "utf8");

    const result = registerProject(fake, { dir: configDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-a-project");
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
    // because the data is clean. The first version matched exact names,
    // case-sensitively, at the top level only — so it missed every one of these.
    for (const field of [
      "token",
      "apiKey",
      "accessToken",
      "refreshToken",
      "API_KEY",
      "apikey",
      "privateKey",
      "cookie",
      "bearer",
      "password",
      "sessionKey",
      "jwt",
    ]) {
      expect(hasSecretShapedField({ path: "/x", [field]: "v" })).toBe(true);
    }
    expect(hasSecretShapedField({ path: "/x", nested: { apiKey: "v" } })).toBe(true);
    expect(hasSecretShapedField({ path: "/x", list: [{ token: "v" }] })).toBe(true);
    expect(hasSecretShapedField({ path: "/x", displayName: "monkey" })).toBe(false);
  });

  test("a secret that reached the file by any route is stripped on the next write", () => {
    // Enforcement, not documentation: hand-edited or injected credential-shaped
    // data must not be faithfully re-serialized next to auth.json.
    const root = makeProject("alpha");
    registerProject(root, { dir: configDir });
    const onDisk = JSON.parse(readFileSync(projectRegistryPath(configDir), "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    onDisk.projects[0]!.token = "ghp_NOT_A_REAL_VALUE";
    onDisk.projects[0]!.nested = { apiKey: "also-not-real" };
    writeFileSync(projectRegistryPath(configDir), JSON.stringify(onDisk), "utf8");

    // Any write rewrites the whole file, so re-registering is enough.
    registerProject(root, { dir: configDir });

    const after = readFileSync(projectRegistryPath(configDir), "utf8");
    expect(after).not.toContain("ghp_NOT_A_REAL_VALUE");
    expect(after).not.toContain("also-not-real");
    expect(hasSecretShapedField(JSON.parse(after))).toBe(false);
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

    expect(forgetProject(first.entry.projectId, configDir)).toBe("removed");
    const remaining = loadProjectRegistry(configDir).projects;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(b);
  });

  test("forgetting an unknown id changes nothing and says so distinctly", () => {
    // A boolean conflated this with a failed write, so the operator was told the
    // project was gone while it was still registered.
    registerProject(makeProject("alpha"), { dir: configDir });
    expect(forgetProject("00000000-0000-0000-0000-000000000000", configDir)).toBe("not-found");
    expect(loadProjectRegistry(configDir).projects).toHaveLength(1);
  });

  test("an unknown id against a DAMAGED registry destroys nothing", () => {
    // This is the case the test above was named for and never reached. The
    // quarantine added for a different finding renamed the live registry aside
    // and then returned not-found without writing, so one mistyped id wiped
    // every valid registration.
    registerProject(makeProject("alpha"), { dir: configDir });
    registerProject(makeProject("beta"), { dir: configDir });
    const raw = JSON.parse(readFileSync(projectRegistryPath(configDir), "utf8")) as {
      projects: unknown[];
    };
    raw.projects.push({ projectId: "malformed-no-other-fields" });
    writeFileSync(projectRegistryPath(configDir), JSON.stringify(raw), "utf8");

    expect(forgetProject("definitely-not-an-id", configDir)).toBe("not-found");

    // The file is still there, and both real projects with it.
    expect(existsSync(projectRegistryPath(configDir))).toBe(true);
    expect(loadProjectRegistry(configDir).projects).toHaveLength(2);
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

  test("structurally invalid entries are dropped, with a warning naming the count", () => {
    // A half-valid entry is worse than a missing one: without a projectId it can
    // never be removed by `forget`, so it would be permanent.
    const sound = {
      projectId: "11111111-1111-1111-1111-111111111111",
      path: "/tmp/ok",
      displayName: "ok",
      state: "active",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      projectRegistryPath(configDir),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ projectId: "no-path" }, { path: "/x", displayName: { evil: 1 } }, sound],
      }),
      "utf8",
    );
    const warnings: string[] = [];
    const registry = loadProjectRegistry(configDir, (message) => warnings.push(message));
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]?.path).toBe("/tmp/ok");
    expect(warnings.join(" ")).toContain("2 malformed");
  });

  test("a damaged registry is preserved, not silently overwritten", () => {
    // Rewriting over corruption destroys whatever registrations were there. The
    // operator gets a file to inspect instead of a registry that lost everything.
    writeFileSync(projectRegistryPath(configDir), "{not json", "utf8");
    const warnings: string[] = [];
    const result = registerProject(makeProject("alpha"), {
      dir: configDir,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.ok).toBe(true);
    expect(warnings.join(" ")).toContain("corrupt-");
    const leftovers = require("node:fs")
      .readdirSync(configDir)
      .filter((name: string) => name.includes("corrupt-"));
    expect(leftovers).toHaveLength(1);
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

describe("sanitizeForDisplay", () => {
  // This function had NO tests, which is exactly why a patch script that doubled
  // the backslashes shipped a regex stripping digits and capitals while letting
  // every control character through.
  test("strips control characters", () => {
    expect(sanitizeForDisplay("my[31mproject")).toBe("my[31mproject");
    expect(sanitizeForDisplay("bellhere")).toBe("bellhere");
    expect(sanitizeForDisplay("line\nbreak")).toBe("linebreak");
    expect(sanitizeForDisplay("delchar")).toBe("delchar");
    expect(sanitizeForDisplay("c1char")).toBe("c1char");
  });

  test("leaves ordinary text completely untouched", () => {
    // The broken version turned this into "roject-_".
    expect(sanitizeForDisplay("Project-42_ABC")).toBe("Project-42_ABC");
    expect(sanitizeForDisplay("/home/dev/keryx-9")).toBe("/home/dev/keryx-9");
    expect(sanitizeForDisplay("проект-Ω")).toBe("проект-Ω");
    expect(sanitizeForDisplay("")).toBe("");
  });

  test("a terminal-resetting sequence cannot survive", () => {
    expect(sanitizeForDisplay("c")).toBe("c");
  });
});

describe("credential-shaped field matching", () => {
  test("matches whole words, not substrings", () => {
    // A bare `includes` deleted authoredAt, sortKey, monkeyPatch and
    // credibility — permanently and invisibly, on the next write.
    // sortKey is the case that forced `key` to require a qualifier: it is
    // indistinguishable from apiKey by the word alone.
    for (const safe of ["authoredAt", "sortKey", "monkeyPatch", "credibility", "keyboardLayout", "keyword"]) {
      expect(hasSecretShapedField({ [safe]: "v" })).toBe(false);
    }
    for (const unsafe of ["token", "apiKey", "api_key", "ACCESS_TOKEN", "refreshToken", "cookie"]) {
      expect(hasSecretShapedField({ [unsafe]: "v" })).toBe(true);
    }
  });

  test("a stripped field is named, not dropped in silence", () => {
    const stripped: string[] = [];
    stripSecretShapedFields({ path: "/x", token: "v" }, (field) => stripped.push(field));
    expect(stripped).toEqual(["token"]);
  });
});

describe("concurrent writes", () => {
  test("genuinely parallel registrations lose no entry", () => {
    // The first version of this test wrapped a SYNCHRONOUS call in
    // Promise.resolve, so nothing ran concurrently, and asserted
    // `length > 0` — a tautology that passed while the implementation
    // reproducibly lost entries. Real subprocesses, exact count.
    const roots = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => makeProject(name));
    const script = path.join(__dirname, "project-registry.ts");

    const children = roots.map((root) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const { registerProject } = await import(${JSON.stringify(script)});
           const r = registerProject(${JSON.stringify(root)}, { dir: ${JSON.stringify(configDir)} });
           if (!r.ok) { console.error(r.message); process.exit(1); }`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );

    return Promise.all(children.map((child) => child.exited)).then(() => {
      const registry = loadProjectRegistry(configDir);
      const registered = new Set(registry.projects.map((entry) => entry.path));
      for (const root of roots) {
        expect(registered.has(root)).toBe(true);
      }
      expect(registry.projects).toHaveLength(roots.length);
      expect(() => JSON.parse(readFileSync(projectRegistryPath(configDir), "utf8"))).not.toThrow();
    });
  }, 60_000);

  test("a stale lock does not wedge registration forever", () => {
    // A process killed mid-write leaves the lock behind. Every later
    // registration must not fail because of it.
    writeFileSync(`${projectRegistryPath(configDir)}.lock`, "", "utf8");
    const stale = new Date(Date.now() - 60_000);
    require("node:fs").utimesSync(`${projectRegistryPath(configDir)}.lock`, stale, stale);

    const result = registerProject(makeProject("alpha"), { dir: configDir });
    expect(result.ok).toBe(true);
  }, 30_000);

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

describe("fixes that shipped without a guard", () => {
  // Every one of these was mutation-checked against the FULL suite and reverted
  // green — the escape guard is load-bearing but only for its own class, so
  // three behavioural fixes rode along with no regression protection at all.

  test("cloud service-account key names are credentials", () => {
    for (const field of ["storageAccountKey", "serviceAccountKey", "GCP_SA_KEY", "sa_key"]) {
      expect(hasSecretShapedField({ [field]: "v" })).toBe(true);
    }
    // The qualifiers must not swallow ordinary words containing them. The
    // negative half deliberately includes *Key compounds: probing only non-Key
    // names is why the two-letter "sa" qualifier matching as a SUBSTRING went
    // unnoticed, destroying messageKey and usageKey on every write.
    for (const field of ["accountName", "saved", "accountId", "messageKey", "usageKey", "salesKey", "sampleKey", "databaseKey"]) {
      expect(hasSecretShapedField({ [field]: "v" })).toBe(false);
    }
  });

  test("__proto__ is reported and does not replace the prototype", () => {
    // Assigning `__proto__` invokes the prototype setter rather than creating an
    // own key, so the value vanished with no notice and the cleaned object came
    // back with a replaced prototype.
    const parsed = JSON.parse('{"__proto__":{"polluted":1},"path":"/p","displayName":"d"}') as Record<
      string,
      unknown
    >;
    const stripped: string[] = [];
    const cleaned = stripSecretShapedFields(parsed, (field) => stripped.push(field));

    expect(stripped).toContain("__proto__");
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect((cleaned as Record<string, unknown>).path).toBe("/p");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
