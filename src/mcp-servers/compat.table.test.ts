// The compat readers, as a TABLE — one row per case, organised by CLASS.
//
// AC12. The shape is checked by the shared `classTableProblems` rule,
// because in P1 the hand-written version of that check read
// `refused > 0 || allowed > 0` and asserted nothing, and in P2 giving
// three classes one outcome vocabulary made two of them one-sided.
// The axis belongs to the class.
//
// What these classes are for: keryx reads four other tools' config
// files, and the two ways to get that wrong are to MISS a server
// somebody configured, and to accept something malformed silently. A
// silently skipped source is indistinguishable from one that was never
// configured, which is the state an operator debugs for an hour.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classTableProblems } from "./class-table";
import { compatFiles, parseGrokToml, readCompatFile, type CompatSource } from "./compat";

type Row = {
  readonly label: string;
  readonly source: CompatSource;
  /** Relative path under the fake home or cwd, and the file's content. */
  readonly write: { readonly rel: string; readonly text: string };
  /**
   * Read this path instead of the one written.
   *
   * Only the absent-file row needs it, and it needs it badly: without
   * it the row wrote `unrelated.txt` and then READ that same file as a
   * Cursor config, so it was testing "a text file is invalid JSON"
   * while claiming to test "an absent file is silence". The harness was
   * wrong, not the code.
   */
  readonly readRel?: string;
  /** Server names the reader must produce. */
  readonly servers: readonly string[];
  /** A fragment every problem list must contain, when one is expected. */
  readonly problem?: string;
  readonly outcome: string;
};

function workspace(): { home: string; cwd: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-compat-"));
  const home = path.join(base, "home");
  const cwd = path.join(base, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function place(root: string, rel: string, text: string): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const CURSOR = JSON.stringify({ mcpServers: { ctx7: { command: "npx", args: ["-y", "ctx7"] } } });

const TABLE: Array<{ klass: string; why: string; rows: Row[] }> = [
  {
    klass: "each tool's own shape is read",
    why: "an operator who already set a server up in Cursor should not have to set it up again here",
    rows: [
      {
        label: "Cursor's mcpServers block",
        source: "cursor",
        write: { rel: ".cursor/mcp.json", text: CURSOR },
        servers: ["ctx7"],
        outcome: "servers",
      },
      {
        label: "a bare project .mcp.json",
        source: "mcp.json",
        write: { rel: ".mcp.json", text: CURSOR },
        servers: ["ctx7"],
        outcome: "servers",
      },
      {
        label: "Claude's top-level mcpServers",
        source: "claude",
        write: { rel: ".claude.json", text: CURSOR },
        servers: ["ctx7"],
        outcome: "servers",
      },
      {
        label: "Grok's [mcp_servers.NAME] table",
        source: "grok",
        write: {
          rel: ".grok/config.toml",
          text: '[mcp_servers.ctx7]\ncommand = "npx"\nargs = ["-y", "ctx7"]\n',
        },
        servers: ["ctx7"],
        outcome: "servers",
      },
      {
        label: "BOUNDARY — a valid file configuring NO servers is silent, not a problem",
        // Every operator with Cursor installed and no MCP set up in it
        // would otherwise see a warning on every command.
        source: "cursor",
        write: { rel: ".cursor/mcp.json", text: JSON.stringify({ other: true }) },
        servers: [],
        outcome: "none",
      },
      {
        label: "BOUNDARY — an absent file is silence, not an error",
        source: "cursor",
        write: { rel: "unrelated.txt", text: "x" },
        readRel: ".cursor/mcp.json",
        servers: [],
        outcome: "none",
      },
    ],
  },
  {
    klass: "a malformed source is REPORTED, never silently skipped",
    why: "a silently skipped source reads exactly like one that was never configured, and the operator debugs the wrong file",
    rows: [
      {
        label: "invalid JSON names the file and the parse error",
        source: "cursor",
        write: { rel: ".cursor/mcp.json", text: "{not json" },
        servers: [],
        problem: "not valid JSON",
        outcome: "reported",
      },
      {
        label: "a JSON array where an object belongs",
        source: "mcp.json",
        write: { rel: ".mcp.json", text: "[1,2,3]" },
        servers: [],
        problem: "must be a JSON object",
        outcome: "reported",
      },
      {
        label: "mcpServers that is not an object",
        source: "cursor",
        write: { rel: ".cursor/mcp.json", text: JSON.stringify({ mcpServers: "nope" }) },
        servers: [],
        problem: "keyed by name",
        outcome: "reported",
      },
      {
        label: "one bad entry is reported and the GOOD ones still load",
        source: "cursor",
        write: {
          rel: ".cursor/mcp.json",
          text: JSON.stringify({ mcpServers: { good: { command: "ok" }, bad: "not an object" } }),
        },
        servers: ["good"],
        problem: 'server "bad" must be an object',
        outcome: "reported",
      },
      {
        label: "TOML this reader cannot parse names the LINE, rather than guessing",
        // A partial parser that silently drops a line it cannot read is
        // how a server's `args` go missing and the command runs with the
        // wrong arguments — worse than not reading the file at all.
        source: "grok",
        write: { rel: ".grok/config.toml", text: '[mcp_servers.a]\ncommand = "ok"\nweird = { inline = 1 }\n' },
        servers: ["a"],
        problem: "line 3",
        outcome: "reported",
      },
      {
        label: "BOUNDARY — a well-formed file produces NO problems",
        source: "cursor",
        write: { rel: ".cursor/mcp.json", text: CURSOR },
        servers: ["ctx7"],
        outcome: "clean",
      },
    ],
  },
];

describe("compat readers, by CLASS", () => {
  for (const { klass, why, rows } of TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const row of rows) {
        test(row.label, () => {
          const { home, cwd } = workspace();
          // Project-local for the sources that have one, home for Claude.
          const root = row.source === "claude" ? home : cwd;
          place(root, row.write.rel, row.write.text);
          const file = path.join(root, row.readRel ?? row.write.rel);
          const result = readCompatFile({ source: row.source, file }, cwd);

          expect({ label: row.label, names: Object.keys(result.servers).sort() }).toEqual({
            label: row.label,
            names: [...row.servers].sort(),
          });
          if (row.problem === undefined) {
            expect({ label: row.label, problems: result.problems.length }).toEqual({
              label: row.label,
              problems: 0,
            });
          } else {
            expect(result.problems.map((p) => p.message).join(" | ")).toContain(row.problem);
            // The file is always named, because "something is wrong" with
            // no path is not actionable.
            expect(result.problems.every((p) => p.file === file)).toBe(true);
          }
        });
      }
    });
  }

  test("every class has three rows and a BOUNDARY", () => {
    expect(classTableProblems(TABLE, (row) => row.outcome)).toEqual([]);
  });
});

describe("Claude's per-project block", () => {
  test("servers under projects.<cwd> are read", () => {
    const { home, cwd } = workspace();
    const file = place(
      home,
      ".claude.json",
      JSON.stringify({ projects: { [cwd]: { mcpServers: { here: { command: "x" } } } } }),
    );
    expect(Object.keys(readCompatFile({ source: "claude", file }, cwd).servers)).toEqual(["here"]);
  });

  test("BOUNDARY — servers for a DIFFERENT project are not", () => {
    // Reading every project's block would hand the operator a list of
    // things configured for directories they are not in.
    const { home, cwd } = workspace();
    const file = place(
      home,
      ".claude.json",
      JSON.stringify({ projects: { "/somewhere/else": { mcpServers: { elsewhere: { command: "x" } } } } }),
    );
    expect(Object.keys(readCompatFile({ source: "claude", file }, cwd).servers)).toEqual([]);
  });

  test("and the project block beats the top level within the same file", () => {
    const { home, cwd } = workspace();
    const file = place(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: { shared: { command: "top" } },
        projects: { [cwd]: { mcpServers: { shared: { command: "project" } } } },
      }),
    );
    const servers = readCompatFile({ source: "claude", file }, cwd).servers;
    expect(servers.shared?.command).toBe("project");
  });
});

describe("the Grok subset, exactly", () => {
  test("strings, arrays, booleans, integers and sub-tables", () => {
    const { servers, problems } = parseGrokToml(
      "/g.toml",
      [
        "# a comment",
        "[mcp_servers.linear]",
        'command = "npx"',
        'args = ["-y", "linear-mcp"]',
        "enabled = true",
        "tool_timeout_sec = 30",
        "[mcp_servers.linear.env]",
        'TOKEN = "${LINEAR_TOKEN}"',
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(servers.linear).toEqual({
      command: "npx",
      args: ["-y", "linear-mcp"],
      enabled: true,
      tool_timeout_sec: 30,
      env: { TOKEN: "${LINEAR_TOKEN}" },
    } as never);
  });

  test("a `#` inside a quoted string is not a comment", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\nurl = "https://x/#frag"\n');
    expect(servers.a?.url).toBe("https://x/#frag");
  });

  test("a section that is not mcp_servers is skipped without complaint", () => {
    // Grok's config has other sections; this reader claims only one.
    const { servers, problems } = parseGrokToml("/g.toml", '[theme]\nname = "dark"\n[mcp_servers.a]\ncommand = "x"\n');
    expect(Object.keys(servers)).toEqual(["a"]);
    expect(problems).toEqual([]);
  });

  test("an array that is not all strings is refused WHOLE, not half-read", () => {
    // Half an `args` list is worse than none: the command would run
    // with arguments nobody wrote.
    const { problems } = parseGrokToml("/g.toml", '[mcp_servers.a]\nargs = ["ok", 3]\n');
    expect(problems.map((p) => p.message).join()).toContain("does not support");
  });

  test("BOUNDARY — an empty array is valid and empty", () => {
    const { servers, problems } = parseGrokToml("/g.toml", "[mcp_servers.a]\nargs = []\n");
    expect(problems).toEqual([]);
    expect(servers.a?.args).toEqual([]);
  });
});

describe("which files are consulted, and in what order", () => {
  test("the list is fixed, and later entries win", () => {
    // Arbitrary in that no external authority sets it; fixed in that it
    // is written down and asserted. An emergent order cannot answer
    // "which one won".
    const files = compatFiles("/proj", "/home/u");
    expect(files.map((f) => f.source)).toEqual(["grok", "grok", "claude", "mcp.json", "cursor", "cursor"]);
    expect(files.map((f) => f.file)).toEqual([
      "/home/u/.grok/config.toml",
      "/proj/.grok/config.toml",
      "/home/u/.claude.json",
      "/proj/.mcp.json",
      "/home/u/.cursor/mcp.json",
      "/proj/.cursor/mcp.json",
    ]);
  });

  test("BOUNDARY — a different cwd and home produce different paths", () => {
    // Without this, `compatFiles` could ignore its arguments entirely.
    const files = compatFiles("/other", "/home/v");
    expect(files[1]?.file).toBe("/other/.grok/config.toml");
    expect(files[2]?.file).toBe("/home/v/.claude.json");
  });
});
