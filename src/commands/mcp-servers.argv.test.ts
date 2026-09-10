// The `--` separator, and what happens when it is not respected.
//
// Every case here is a real reproduction from the review of PR #522. They
// share one root cause: `addCommand` sliced the POSITIONALS at `--` but read
// its own FLAGS from the whole argv, so a flag belonging to the server being
// launched was consumed by keryx. The doc comment on `addCommand` claimed the
// separator prevented exactly this.
//
// Driven through `runMcpConsumerCommand`, and asserted on the FILE that was
// written — an exit code of 0 was what made every one of these silent.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectConfigFile, userConfigFile } from "../mcp-servers/store";
import { runMcpConsumerCommand, type McpConsumerSubcommand } from "./mcp-servers";

type Run = { code: number; out: string; err: string };

function harness(): {
  run: (sub: McpConsumerSubcommand, args: string[]) => Promise<Run>;
  configDir: string;
  projectRoot: string;
  userServers: () => Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  projectExists: () => boolean;
} {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-argv-"));
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
      log: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  const userServers = (): Record<string, never> => {
    try {
      return (JSON.parse(readFileSync(userConfigFile(configDir), "utf8")) as { servers: Record<string, never> })
        .servers;
    } catch {
      return {};
    }
  };
  const projectExists = (): boolean => {
    try {
      readFileSync(projectConfigFile(projectRoot), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  return { run, configDir, projectRoot, userServers, projectExists };
}

describe("keryx's flags are read only from BEFORE the separator", () => {
  test("a --scope belonging to the server does not redirect keryx's write", async () => {
    // Reported: `add fs -- mycmd --scope project` wrote the server into the
    // COMMITTED project file. The operator asked for the default (user) and
    // got a file their colleagues will pull.
    const h = harness();
    const result = await h.run("add", ["fs", "--", "mycmd", "--scope", "project"]);

    expect(result.code).toBe(0);
    expect(h.projectExists()).toBe(false);
    expect(h.userServers().fs).toEqual({ command: "mycmd", args: ["--scope", "project"] });
  });

  test("a --force belonging to the server does not overwrite an existing one", async () => {
    // Reported: exit 0, no warning, the original gone — the precise thing
    // `addServer` refuses to do when keryx's own `--force` is absent.
    const h = harness();
    await h.run("add", ["mail", "--", "original-cmd"]);

    const second = await h.run("add", ["mail", "--", "newcmd", "--force"]);

    expect(second.code).toBe(1);
    expect(second.err).toContain("already exists");
    expect(h.userServers().mail?.command).toBe("original-cmd");
  });

  test("a -e belonging to the server does not become a child environment variable", async () => {
    // Reported: the operator passes their server a `-e SMTP=host:25` flag and
    // keryx additionally injects SMTP into the spawned process environment.
    const h = harness();
    await h.run("add", ["mail", "--", "mysrv", "-e", "SMTP=host:25"]);

    expect(h.userServers().mail).toEqual({ command: "mysrv", args: ["-e", "SMTP=host:25"] });
    expect(h.userServers().mail?.env).toBeUndefined();
  });

  test("a --transport belonging to the server does not reroute the command", async () => {
    // Reported: failed with "needs a URL", naming flags the operator never
    // typed, and wrote nothing.
    const h = harness();
    const result = await h.run("add", ["gw", "--", "mycmd", "--transport", "http"]);

    expect(result.code).toBe(0);
    expect(h.userServers().gw).toEqual({ command: "mycmd", args: ["--transport", "http"] });
  });

  test("keryx's OWN flags before the separator still work — anti-vacuity", async () => {
    // If the fix had simply stopped reading flags, every test above would
    // pass for the wrong reason.
    const h = harness();
    const result = await h.run("add", ["fs", "--scope", "project", "-e", "A=1", "--", "cmd"]);

    expect(result.code).toBe(0);
    expect(h.projectExists()).toBe(true);
    const project = JSON.parse(readFileSync(projectConfigFile(h.projectRoot), "utf8")) as {
      servers: Record<string, { env?: Record<string, string> }>;
    };
    expect(project.servers.fs?.env).toEqual({ A: "1" });
  });

  test("keryx's --force before the separator still overwrites", async () => {
    const h = harness();
    await h.run("add", ["mail", "--", "one"]);
    const second = await h.run("add", ["mail", "--force", "--", "two"]);

    expect(second.code).toBe(0);
    expect(h.userServers().mail?.command).toBe("two");
  });
});

describe("an option this module does not know is refused, not renamed", () => {
  test("--verbose does not become the server name", async () => {
    // Reported: `add --verbose vv -- cmd` created a server called
    // "--verbose" (hyphens are legal in a name) and silently dropped `vv`.
    const h = harness();
    const result = await h.run("add", ["--verbose", "vv", "--", "cmd"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--verbose");
    expect(Object.keys(h.userServers())).toEqual([]);
  });

  test("a value that merely looks like a flag is still a value", async () => {
    // `-e -x=1` is a (strange) KEY=value pair, not an unknown option.
    const h = harness();
    const result = await h.run("add", ["s", "-e", "-x=1", "--", "cmd"]);
    expect(result.code).toBe(0);
  });
});

describe("a keryx flag given twice is refused, not silently first-wins", () => {
  test("--scope twice picks neither", async () => {
    // `optionValue` takes the first and says nothing, so
    // `--scope user --scope project` landed in USER, exit 0 — a scope the
    // operator did not ask for, chosen in silence. Same class as the typo
    // above.
    const h = harness();
    const result = await h.run("add", ["srv", "--scope", "user", "--scope", "project", "--", "cmd"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("more than once");
    expect(Object.keys(h.userServers())).toEqual([]);
  });

  test("the equals form too", async () => {
    const h = harness();
    expect((await h.run("add", ["srv", "--scope=project", "--scope=user", "--", "cmd"])).code).toBe(1);
  });

  test("but -e and --header stay repeatable, because they are meant to be", async () => {
    const h = harness();
    const result = await h.run("add", ["srv", "-e", "A=1", "-e", "B=2", "--", "cmd"]);
    expect(result.code).toBe(0);
    expect(h.userServers().srv?.env).toEqual({ A: "1", B: "2" });
  });
});

describe("a malformed option is reported, not dropped", () => {
  test("-e without an = refuses instead of adding a server with no env", async () => {
    // Reported: exit 0, `{"command":"cmd"}` written, no env, no warning —
    // the operator believes they configured something they did not.
    const h = harness();
    const result = await h.run("add", ["noeq", "-e", "PATH", "--", "cmd"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("KEY=value");
    expect(Object.keys(h.userServers())).toEqual([]);
  });

  test("a trailing --header refuses instead of dropping an Authorization header", async () => {
    const h = harness();
    const result = await h.run("add", ["--transport", "http", "s", "https://x", "--header"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("--header");
    expect(Object.keys(h.userServers())).toEqual([]);
  });
});
