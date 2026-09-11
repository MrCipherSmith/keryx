// AC10 and AC11: the things this package promised NOT to do.
//
// Every assertion here is about an absence, and an absence is the hardest
// kind of claim to keep true — nothing fails when someone adds the thing.
//
// The first version of this file scanned source TEXT with regexes and was
// audited in the review of PR #522: four of its guards could be walked
// straight past. A multi-line `import {\n Client,\n} from "…sdk"` did not
// match, because the `from` line does not start with `import`. So did
// `export * from "…sdk"`. A `"/*"` inside a string literal opened a comment
// that swallowed the next violation whole, and `"a//b"` deleted the rest of
// its line. And the test asserting the store writes only three files checked
// that three functions EXIST, which says nothing about a fourth.
//
// So: the import guards now read the real module graph via
// `Bun.Transpiler.scan`, and the write guard drives the store and watches
// which paths are actually written. A regex over source is a claim about
// text; these are claims about the program.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_REGISTRY } from "../capability/registry";
import { addServer, removeServer, setServerEnabled } from "./store";
import { approveServer } from "./trust";
import { clearCredential, writeCredential } from "./credentials";
import type { ResolvedMcpServer } from "./config";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => path.join(dir, e.name));
}

/**
 * Every module specifier this file imports or re-exports, from the parser.
 *
 * `Bun.Transpiler.scan` returns the real edges — `import`, `import type`,
 * `export … from`, and `import()` (reported as `dynamic-import`, which is
 * how the SDK is legitimately loaded). No regex can be walked past, because
 * this is the same parse the runtime does.
 */
async function importsOf(file: string): Promise<Array<{ kind: string; path: string }>> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return transpiler.scan(await Bun.file(file).text()).imports;
}

describe("AC10 — no new capability flag", () => {
  test("CAPABILITY_REGISTRY gains no entry for MCP servers", () => {
    // Pinned so a later phase cannot add one without the decision being
    // visible in a diff to this test (D-10: no new `src/capability/`
    // ceiling).
    const ids = CAPABILITY_REGISTRY.map((descriptor) => descriptor.id);
    expect(ids.filter((id) => id.toLowerCase().includes("mcp"))).toEqual([]);
  });

  test("the registry is non-empty, so the assertion above is not vacuous", () => {
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
  });

  test("no file in src/mcp-servers/ imports the capability module", async () => {
    for (const file of productionFiles(HERE)) {
      const hits = (await importsOf(file)).filter((i) => i.path.includes("capability"));
      expect({ file: path.basename(file), hits }).toEqual({ file: path.basename(file), hits: [] });
    }
  });
});

describe("AC11 — the SDK is never a STATIC dependency", () => {
  test("no static import or re-export of the SDK, whatever syntax is used", async () => {
    // The SDK is an optional dependency: a static edge anywhere reachable
    // from the CLI entry breaks `keryx --help` on a machine that never
    // installed it. `client.ts` loads it through `loadCoreSdk`, which is a
    // dynamic import — allowed, and the distinction this test turns on.
    for (const file of productionFiles(HERE)) {
      const statics = (await importsOf(file))
        .filter((i) => i.path.startsWith("@modelcontextprotocol/sdk"))
        .filter((i) => i.kind !== "dynamic-import");
      expect({ file: path.basename(file), statics }).toEqual({ file: path.basename(file), statics: [] });
    }
  });

  test("nor anywhere else the CLI entry statically reaches", async () => {
    // Walk the real static graph from `cli.ts` through first-party files.
    // The per-file test above cannot see a static edge added in, say,
    // `src/commands/mcp-servers.ts`, which is on the `--help` path too.
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = [path.join(SRC, "cli.ts")];

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);

      for (const edge of await importsOf(file)) {
        if (edge.kind === "dynamic-import") continue;
        if (edge.path.startsWith("@modelcontextprotocol/sdk")) {
          offenders.push(`${path.relative(SRC, file)} → ${edge.path}`);
          continue;
        }
        if (!edge.path.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), edge.path);
        for (const candidate of [`${resolved}.ts`, path.join(resolved, "index.ts")]) {
          if (await Bun.file(candidate).exists()) {
            queue.push(candidate);
            break;
          }
        }
      }
    }

    // Non-vacuity: the walk really did reach this package.
    expect(seen.has(path.join(HERE, "config.ts"))).toBe(true);
    expect(offenders).toEqual([]);
  }, 30_000);

  test("the CLI starts and prints help", () => {
    // Weaker than the graph walk above (this machine HAS the SDK
    // installed, so a static import would resolve and this would still
    // pass) — kept because it catches a different class: a module that
    // parses but throws at load.
    const result = Bun.spawnSync({
      cmd: ["bun", path.join(SRC, "cli.ts"), "mcp", "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain("keryx mcp");
  }, 30_000);
});

describe("AC11 — this package writes no config it does not own", () => {
  test("driving every writer touches ONLY the three native files", () => {
    // Behavioural, not textual. The old version asserted that three path
    // builders exist, which a fourth writer passes untouched — an
    // exhaustiveness claim backed by presence checks.
    const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-writers-"));
    const configDir = path.join(base, "config");
    const projectRoot = path.join(base, "project");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    addServer({ name: "u", entry: { command: "x" }, scope: "user", configDir });
    addServer({ name: "p", entry: { command: "x" }, scope: "project", configDir, projectRoot });
    setServerEnabled({ name: "u", enabled: false, source: "user", configDir });
    removeServer({ name: "u", scope: "user", configDir });
    approveServer(
      {
        name: "p",
        source: "project",
        file: path.join(projectRoot, ".keryx", "mcp-servers.json"),
        enabled: true,
        command: "x",
      } as ResolvedMcpServer,
      configDir,
    );

    // The OAuth store is a writer too, and adding it without adding it
    // here is exactly the omission this test was rewritten to catch:
    // "a fourth writer passes untouched". P3b added two.
    writeCredential("u", "https://h/mcp", { tokens: { access_token: "t" } }, configDir);
    clearCredential("u", "https://h/mcp", configDir);

    const written = [...walk(base)]
      .map((f) => path.relative(base, f))
      // The lock file is transient by construction — `withFileLock`
      // removes it — but a crashed holder can leave one behind, and
      // its presence is not a claim about which config files exist.
      .filter((f) => !f.endsWith(".lock"))
      .sort();
    expect(written).toEqual([
      "config/mcp-credentials.json",
      "config/mcp-servers-disabled.json",
      "config/mcp-servers-trust.json",
      "config/mcp-servers.json",
      "project/.keryx/mcp-servers.json",
    ]);
  });

  test("no production file here imports a foreign config writer", async () => {
    for (const file of productionFiles(HERE)) {
      const hits = (await importsOf(file)).filter(
        (i) => i.path.includes("client-config") || i.path.includes("/mcp/") || i.path.includes("integrate"),
      );
      expect({ file: path.basename(file), hits }).toEqual({ file: path.basename(file), hits: [] });
    }
  });
});

describe("AC11 — the Codex specialist is untouched", () => {
  test("nothing here imports the Codex-specific module (D-12)", async () => {
    // Sharing `src/mcp-client/client.ts` is the point; reaching into the
    // Codex half is not. `client.ts` holds both, so this asserts on what
    // is BOUND, using the runtime module rather than source text.
    const codexOnly = ["connectCodexMcpClient", "gatedSuperviseCodexMcpRun"];
    for (const file of productionFiles(HERE)) {
      const source = await Bun.file(file).text();
      // Identifier use, not a mention: a word inside a comment or string is
      // documentation, and `\b…\s*\(` requires an actual call.
      const hits = codexOnly.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(stripStringsAndComments(source)));
      expect({ file: path.basename(file), hits }).toEqual({ file: path.basename(file), hits: [] });
    }
  });
});

/**
 * Blank out comments and string/template literals, character by character.
 *
 * A regex `replace` cannot do this: the audit showed `"/*"` inside a string
 * opening a comment that ran to the next `*` + `/`, and `"a//b"` deleting the
 * rest of its line. This walks the text once, tracking which construct it is
 * inside, so a delimiter inside a string is just a character.
 */
function stripStringsAndComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const ch = source[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
