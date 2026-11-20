import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultWorktreeConfig, loadWorktreeConfig, parseWorktreeConfig, WorktreeConfigError } from "./config";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-wtconfig-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (cause) {
    return cause instanceof WorktreeConfigError ? cause.field : `other:${String(cause)}`;
  }
  return undefined;
}

describe("defaultWorktreeConfig", () => {
  test("picks env files, skipping example/sample/template, and the install command by lockfile", async () => {
    const root = tempRoot();
    for (const name of [".env", ".env.local", ".env.example", ".env.sample", ".env.template", "package.json", "pnpm-lock.yaml"]) {
      writeFileSync(path.join(root, name), "");
    }
    const config = await defaultWorktreeConfig(root);
    expect(config.envFiles).toEqual([".env", ".env.local"]);
    expect(config.dependencies).toEqual([{ dir: "node_modules", lockfiles: ["pnpm-lock.yaml"], install: "pnpm install --frozen-lockfile" }]);
    expect(config.ports).toEqual({});
    expect(config.prepare.rebuildIndexes).toEqual(["memory"]);
  });

  test("no dependencies without package.json; bun beats other lockfiles", async () => {
    const root = tempRoot();
    expect((await defaultWorktreeConfig(root)).dependencies).toEqual([]);
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "bun.lock"), "");
    writeFileSync(path.join(root, "yarn.lock"), "");
    expect((await defaultWorktreeConfig(root)).dependencies[0]?.install).toBe("bun install --frozen-lockfile");
  });
});

describe("loadWorktreeConfig", () => {
  test("falls back to defaults when the file is absent", async () => {
    const root = tempRoot();
    expect((await loadWorktreeConfig(root)).version).toBe(1);
  });

  test("reads a valid file, keeping baseline fields", async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, ".metaproject"));
    writeFileSync(
      path.join(root, ".metaproject", "worktree.config.json"),
      JSON.stringify({
        version: 1,
        envFiles: [".env"],
        dependencies: [{ dir: "node_modules", lockfiles: ["bun.lock"], install: "bun install" }],
        ports: { web: { env: "PORT", range: [5200, 5299] } },
        prepare: { rebuildIndexes: ["memory", "wiki"] },
        baseline: { enabled: false, timeoutSeconds: 60, commands: ["bun test"] },
      }),
    );
    const config = await loadWorktreeConfig(root);
    expect(config.ports.web).toEqual({ env: "PORT", range: [5200, 5299] });
    expect(config.baseline).toEqual({ enabled: false, timeoutSeconds: 60, commands: ["bun test"] });
    expect(config.prepare.rebuildIndexes).toEqual(["memory", "wiki"]);
  });

  test("an unparsable file is an error naming the root", async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, ".metaproject"));
    writeFileSync(path.join(root, ".metaproject", "worktree.config.json"), "{");
    await expect(loadWorktreeConfig(root)).rejects.toBeInstanceOf(WorktreeConfigError);
  });
});

describe("parseWorktreeConfig validation (AC11)", () => {
  test("rejects a port range whose lower bound exceeds the upper, naming the field", () => {
    const field = fieldOf(() => parseWorktreeConfig({ version: 1, ports: { web: { env: "PORT", range: [5300, 5200] } } }));
    expect(field).toBe("ports.web.range");
  });

  test("rejects '..' and absolute paths in every path-like field", () => {
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: [".env", "../.env"] }))).toBe("envFiles[1]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: ["/etc/passwd"] }))).toBe("envFiles[0]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, dependencies: [{ dir: "a/../b" }] }))).toBe("dependencies[0].dir");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, dependencies: [{ dir: "node_modules", lockfiles: ["ok", "/abs.lock"] }] }))).toBe(
      "dependencies[0].lockfiles[1]",
    );
  });

  test("rejects '.', empty, .git-rooted and '..'-segment paths but allows '..' inside a name", () => {
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: ["."] }))).toBe("envFiles[0]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: ["./"] }))).toBe("envFiles[0]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: [""] }))).toBe("envFiles[0]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: [".git/config"] }))).toBe("envFiles[0]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: ["./.git/hooks/x"] }))).toBe("envFiles[0]");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, dependencies: [{ dir: ".git" }] }))).toBe("dependencies[0].dir");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, envFiles: ["a/.."] }))).toBe("envFiles[0]");
    expect(parseWorktreeConfig({ version: 1, envFiles: ["a..b.env", "sub/.gitignored.env"] }).envFiles).toEqual(["a..b.env", "sub/.gitignored.env"]);
  });

  test("rejects two ports sharing one environment variable", () => {
    const ports = { web: { env: "PORT", range: [5200, 5201] }, api: { env: "PORT", range: [5300, 5301] } };
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, ports }))).toBe("ports.api.env");
  });

  test("rejects a wrong version and unknown fields", () => {
    expect(fieldOf(() => parseWorktreeConfig({ version: 2 }))).toBe("version");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, extra: true }))).toBe("extra");
  });

  test("rejects bad port names, env names and bounds", () => {
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, ports: { Web: { env: "PORT", range: [5200, 5201] } } }))).toBe("ports.Web");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, ports: { web: { env: "port", range: [5200, 5201] } } }))).toBe("ports.web.env");
    expect(fieldOf(() => parseWorktreeConfig({ version: 1, ports: { web: { env: "PORT", range: [80, 90] } } }))).toBe("ports.web.range");
  });
});
