import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueTestRoot } from "../lib/test-tmp";
import { expandVars, loadMcpServers, parseConfigFile, projectConfigFiles } from "./config";

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function server(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: "echo", args: ["hi"], ...over };
}

describe("AC1 — project beats user, per name", () => {
  test("a name defined in both resolves to the project entry only", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      const project = path.join(root, "work");
      await writeJson(path.join(configDir, "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: server({ command: "user-github" }), only_user: server() },
      });
      await writeJson(path.join(project, ".keryx", "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: server({ command: "project-github" }) },
      });

      const { servers, problems } = loadMcpServers({ cwd: project, gitRoot: project, configDir, env: {} });

      expect(problems).toEqual([]);
      const github = servers.find((s) => s.name === "github");
      expect(github?.command).toBe("project-github");
      expect(github?.source).toBe("project");
      // The user-only server survives: this is a per-name replace, not a
      // whole-layer replace.
      expect(servers.map((s) => s.name)).toEqual(["github", "only_user"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replace, not field-merge: the project entry does not inherit the user's args", async () => {
    // A field merge would produce a server nobody wrote — a command from one
    // file and args from another — which is the shape that cannot be debugged
    // from either file.
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      const project = path.join(root, "work");
      await writeJson(path.join(configDir, "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: { command: "user", args: ["--user-only"], env: { A: "1" } } },
      });
      await writeJson(path.join(project, ".keryx", "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: { command: "project" } },
      });

      const { servers } = loadMcpServers({ cwd: project, gitRoot: project, configDir, env: {} });
      const github = servers.find((s) => s.name === "github");

      expect(github?.args).toBeUndefined();
      expect(github?.env).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the project walk reaches a file two directories above cwd, deepest winning", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      const gitRoot = path.join(root, "repo");
      const deep = path.join(gitRoot, "packages", "web");
      await writeJson(path.join(gitRoot, ".keryx", "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { shared: server({ command: "at-root" }), root_only: server() },
      });
      await writeJson(path.join(deep, ".keryx", "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { shared: server({ command: "at-leaf" }) },
      });

      const { servers } = loadMcpServers({ cwd: deep, gitRoot, configDir, env: {} });

      expect(servers.find((s) => s.name === "shared")?.command).toBe("at-leaf");
      // And the intermediate level is genuinely walked, not skipped over.
      expect(servers.find((s) => s.name === "root_only")).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the walk stops at the git root and does not read above it", () => {
    const files = projectConfigFiles("/repo/a/b", "/repo");
    expect(files).toEqual([
      path.join("/repo", ".keryx", "mcp-servers.json"),
      path.join("/repo/a", ".keryx", "mcp-servers.json"),
      path.join("/repo/a/b", ".keryx", "mcp-servers.json"),
    ]);
  });
});

describe("the personal overlay decides in both directions", () => {
  test("it can disable a server the file enabled", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      await writeJson(path.join(configDir, "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: server() },
      });
      await writeJson(path.join(configDir, "mcp-servers-disabled.json"), {
        overrides: { github: false },
      });

      const { servers } = loadMcpServers({ cwd: root, gitRoot: root, configDir, env: {} });
      expect(servers[0]?.enabled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("it can ENABLE a server a committed project file disabled", async () => {
    // The reason the overlay is a map rather than a list of disabled names.
    // `enable` must lift a sticky `enabled: false` without editing a file that
    // is committed and shared.
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      const project = path.join(root, "work");
      await writeJson(path.join(project, ".keryx", "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: server({ enabled: false }) },
      });
      await writeJson(path.join(configDir, "mcp-servers-disabled.json"), {
        overrides: { github: true },
      });

      const { servers } = loadMcpServers({ cwd: project, gitRoot: project, configDir, env: {} });
      expect(servers[0]?.enabled).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a broken overlay reports itself and leaves the files' own enabled in force", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      await writeJson(path.join(configDir, "mcp-servers.json"), {
        schemaVersion: 1,
        servers: { github: server({ enabled: true }) },
      });
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "mcp-servers-disabled.json"), "{ not json", "utf8");

      const { servers, problems } = loadMcpServers({ cwd: root, gitRoot: root, configDir, env: {} });

      expect(servers[0]?.enabled).toBe(true);
      expect(problems.map((p) => p.message).join("\n")).toContain("personal overrides ignored");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a bad file is reported, never silently empty", () => {
  test("malformed JSON yields a problem naming the file", () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    const file = path.join(root, "broken.json");
    Bun.write(file, "{ nope");
    const { servers, problems } = parseConfigFile(file);
    expect(servers).toEqual({});
    expect(problems[0]?.message).toContain("not valid JSON");
  });

  test("an absent file is NOT a problem — not configuring MCP is the normal case", () => {
    const { servers, problems } = parseConfigFile(path.join(tmpdir(), "definitely-absent-xyz.json"));
    expect(servers).toEqual({});
    expect(problems).toEqual([]);
  });

  test("a server with neither command nor url is rejected AND said so", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const file = path.join(root, "c.json");
      await writeJson(file, { schemaVersion: 1, servers: { broken: { enabled: true } } });
      const { servers, problems } = parseConfigFile(file);

      // Both halves. A rejected entry that is merely absent from the result is
      // indistinguishable from one that was never written.
      expect(servers.broken).toBeUndefined();
      expect(problems.map((p) => p.message).join("\n")).toContain("neither command nor url");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a server with both command and url is rejected", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const file = path.join(root, "c.json");
      await writeJson(file, {
        schemaVersion: 1,
        servers: { both: { command: "x", url: "https://example.test" } },
      });
      expect(parseConfigFile(file).problems.map((p) => p.message).join("\n")).toContain("never both");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("one bad entry does not discard its good siblings", async () => {
    // The same rule AC8 states for a server that fails to start, one layer
    // earlier: a partial failure must stay partial.
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const file = path.join(root, "c.json");
      await writeJson(file, {
        schemaVersion: 1,
        servers: { good: { command: "ok" }, bad: { enabled: true } },
      });
      const { servers, problems } = parseConfigFile(file);
      expect(Object.keys(servers)).toEqual(["good"]);
      expect(problems).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("environment expansion", () => {
  test("${VAR} and ${VAR:-default}", () => {
    expect(expandVars("${A}/x", { A: "one" })).toBe("one/x");
    expect(expandVars("${MISSING:-fallback}", {})).toBe("fallback");
    expect(expandVars("${SET:-fallback}", { SET: "real" })).toBe("real");
  });

  test("an unset variable with no default becomes empty, never the literal", () => {
    // Leaving `${TOKEN}` in place would send that string as a header or an
    // argument, and the failure would surface far from the config that caused
    // it.
    expect(expandVars("Bearer ${TOKEN}", {})).toBe("Bearer ");
  });

  test("expansion reaches command, args, env values and headers — the fields the spec names", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-mcp-cfg");
    try {
      const configDir = path.join(root, "config");
      await writeJson(path.join(configDir, "mcp-servers.json"), {
        schemaVersion: 1,
        servers: {
          s: {
            command: "${BIN}",
            args: ["--dir", "${DIR}"],
            env: { TOKEN: "${SECRET}" },
            headers: { Authorization: "Bearer ${SECRET}" },
          },
        },
      });

      const { servers } = loadMcpServers({
        cwd: root,
        gitRoot: root,
        configDir,
        env: { BIN: "npx", DIR: "/tmp/x", SECRET: "s3cr3t" },
      });
      const s = servers[0];

      expect(s?.command).toBe("npx");
      expect(s?.args).toEqual(["--dir", "/tmp/x"]);
      expect(s?.env?.TOKEN).toBe("s3cr3t");
      expect(s?.headers?.Authorization).toBe("Bearer s3cr3t");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a name that is not an identifier is left alone rather than eaten", () => {
    // `${}` and `${1BAD}` are not variables; rewriting them to empty would
    // silently change a literal the operator meant.
    expect(expandVars("${}", {})).toBe("${}");
    expect(expandVars("${1BAD}", {})).toBe("${1BAD}");
  });
});
