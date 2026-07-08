import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { computeAffected } from "./affected";
import { loadGdgraphConfig } from "./config";
import { computeRepomap } from "./repomap";
import { loadGraph } from "./query";
import { resetWarnOnce, hasWarned } from "../capability/warn-once";

const ARTIFACTS = [
  "storage/nodes.jsonl",
  "storage/edges.jsonl",
  "artifacts/module-map.json",
  "artifacts/summary.md",
];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-fallback-"));
  await mkdir(path.join(root, "src", "feature"), { recursive: true });
  await writeFile(
    path.join(root, "src", "index.ts"),
    "import { value } from './feature/value';\nexport const app = value;\n",
  );
  await writeFile(path.join(root, "src", "feature", "value.ts"), "export const value = 1;\n");
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of ARTIFACTS) {
    out[rel] = await readFile(
      path.join(root, ".metaproject", "data", "gdgraph", rel),
      "utf8",
    );
  }
  return out;
}

test("AC4.1/AC4.2 — capability OFF: 4 legacy artifacts deterministic; no symbol files written", async () => {
  // Two fresh, identical projects, each built ONCE (a rebuild in the same dir is
  // pre-existingly non-deterministic because the build creates `.metaproject`,
  // which then appears in the summary's skipped-dirs — unrelated to this block).
  // Comparing two first-builds isolates the capability-off artifacts precisely.
  const a = await makeProject();
  const b = await makeProject();
  try {
    await buildGraph(a);
    await buildGraph(b);
    expect(await snapshot(b)).toEqual(await snapshot(a));

    for (const root of [a, b]) {
      const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
      expect(existsSync(path.join(storage, "symbols.jsonl"))).toBe(false);
      expect(existsSync(path.join(storage, "calls.jsonl"))).toBe(false);
    }
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("AC4.4 — no-network sandbox: build/affected/repomap open zero sockets", async () => {
  const root = await makeProject();
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  let socketAttempts = 0;
  let fetchAttempts = 0;

  net.Socket.prototype.connect = function connect(this: net.Socket) {
    socketAttempts += 1;
    // Never actually connect.
    return this;
  };
  // @ts-expect-error — deliberately override for the sandbox assertion.
  globalThis.fetch = async () => {
    fetchAttempts += 1;
    throw new Error("network blocked in sandbox");
  };

  try {
    await buildGraph(root);
    const config = await loadGdgraphConfig(root);
    const graph = await loadGraph(root);
    computeAffected(graph, "src/feature/value.ts", { depth: 3 });
    computeRepomap(graph, config, {});
    expect(socketAttempts).toBe(0);
    expect(fetchAttempts).toBe(0);
  } finally {
    net.Socket.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("AC4.3 — capability ENABLED but unavailable: exactly one warn, regex path, exit 0, no symbol files", async () => {
  const root = await makeProject();
  resetWarnOnce();
  try {
    // Enable the ceiling in the manifest but provide NO resolvable grammar and
    // no installed dep ⇒ resolveCapability degrades with a single warn-once.
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: {
            enabled: true,
            capabilities: [
              { id: "gdgraph.treesitter", enabled: true, kind: "ceiling", optionalDependency: "web-tree-sitter" },
            ],
          },
        },
      }),
    );

    let stderr = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;

    let exitCodeBefore = process.exitCode;
    try {
      await buildGraph(root);
    } finally {
      process.stderr.write = originalWrite;
    }

    // Build did not hard-fail (exitCode untouched by build).
    expect(process.exitCode).toBe(exitCodeBefore);
    // Exactly one capability degradation warning was emitted.
    const warnings = stderr.split("\n").filter((line) => line.includes("gdgraph.treesitter unavailable"));
    expect(warnings).toHaveLength(1);
    expect(hasWarned("gdgraph.treesitter")).toBe(true);

    // No symbol files were written (regex/scan path only).
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    expect(existsSync(path.join(storage, "symbols.jsonl"))).toBe(false);
    // The 4 legacy artifacts were still produced.
    for (const rel of ARTIFACTS) {
      const info = await stat(path.join(root, ".metaproject", "data", "gdgraph", rel));
      expect(info.isFile()).toBe(true);
    }
  } finally {
    resetWarnOnce();
    await rm(root, { recursive: true, force: true });
  }
});
