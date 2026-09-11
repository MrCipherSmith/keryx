import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerConnection, McpToolDescriptor } from "../mcp-client/client";
import { projectConfigFile, userConfigFile } from "../mcp-servers/store";
import {
  isMcpConsumerSubcommand,
  MCP_CONSUMER_SUBCOMMANDS,
  runMcpConsumerCommand,
  type McpConsumerDeps,
  type McpConsumerSubcommand,
} from "./mcp-servers";

type Run = { code: number; out: string; err: string };

function harness(over: Partial<McpConsumerDeps> = {}): {
  run: (sub: McpConsumerSubcommand, args: string[]) => Promise<Run>;
  configDir: string;
  projectRoot: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-cli-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const run = async (sub: McpConsumerSubcommand, args: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpConsumerCommand(sub, args, {
      cwd: projectRoot,
      configDir,
      projectRoot,
      log: (line) => out.push(line),
      err: (line) => err.push(line),
      ...over,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  return { run, configDir, projectRoot };
}

function connection(tools: McpToolDescriptor[] = []): McpServerConnection {
  return {
    listTools: async () => tools,
    callTool: async () => ({ kind: "result", result: { content: [], isError: false } }) as never,
    close: async () => {},
  };
}

describe("routing", () => {
  test("every subcommand in the exported set is handled", async () => {
    // A name in the routing set with no case in the switch would be a
    // subcommand `mcp.ts` claims and nothing implements.
    const { run } = harness();
    for (const sub of MCP_CONSUMER_SUBCOMMANDS) {
      const result = await run(sub, []);
      expect(typeof result.code).toBe("number");
    }
  });

  test("the publisher verbs are NOT claimed by the consumer surface", () => {
    // `serve` and `install` must keep reaching their aliases in `mcp.ts`.
    for (const retired of ["serve", "install", "uninstall"]) {
      expect(isMcpConsumerSubcommand(retired)).toBe(false);
    }
    expect(isMcpConsumerSubcommand(undefined)).toBe(false);
  });
});

describe("add", () => {
  test("stdio: the command after `--` is stored verbatim, flags included", async () => {
    // Without the separator, `keryx mcp add fs -- npx pkg --json` would eat
    // `--json` as keryx's own.
    const { run, configDir } = harness();
    const result = await run("add", ["fs", "--", "npx", "-y", "pkg", "--json"]);

    expect(result.code).toBe(0);
    const doc = JSON.parse(readFileSync(userConfigFile(configDir), "utf8")) as {
      servers: Record<string, { command: string; args: string[] }>;
    };
    expect(doc.servers.fs).toEqual({ command: "npx", args: ["-y", "pkg", "--json"] });
  });

  test("stdio without `--` is refused rather than guessed", async () => {
    const { run } = harness();
    const result = await run("add", ["fs", "npx", "pkg"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("`--`");
  });

  test("-e is repeatable and lands in env", async () => {
    const { run, configDir } = harness();
    await run("add", ["fs", "-e", "A=1", "-e", "B=2", "--", "npx"]);

    const doc = JSON.parse(readFileSync(userConfigFile(configDir), "utf8")) as {
      servers: Record<string, { env: Record<string, string> }>;
    };
    expect(doc.servers.fs?.env).toEqual({ A: "1", B: "2" });
  });

  test("--scope project writes the project file, not the user one", async () => {
    const { run, projectRoot, configDir } = harness();
    const result = await run("add", ["fs", "--scope", "project", "--", "npx"]);

    expect(result.code).toBe(0);
    expect(readFileSync(projectConfigFile(projectRoot), "utf8")).toContain("npx");
    expect(() => readFileSync(userConfigFile(configDir), "utf8")).toThrow();
  });

  test("--transport http takes a URL and repeatable --header", async () => {
    const { run, configDir } = harness();
    const result = await run("add", [
      "--transport", "http", "linear", "https://mcp.linear.app/mcp",
      "--header", "Authorization: Bearer x",
    ]);

    expect(result.code).toBe(0);
    const doc = JSON.parse(readFileSync(userConfigFile(configDir), "utf8")) as {
      servers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(doc.servers.linear?.url).toBe("https://mcp.linear.app/mcp");
    expect(doc.servers.linear?.headers).toEqual({ Authorization: "Bearer x" });
  });

  test("sse is an alias of http, not a third shape", async () => {
    const { run, configDir } = harness();
    await run("add", ["--transport", "sse", "s", "https://example/mcp"]);

    const doc = JSON.parse(readFileSync(userConfigFile(configDir), "utf8")) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(doc.servers.s).toEqual({ url: "https://example/mcp" });
  });

  test("a malformed --header is refused before anything is written", async () => {
    const { run, configDir } = harness();
    const result = await run("add", ["--transport", "http", "s", "https://x", "--header", "nocolon"]);

    expect(result.code).toBe(1);
    expect(() => readFileSync(userConfigFile(configDir), "utf8")).toThrow();
  });

  test("an unknown transport is refused", async () => {
    const { run } = harness();
    expect((await run("add", ["--transport", "carrier-pigeon", "s", "x"])).code).toBe(1);
  });
});

describe("list", () => {
  test("an empty list names the files that were read", async () => {
    // "No servers" over a config the operator just wrote, in a path keryx
    // does not read, is the case where an empty list sends them to debug the
    // wrong thing.
    const { run, configDir, projectRoot } = harness();
    const result = await run("list", []);

    expect(result.out).toContain(userConfigFile(configDir));
    expect(result.out).toContain(projectConfigFile(projectRoot));
  });

  test("each server carries its source tag, and a disabled one says so", async () => {
    const { run } = harness();
    await run("add", ["a", "--", "cmd-a"]);
    await run("add", ["b", "--scope", "project", "--", "cmd-b"]);
    await run("disable", ["a"]);

    const result = await run("list", []);
    expect(result.out).toContain("a (user) (disabled)");
    expect(result.out).toContain("b (project)");
  });

  test("an expanded ${VAR} in args is NOT echoed to the terminal", async () => {
    // `keryx mcp list` printed `command`/`args` AFTER expansion, so
    // `--token=${GITHUB_TOKEN}` put a live token on screen and into
    // whatever the operator pastes. `doctor` followed the redaction rule
    // for env/headers; `list` followed it nowhere.
    const h = harness();
    const file = userConfigFile(h.configDir);
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        servers: { gh: { command: "npx", args: ["gh-mcp", "--token=${SECRET_FOR_TEST}"] } },
      }),
    );
    process.env.SECRET_FOR_TEST = "sk-live-do-not-print";
    try {
      const result = await h.run("list", []);
      expect(result.out).not.toContain("sk-live-do-not-print");
      // And it still says something useful — which variable it needs.
      expect(result.out).toContain("${SECRET_FOR_TEST}");
    } finally {
      delete process.env.SECRET_FOR_TEST;
    }
  });

  test("--json never prints an env value", async () => {
    const { run } = harness();
    await run("add", ["a", "-e", "TOKEN=sk-live-secret", "--", "cmd"]);

    const result = await run("list", ["--json"]);
    expect(result.out).not.toContain("sk-live-secret");
    expect(result.out).toContain('"TOKEN": "set"');
  });

  test("a config problem is reported and turns the exit code non-zero", async () => {
    const { run, configDir } = harness();
    writeFileSync(userConfigFile(configDir), "{ broken");

    const result = await run("list", []);
    expect(result.code).toBe(1);
    expect(result.err).toContain("config problem");
  });
});

describe("remove", () => {
  test("removes from the only scope that defines it, without --scope", async () => {
    const { run, projectRoot } = harness();
    await run("add", ["a", "--scope", "project", "--", "cmd"]);
    // The entry is really there before — the old version of this test
    // asserted only that the USER file does not exist, which was already
    // true at setup and stayed true whether the removal persisted or not.
    expect(readFileSync(projectConfigFile(projectRoot), "utf8")).toContain('"a"');

    const result = await run("remove", ["a"]);

    expect(result.code).toBe(0);
    expect(readFileSync(projectConfigFile(projectRoot), "utf8")).not.toContain('"a"');
  });

  test("and from the USER scope when that is the only one — the other arm", async () => {
    // `definingScopes`' user branch had no CLI-level coverage at all.
    const { run, configDir } = harness();
    await run("add", ["a", "--", "cmd"]);

    const result = await run("remove", ["a"]);

    expect(result.code).toBe(0);
    expect(readFileSync(userConfigFile(configDir), "utf8")).not.toContain('"a"');
  });

  test("a name in BOTH scopes refuses to guess", async () => {
    // Removing from a guessed scope is a delete the operator did not ask for.
    const { run } = harness();
    await run("add", ["a", "--", "cmd"]);
    await run("add", ["a", "--scope", "project", "--", "cmd"]);

    const result = await run("remove", ["a"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("both scopes");
  });

  test("an undefined name names the files that were searched", async () => {
    const { run, configDir } = harness();
    const result = await run("remove", ["ghost"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(userConfigFile(configDir));
  });
});

describe("enable/disable", () => {
  test("a toggle for a name nothing defines is refused, not written", async () => {
    // Otherwise it writes an overlay entry that will never apply to
    // anything, and reports success.
    const { run } = harness();
    await run("add", ["real", "--", "cmd"]);

    const result = await run("disable", ["typo"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("real");
  });

  test("disable then enable round-trips through list", async () => {
    const { run } = harness();
    await run("add", ["a", "--", "cmd"]);

    await run("disable", ["a"]);
    expect((await run("list", [])).out).toContain("(disabled)");

    await run("enable", ["a"]);
    expect((await run("list", [])).out).not.toContain("(disabled)");
  });
});

describe("doctor", () => {
  test("reports the tool count and exits 0 when everything connects", async () => {
    const { run } = harness({ connect: async () => connection([{ name: "read" }] as McpToolDescriptor[]) });
    await run("add", ["a", "--", "cmd"]);

    const result = await run("doctor", []);
    expect(result.code).toBe(0);
    expect(result.out).toContain("tools: 1");
  });

  test("a failing server exits non-zero and names the failure", async () => {
    const { run } = harness({
      connect: async () => {
        throw new Error("spawn cmd ENOENT");
      },
    });
    await run("add", ["a", "--", "cmd"]);

    const result = await run("doctor", []);
    expect(result.code).toBe(1);
    expect(result.out).toContain("ENOENT");
  });

  test("doctor <name> dials only that server", async () => {
    const dialled: string[] = [];
    const { run } = harness({
      connect: async (server) => {
        dialled.push(server.name);
        return connection();
      },
    });
    await run("add", ["a", "--", "cmd"]);
    await run("add", ["b", "--", "cmd"]);

    await run("doctor", ["b"]);
    expect(dialled).toEqual(["b"]);
  });

  test("--json prints the report and still withholds the values", async () => {
    const { run } = harness({ connect: async () => connection() });
    await run("add", ["a", "-e", "TOKEN=sk-live-secret", "--", "cmd"]);

    const result = await run("doctor", ["--json"]);
    const parsed = JSON.parse(result.out) as { servers: Array<{ env: Record<string, string> }> };
    expect(parsed.servers[0]?.env).toEqual({ TOKEN: "set" });
    expect(result.out).not.toContain("sk-live-secret");
  });
});

describe("a server that came from another tool's config", () => {
  // AC3. The compat-only `remove` path had three surviving mutants on
  // one line — the predicate that finds the compat server — because I
  // confirmed the behaviour by reading the code rather than running it.
  // Exactly the habit this package keeps paying for.

  function withCursor(): { run: (sub: McpConsumerSubcommand, args: string[]) => Promise<Run>; cursorFile: string } {
    const h = harness();
    const cursorFile = path.join(h.projectRoot, ".cursor", "mcp.json");
    mkdirSync(path.dirname(cursorFile), { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ mcpServers: { theirs: { command: "their-cmd" } } }));
    return { run: h.run, cursorFile };
  }

  test("remove names the file that defines it, and refuses", async () => {
    const { run, cursorFile } = withCursor();
    const result = await run("remove", ["theirs"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("cursor");
    expect(result.err).toContain(cursorFile);
    expect(result.err).toContain("never writes to it");
    // And it offers the thing that DOES work.
    expect(result.err).toContain("keryx mcp disable theirs");
  });

  test("and the compat file is untouched by the attempt", async () => {
    const { run, cursorFile } = withCursor();
    const before = readFileSync(cursorFile, "utf8");
    await run("remove", ["theirs"]);
    expect(readFileSync(cursorFile, "utf8")).toBe(before);
  });

  test("BOUNDARY — a name in NEITHER native nor compat gets the native message", async () => {
    // The predicate must find the right server, not any server. With
    // `name !== name` it matched the first compat entry whatever was
    // asked for, so a typo would be blamed on somebody else's file.
    const { run } = withCursor();
    const result = await run("remove", ["nosuch"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("not defined in either native config file");
    expect(result.err).not.toContain(".cursor");
  });

  test("BOUNDARY — a NATIVE name is removed normally, not diverted", async () => {
    // With the source check inverted, a native server would be reported
    // as coming from a compat file and never removed.
    const { run } = withCursor();
    await run("add", ["mine", "--", "cmd"]);
    const result = await run("remove", ["mine"]);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("never writes to it");
  });

  test("the compat server is listed, with its tag", async () => {
    const { run } = withCursor();
    const result = await run("list", []);
    expect(result.out).toContain("theirs");
    expect(result.out).toContain("(cursor)");
  });
});
