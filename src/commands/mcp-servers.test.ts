import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCredential, writeCredential } from "../mcp-servers/credentials";
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
    // What this actually pins is the ENCLOSING guard: the compat branch
    // sits behind `defining.length === 0`, so a native name never
    // reaches the predicate at all. My original comment claimed it
    // caught an inverted source check, and a reviewer showed it does
    // not — dropping either source conjunct leaves 782 tests green.
    //
    // Kept, because "a native name is removed and not diverted" is
    // worth pinning on its own. The claim it used to make is gone.
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

describe("releasing a held server — the other half of the trust gate", () => {
  // The gate that HOLDS a committable server was covered by a class
  // test. The command that RELEASES one had no test at all: reverting
  // its guard to the exact pre-fix `source !== "project"` left 1975
  // tests green, as did `if (false)` (everything approvable, including
  // user scope) and `if (true)` (nothing ever approvable, every held
  // server permanently stuck).
  //
  // The class written was "every committable source is HELD". Its
  // complement — "every committable source can be RELEASED, and
  // nothing else can" — is where the second half of the fix lives, and
  // it is the half that was missing.

  function inRepo(rel: string, text: string): { run: (s: McpConsumerSubcommand, a: string[]) => Promise<Run>; root: string } {
    const h = harness();
    const file = path.join(h.projectRoot, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return { run: h.run, root: h.projectRoot };
  }

  const COMMITTABLE: ReadonlyArray<readonly [string, string, string]> = [
    [".mcp.json", ".mcp.json", JSON.stringify({ mcpServers: { held: { command: "sh" } } })],
    [".cursor/mcp.json", ".cursor/mcp.json", JSON.stringify({ mcpServers: { held: { command: "sh" } } })],
    [".grok/config.toml", ".grok/config.toml", '[mcp_servers.held]\ncommand = "sh"\n'],
    [
      ".keryx/mcp-servers.json",
      ".keryx/mcp-servers.json",
      JSON.stringify({ schemaVersion: 1, servers: { held: { command: "sh" } } }),
    ],
  ];

  for (const [label, rel, text] of COMMITTABLE) {
    test(`a server from ${label} CAN be trusted`, async () => {
      const { run } = inRepo(rel, text);
      const before = await run("list", []);
      expect(before.out).toContain("(needs approval)");

      const trusted = await run("trust", ["held"]);
      expect({ label, code: trusted.code, err: trusted.err }).toEqual({ label, code: 0, err: "" });

      // And the hold is actually lifted, which is the point.
      const after = await run("list", []);
      expect(after.out).not.toContain("(needs approval)");
    });
  }

  test("BOUNDARY — a USER-scope server cannot, and the refusal says why", async () => {
    // Without this, `if (false)` — approve anything — passes every row
    // above. Asking the operator to confirm their own `keryx mcp add`
    // would train them to say yes without reading.
    const h = harness();
    await h.run("add", ["mine", "--", "cmd"]);
    const result = await h.run("trust", ["mine"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("did not come from a file this project can commit");
  });

  test("BOUNDARY — and neither can one from the operator's OWN cursor config", async () => {
    // `cursor` is the tag that appears on both sides of this line, so
    // it is the one that proves the command asks about the file and not
    // about the tag.
    const h = harness();
    const home = mkdtempSync(path.join(tmpdir(), "keryx-home-"));
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { theirs: { command: "sh" } } }),
    );
    const result = await runMcpConsumerCommand("trust", ["theirs"], {
      cwd: h.projectRoot,
      configDir: h.configDir,
      projectRoot: h.projectRoot,
      home,
      log: () => {},
      err: () => {},
    });
    expect(result).toBe(1);
  });

  test("untrust puts a released server back under the gate", async () => {
    const { run } = inRepo(".mcp.json", JSON.stringify({ mcpServers: { held: { command: "sh" } } }));
    await run("trust", ["held"]);
    expect((await run("list", [])).out).not.toContain("(needs approval)");

    const revoked = await run("untrust", ["held"]);
    expect(revoked.code).toBe(0);
    expect((await run("list", [])).out).toContain("(needs approval)");
  });

  test("the held footer counts committed config, not 'project servers'", async () => {
    // The reworded footer is a diff line whose whole point is that a
    // held compat server is not a "project server". Reverting the
    // wording left 782 tests green.
    const { run } = inRepo(".mcp.json", JSON.stringify({ mcpServers: { held: { command: "sh" } } }));
    const listed = await run("list", []);
    expect(listed.out).toContain("from committed config");
    expect(listed.out).not.toContain("project server(s)");
  });
});

describe("AC4/AC13 — keryx mcp auth", () => {
  // Spec AC20: a non-TTY process must exit non-zero WITHOUT opening a
  // browser and without hanging. Three distinct failures behind one
  // sentence, and an exit-code-only test passes for all three.

  function remote(over: Record<string, unknown> = {}): {
    run: (s: McpConsumerSubcommand, a: string[]) => Promise<Run>;
    opened: URL[];
  } {
    const base = mkdtempSync(path.join(tmpdir(), "keryx-auth-"));
    const configDir = path.join(base, "config");
    const projectRoot = path.join(base, "project");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      JSON.stringify({ schemaVersion: 1, servers: { linear: { url: "https://mcp.linear.app/mcp", ...over } } }),
    );
    const opened: URL[] = [];
    const run = async (sub: McpConsumerSubcommand, args: string[]): Promise<Run> => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runMcpConsumerCommand(sub, args, {
        cwd: projectRoot,
        configDir,
        projectRoot,
        home: path.join(base, "home"),
        interactive: false,
        openBrowser: (url) => { opened.push(url); },
        log: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    return { run, opened };
  }

  test("headless exits non-zero", async () => {
    const { run } = remote();
    expect((await run("auth", ["linear"])).code).toBe(1);
  });

  test("headless opens NO browser", async () => {
    // The assertion the exit code cannot make.
    const { run, opened } = remote();
    await run("auth", ["linear"]);
    expect(opened).toEqual([]);
  });

  test("headless returns promptly rather than waiting for a click", async () => {
    // A CI job that waits five minutes for a consent screen nobody
    // will click turned a clear failure into a timeout.
    const { run } = remote();
    const started = Date.now();
    await run("auth", ["linear"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("and says which command would work", async () => {
    const { run } = remote();
    expect((await run("auth", ["linear"])).err).toContain("keryx mcp auth linear");
  });

  test("AC13 — a server with a bearer variable is told there is nothing to do", async () => {
    // Starting a flow that cannot help is worse than saying so: the
    // operator would authorise something and still be authenticated
    // by the credential they already had.
    const { run, opened } = remote({ bearer_token_env_var: "LINEAR_TOKEN" });
    const result = await run("auth", ["linear"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("does not use OAuth");
    expect(opened).toEqual([]);
  });

  test("AC13 — and so is one with an explicit Authorization header", async () => {
    const { run } = remote({ headers: { Authorization: "Bearer ${T}" } });
    expect((await run("auth", ["linear"])).err).toContain("does not use OAuth");
  });

  test("a stdio server is told OAuth does not apply", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "keryx-auth-stdio-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      JSON.stringify({ schemaVersion: 1, servers: { local: { command: "npx" } } }),
    );
    const err: string[] = [];
    const code = await runMcpConsumerCommand("auth", ["local"], {
      cwd: base, configDir, projectRoot: base, home: path.join(base, "home"),
      interactive: false, log: () => {}, err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join()).toContain("local (stdio) server");
  });

  test("an unknown name lists what is configured", async () => {
    const { run } = remote();
    const result = await run("auth", ["nosuch"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("linear");
  });

  test("with no name at all, usage", async () => {
    const { run } = remote();
    expect((await run("auth", [])).err).toContain("usage: keryx mcp auth");
  });
});

describe("keryx mcp logout — the missing half of auth", () => {
  // A revoked refresh token is not recoverable by re-running `auth`:
  // the SDK re-throws `invalid_grant` before any browser opens. Until
  // this existed, the only escape was hand-editing a 0600 file.

  function fixture(servers: Record<string, unknown>): { configDir: string; projectRoot: string } {
    const base = mkdtempSync(path.join(tmpdir(), "keryx-logout-"));
    const configDir = path.join(base, "config");
    const projectRoot = path.join(base, "project");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      JSON.stringify({ schemaVersion: 1, servers }),
    );
    return { configDir, projectRoot };
  }

  async function logout(
    configDir: string,
    projectRoot: string,
    name: string,
  ): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpConsumerCommand("logout", [name], {
      cwd: projectRoot,
      configDir,
      projectRoot,
      home: path.join(projectRoot, "home"),
      interactive: false,
      log: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  const URL_ = "https://mcp.linear.app/mcp";

  test("it removes the stored credential", async () => {
    const { configDir, projectRoot } = fixture({ linear: { url: URL_ } });
    writeCredential("linear", URL_, { tokens: { access_token: "dead" } }, configDir);
    const result = await logout(configDir, projectRoot, "linear");
    expect(result.code).toBe(0);
    expect(readCredential("linear", URL_, configDir).record).toBeUndefined();
  });

  test("and leaves every OTHER server's credential alone", async () => {
    // The whole file is rewritten to remove one key, which is exactly
    // where a careless implementation takes the others with it.
    const { configDir, projectRoot } = fixture({ linear: { url: URL_ }, other: { url: "https://o/mcp" } });
    writeCredential("linear", URL_, { tokens: { access_token: "dead" } }, configDir);
    writeCredential("other", "https://o/mcp", { tokens: { access_token: "keep" } }, configDir);
    await logout(configDir, projectRoot, "linear");
    expect(readCredential("other", "https://o/mcp", configDir).record?.tokens?.access_token).toBe("keep");
  });

  test("it works for a server that has been REMOVED from the config", async () => {
    // The case the keyed lookup cannot serve, and the one where a
    // stale token actually hides: `keryx mcp remove` took the server
    // away and left the credential behind, keyed to a name nothing
    // looks up any more.
    const { configDir, projectRoot } = fixture({});
    writeCredential("ghost", "https://g/mcp", { tokens: { access_token: "orphan" } }, configDir);
    const result = await logout(configDir, projectRoot, "ghost");
    expect(result.code).toBe(0);
    expect(readCredential("ghost", "https://g/mcp", configDir).record).toBeUndefined();
  });

  test("and that fallback does not take a similarly-named server with it", async () => {
    // `{name}:{url}` is split on the FIRST colon, so "ghost" must not
    // match "ghost-two".
    const { configDir, projectRoot } = fixture({});
    writeCredential("ghost", "https://g/mcp", { tokens: { access_token: "a" } }, configDir);
    writeCredential("ghost-two", "https://g/mcp", { tokens: { access_token: "b" } }, configDir);
    await logout(configDir, projectRoot, "ghost");
    expect(readCredential("ghost-two", "https://g/mcp", configDir).record?.tokens?.access_token).toBe("b");
  });

  test("a server with no credential says so and does not fail", async () => {
    const { configDir, projectRoot } = fixture({ linear: { url: URL_ } });
    const result = await logout(configDir, projectRoot, "linear");
    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to forget");
  });

  test("an unknown name with no credential is an error, not a silent success", async () => {
    const { configDir, projectRoot } = fixture({});
    expect((await logout(configDir, projectRoot, "nosuch")).code).toBe(1);
  });

  test("it tells the operator how to authorise again", async () => {
    const { configDir, projectRoot } = fixture({ linear: { url: URL_ } });
    writeCredential("linear", URL_, { tokens: { access_token: "dead" } }, configDir);
    expect((await logout(configDir, projectRoot, "linear")).out).toContain("keryx mcp auth linear");
  });

  test("usage when no name is given", async () => {
    const { configDir, projectRoot } = fixture({});
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpConsumerCommand("logout", [], {
      cwd: projectRoot, configDir, projectRoot, home: projectRoot,
      interactive: false, log: (l) => out.push(l), err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join()).toContain("usage: keryx mcp logout");
  });
});
