// Compat sources, from a file on disk through the real loader — AC2-AC5.
//
// The class table next door proves each READER. This proves the
// promise the whole feature rests on: keryx reads other tools' files
// and never writes to them. That is not a convention to be remembered,
// it is a property to be measured, so the assertion is that every
// compat fixture is BYTE-IDENTICAL after the write commands have run.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpServers } from "./config";
import { addServer, removeServer, setServerEnabled } from "./store";

type Workspace = { home: string; cwd: string; configDir: string };

function workspace(): Workspace {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-compat-int-"));
  const w = {
    home: path.join(base, "home"),
    cwd: path.join(base, "proj"),
    configDir: path.join(base, "cfg"),
  };
  for (const dir of Object.values(w)) mkdirSync(dir, { recursive: true });
  return w;
}

function place(root: string, rel: string, text: string): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function load(w: Workspace) {
  return loadMcpServers({ cwd: w.cwd, gitRoot: w.cwd, configDir: w.configDir, home: w.home, env: {} });
}

const CURSOR_TEXT = `${JSON.stringify({ mcpServers: { shared: { command: "cursor-cmd" } } }, null, 2)}\n`;

describe("AC1 — every source contributes, tagged with where it came from", () => {
  test("all four sources at once, each with its own tag", () => {
    const w = workspace();
    place(w.cwd, ".cursor/mcp.json", JSON.stringify({ mcpServers: { fromCursor: { command: "a" } } }));
    place(w.cwd, ".mcp.json", JSON.stringify({ mcpServers: { fromMcpJson: { command: "b" } } }));
    place(w.home, ".claude.json", JSON.stringify({ mcpServers: { fromClaude: { command: "c" } } }));
    place(w.cwd, ".grok/config.toml", '[mcp_servers.fromGrok]\ncommand = "d"\n');

    const byName = new Map(load(w).servers.map((s) => [s.name, s.source]));
    expect(byName.get("fromCursor")).toBe("cursor");
    expect(byName.get("fromMcpJson")).toBe("mcp.json");
    expect(byName.get("fromClaude")).toBe("claude");
    expect(byName.get("fromGrok")).toBe("grok");
  });

  test("BOUNDARY — with no compat files at all, nothing appears", () => {
    // Without this, the loader could be inventing servers.
    expect(load(workspace()).servers).toEqual([]);
  });

  test("compat: false reads native only", () => {
    const w = workspace();
    place(w.cwd, ".cursor/mcp.json", CURSOR_TEXT);
    const off = loadMcpServers({ cwd: w.cwd, gitRoot: w.cwd, configDir: w.configDir, home: w.home, compat: false });
    expect(off.servers).toEqual([]);
  });

  test("an isolated configDir with no home does not read the real one", () => {
    // The hazard this option exists for, asserted rather than trusted:
    // 69 tests failed the moment compat landed, because every one that
    // injected a temp configDir also read the developer's real
    // ~/.claude.json. Results that depend on who ran them.
    const w = workspace();
    const isolated = loadMcpServers({ cwd: w.cwd, gitRoot: w.cwd, configDir: w.configDir });
    expect(isolated.servers).toEqual([]);
    expect(isolated.problems).toEqual([]);
  });
});

describe("AC4 — native beats compat, and compat has a fixed internal order", () => {
  test("a native user entry wins over every compat source", () => {
    const w = workspace();
    place(w.cwd, ".cursor/mcp.json", CURSOR_TEXT);
    place(w.configDir, "mcp-servers.json", JSON.stringify({ schemaVersion: 1, servers: { shared: { command: "native-user" } } }));

    const shared = load(w).servers.find((s) => s.name === "shared");
    expect(shared?.source).toBe("user");
    expect(shared?.command).toBe("native-user");
  });

  test("and a native PROJECT entry wins over the native user one", () => {
    const w = workspace();
    place(w.cwd, ".cursor/mcp.json", CURSOR_TEXT);
    place(w.configDir, "mcp-servers.json", JSON.stringify({ schemaVersion: 1, servers: { shared: { command: "native-user" } } }));
    place(w.cwd, ".keryx/mcp-servers.json", JSON.stringify({ schemaVersion: 1, servers: { shared: { command: "native-project" } } }));

    const shared = load(w).servers.find((s) => s.name === "shared");
    expect(shared?.source).toBe("project");
  });

  test("one name in EVERY compat source resolves to a stated winner", () => {
    // The order is arbitrary in that no external authority sets it, and
    // fixed in that it is written down and asserted here. An emergent
    // order cannot answer "which one won".
    const w = workspace();
    place(w.home, ".grok/config.toml", '[mcp_servers.shared]\ncommand = "grok-home"\n');
    place(w.cwd, ".grok/config.toml", '[mcp_servers.shared]\ncommand = "grok-proj"\n');
    place(w.home, ".claude.json", JSON.stringify({ mcpServers: { shared: { command: "claude" } } }));
    place(w.cwd, ".mcp.json", JSON.stringify({ mcpServers: { shared: { command: "mcpjson" } } }));
    place(w.home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { shared: { command: "cursor-home" } } }));
    place(w.cwd, ".cursor/mcp.json", JSON.stringify({ mcpServers: { shared: { command: "cursor-proj" } } }));

    const shared = load(w).servers.find((s) => s.name === "shared");
    expect(shared?.source).toBe("cursor");
    expect(shared?.command).toBe("cursor-proj");
  });

  test("BOUNDARY — project-local beats user-global WITHIN a source", () => {
    const w = workspace();
    place(w.home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { only: { command: "home" } } }));
    place(w.cwd, ".cursor/mcp.json", JSON.stringify({ mcpServers: { only: { command: "proj" } } }));
    expect(load(w).servers.find((s) => s.name === "only")?.command).toBe("proj");
  });
});

describe("AC2 — no command writes to a compat file", () => {
  test("add, remove, enable and disable all leave every fixture byte-identical", () => {
    const w = workspace();
    const files = [
      place(w.cwd, ".cursor/mcp.json", CURSOR_TEXT),
      place(w.cwd, ".mcp.json", `${JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2)}\n`),
      place(w.home, ".claude.json", `${JSON.stringify({ mcpServers: { claudey: { command: "y" } } }, null, 2)}\n`),
      place(w.cwd, ".grok/config.toml", '[mcp_servers.grokky]\ncommand = "z"\n'),
    ];
    const before = files.map((f) => readFileSync(f, "utf8"));

    addServer({ name: "native", entry: { command: "n" }, scope: "user", configDir: w.configDir, projectRoot: w.cwd });
    // A compat name: the toggle goes to the overlay, never to their file.
    setServerEnabled({ name: "shared", enabled: false, source: "cursor", configDir: w.configDir, projectRoot: w.cwd });
    setServerEnabled({ name: "grokky", enabled: true, source: "grok", configDir: w.configDir, projectRoot: w.cwd });
    removeServer({ name: "native", scope: "user", configDir: w.configDir, projectRoot: w.cwd });

    const after = files.map((f) => readFileSync(f, "utf8"));
    expect(after).toEqual(before);
  });

  test("BOUNDARY — the NATIVE file really was written, so the test above is not vacuous", () => {
    // Without this, a loader that did nothing at all would pass.
    const w = workspace();
    addServer({ name: "native", entry: { command: "n" }, scope: "user", configDir: w.configDir, projectRoot: w.cwd });
    expect(readFileSync(path.join(w.configDir, "mcp-servers.json"), "utf8")).toContain("native");
  });
});

describe("AC5 — disable works for a compat server, through the overlay", () => {
  test("the server is disabled and their file is untouched", () => {
    const w = workspace();
    const file = place(w.cwd, ".cursor/mcp.json", CURSOR_TEXT);

    expect(load(w).servers.find((s) => s.name === "shared")?.enabled).toBe(true);
    setServerEnabled({ name: "shared", enabled: false, source: "cursor", configDir: w.configDir, projectRoot: w.cwd });

    expect(load(w).servers.find((s) => s.name === "shared")?.enabled).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(CURSOR_TEXT);
  });

  test("and re-enabling lifts it again", () => {
    const w = workspace();
    place(w.cwd, ".cursor/mcp.json", CURSOR_TEXT);
    setServerEnabled({ name: "shared", enabled: false, source: "cursor", configDir: w.configDir, projectRoot: w.cwd });
    setServerEnabled({ name: "shared", enabled: true, source: "cursor", configDir: w.configDir, projectRoot: w.cwd });
    expect(load(w).servers.find((s) => s.name === "shared")?.enabled).toBe(true);
  });
});

describe("AC6 — a malformed compat file does not take the others down", () => {
  test("the broken one is reported and every other source still loads", () => {
    const w = workspace();
    place(w.cwd, ".cursor/mcp.json", "{not json");
    place(w.cwd, ".mcp.json", JSON.stringify({ mcpServers: { good: { command: "ok" } } }));
    place(w.configDir, "mcp-servers.json", JSON.stringify({ schemaVersion: 1, servers: { alsoGood: { command: "ok" } } }));

    const config = load(w);
    expect(config.servers.map((s) => s.name).sort()).toEqual(["alsoGood", "good"]);
    expect(config.problems.map((p) => p.message).join()).toContain("not valid JSON");
    expect(config.problems.some((p) => p.file.endsWith(path.join(".cursor", "mcp.json")))).toBe(true);
  });

  test("a Grok file with garbage INSIDE an mcp_servers table names the line", () => {
    const w = workspace();
    place(w.cwd, ".grok/config.toml", '[mcp_servers.a]\ncommand = "ok"\n)) nonsense ((\n');
    place(w.configDir, "mcp-servers.json", JSON.stringify({ schemaVersion: 1, servers: { fine: { command: "ok" } } }));

    const config = load(w);
    expect(config.servers.map((s) => s.name).sort()).toEqual(["a", "fine"]);
    expect(config.problems.map((p) => p.message).join()).toContain("line 3");
  });

  test("BOUNDARY — garbage with NO mcp_servers table is silence, by design", () => {
    // My first version of this test asserted a problem here, and the
    // design does not promise one. This reader claims `[mcp_servers.*]`
    // and nothing else — Grok's config has other sections — so a file
    // with no such table contributes nothing and says nothing, exactly
    // as a `.cursor/mcp.json` with no `mcpServers` does. Reporting it
    // would mean parsing all of TOML, which is the dependency this
    // reader exists to avoid.
    //
    // The test was wrong, not the code. Kept as a boundary so the
    // distinction is recorded rather than rediscovered.
    const w = workspace();
    place(w.cwd, ".grok/config.toml", "this is not toml { at all\n");
    place(w.configDir, "mcp-servers.json", JSON.stringify({ schemaVersion: 1, servers: { fine: { command: "ok" } } }));

    const config = load(w);
    expect(config.servers.map((s) => s.name)).toEqual(["fine"]);
    expect(config.problems).toEqual([]);
  });

  test("a compat entry that fails ENTRY validation is reported against its own file", () => {
    // Validated exactly like a native entry. A malformed compat entry
    // dropped in silence is indistinguishable from one never written,
    // and the operator would go looking in the wrong file.
    const w = workspace();
    const file = place(w.cwd, ".cursor/mcp.json", JSON.stringify({ mcpServers: { bad: { command: 42 } } }));
    const config = load(w);
    expect(config.servers).toEqual([]);
    expect(config.problems.some((p) => p.file === file)).toBe(true);
  });
});
