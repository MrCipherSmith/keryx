import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { validateAgainstSchema } from "../contracts/validator";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory } from "../session/store";
import { createEvidenceRuntime } from "./runtime";
import { createAutomaticEvidenceRecall } from "./automatic";
import { OpenAiProvider } from "../harness/provider/openai/openai-provider";
import { runAgentTurn } from "../commands/agent";
import { collectingIo, makeDeps } from "../commands/agent.test-helpers";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "erl-boundary-"));
  await mkdir(path.join(root, ".metaproject"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, ".metaproject/metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }));
  return root;
}

test("real CLI indexes, serializes citations, rejects stale bytes and clears only derived data", async () => {
  const root = await fixture();
  const source = "quartz boundary evidence";
  const cli = path.resolve(import.meta.dir, "../cli.ts");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, "evidence", ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).not.toContain(source);
    expect(stdout).not.toContain(root);
    return { exit, payload: JSON.parse(stdout) };
  };
  try {
    const derivedPath = path.join(root, ".metaproject/evidence");
    for (const disabledConfig of [undefined, { schemaVersion: 1, enabled: false }]) {
      if (disabledConfig) await writeFile(path.join(root, ".metaproject/evidence.json"), JSON.stringify(disabledConfig));
      for (const args of [["status", "--json"], ["search", "quartz", "--json"], ["index"]]) {
        const result = await run(...args);
        expect(result.exit).toBe(0);
        expect(result.payload.code).toBe("disabled");
        expect(JSON.stringify(result.payload)).not.toContain(source);
      }
      expect(await readdir(derivedPath).catch(() => undefined)).toBeUndefined();
    }
    await writeFile(path.join(root, ".metaproject/evidence.json"), JSON.stringify({ schemaVersion: 1, enabled: true, roots: ["docs"] }));
    await writeFile(path.join(root, "docs/a.txt"), source);
    expect((await run("status", "--json")).payload.code).toBe("index-absent");
    expect((await run("index", "--full")).exit).toBe(0);
    const derived = path.join(root, ".metaproject/evidence");
    const snapshot = async (): Promise<Record<string, string>> => {
      const files: [string, string][] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile()) files.push([path.relative(derived, file), (await readFile(file)).toString("hex")]);
        }
      };
      await walk(derived); return Object.fromEntries(files);
    };
    const before = await snapshot();
    expect(JSON.stringify((await run("status", "--json")).payload)).not.toContain(source);
    const found = await run("search", "quartz", "--json");
    expect(found.exit).toBe(0);
    expect(found.payload.code).toBe("ok");
    expect(found.payload.items).toHaveLength(1);
    expect(found.payload.items[0].text).toBe(source);
    expect(found.payload.items[0].locator.kind).toBe("file");
    expect(found.payload.items[0].sourcePath).toBe("docs/a.txt");
    expect(found.payload.items[0].sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(validateAgainstSchema("search-result.schema.json", found.payload, {
      schemaDir: path.resolve(import.meta.dir, "../../docs/requirements/keryx-evidence-retrieval/schemas"),
    }).valid).toBe(true);
    expect(await snapshot()).toEqual(before);
    await writeFile(path.join(root, "docs/a.txt"), "replacement private bytes");
    const stale = await run("search", "quartz", "--json");
    expect(stale.exit).toBe(1);
    expect(stale.payload.items).toEqual([]);
    expect(JSON.stringify(stale.payload)).not.toContain("replacement private");
    await rm(path.join(root, "docs/a.txt"));
    expect((await run("search", "quartz", "--json")).payload.items).toEqual([]);
    await writeFile(path.join(root, "docs/a.txt"), "replacement private bytes");
    await writeFile(path.join(derived, "ledger.json"), "private-broken-ledger");
    const corrupt = await run("search", "quartz", "--json");
    expect(corrupt.exit).toBe(1);
    expect(corrupt.payload.items).toEqual([]);
    expect(JSON.stringify(corrupt.payload)).not.toContain(source);
    expect(JSON.stringify(corrupt.payload)).not.toContain("private-broken-ledger");
    await writeFile(path.join(derived, "ledger.json"), Buffer.from(before["ledger.json"]!, "hex"));
    expect((await run("clear")).exit).toBe(0);
    expect((await run("status")).payload.code).toBe("index-absent");
    expect((await run("search", "quartz", "--json")).payload.code).toBe("index-absent");
    expect(await readFile(path.join(root, "docs/a.txt"), "utf8")).toBe("replacement private bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120000);

test("real archive owner revocation survives runtime restart and derived clear", async () => {
  const root = await fixture(), dataDir = path.join(root, "data");
  const config = { schemaVersion: 1, enabled: true, sessionArchives: true, roots: ["docs"] };
  const session = createSession({ cwd: root, dataDir, id: "boundary.session" });
  persistHistory(session, [{ role: "user", content: "quartz archived decision" }]);
  const archive = path.join(session.dir, "archive.jsonl");
  const bytes = await readFile(archive);
  const options = { projectRoot: root, dataDir, config,
    scannerFactory: async () => async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const }),
  };
  let loaded = await createEvidenceRuntime(options);
  try {
    if (!loaded.ok) throw Error("fixture runtime unavailable");
    expect((await loaded.runtime.build([{ kind: "session-archive", id: session.summary.id }])).code).toBe("ok");
    const found = await loaded.runtime.searchPublic("quartz", value => value);
    expect(found.code).toBe("ok");
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.locator.kind).toBe("archive");
    await writeFile(path.join(root, ".metaproject/evidence.json"), JSON.stringify(config));
    const invokeTool = async (owner = root) => {
      const script = `import { createEvidenceSearchTool } from ${JSON.stringify(path.resolve(import.meta.dir, "tool.ts"))};
        console.log(JSON.stringify(await createEvidenceSearchTool(process.env.ERL_OWNER!).invoke({query:"quartz"})));`;
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: root, env: { ...process.env, KERYX_DATA_DIR: dataDir, ERL_OWNER: owner }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).not.toContain("archived decision");
      const result = JSON.parse(stdout);
      expect(result.untrusted).toBe(true);
      return JSON.parse(result.output);
    };
    const toolFound = await invokeTool();
    expect(toolFound.items[0]?.text).toBe("quartz archived decision");
    expect(toolFound.items[0]?.trustedAsPolicy).toBe(false);
    expect(validateAgainstSchema("search-result.schema.json", toolFound, {
      schemaDir: path.resolve(import.meta.dir, "../../docs/requirements/keryx-evidence-retrieval/schemas"),
    }).valid).toBe(true);
    const other = await fixture();
    await writeFile(path.join(other, ".metaproject/evidence.json"), JSON.stringify(config));
    const summaryPath = path.join(session.dir, "summary.json");
    const originalSummary = await readFile(summaryPath);
    try {
      try {
        await writeFile(summaryPath, JSON.stringify({ ...JSON.parse(originalSummary.toString()), projectPath: other }));
        const denied = await invokeTool();
        expect(denied.items).toEqual([]);
        expect(JSON.stringify(denied)).not.toContain("quartz archived decision");
      } finally { await writeFile(summaryPath, originalSummary); }
      expect((await invokeTool()).items[0]?.text).toBe("quartz archived decision");
      const foreignProjectResult = await invokeTool(other);
      expect(foreignProjectResult.items).toEqual([]);
      expect(JSON.stringify(foreignProjectResult)).not.toContain("quartz archived decision");
    } finally { await rm(other, { recursive: true, force: true }); }

    const runtime = loaded.runtime;
    const bodies: string[] = [];
    const provider = new OpenAiProvider({ grant: { network: true, apiKey: "synthetic" }, fetch: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("", { status: 500 });
    }) as typeof fetch });
    const deps = makeDeps(provider, { contextWindow: 32000,
      automaticEvidence: async (query, reserveBytes, signal) => createAutomaticEvidenceRecall({
        projectRoot: root, config: { ...config, automatic: true }, query, reserveBytes,
        ...(signal === undefined ? {} : { signal }),
        search: async (q, handoff, abort) => { await runtime.searchPublic(q, handoff, abort); },
      }),
    });
    await runAgentTurn(collectingIo().io, deps, [], "quartz");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("quartz archived decision");
    const controller = new AbortController();
    let handoffs = 0, retrievals = 0;
    const cancelledDeps = makeDeps(provider, { contextWindow: 32000,
      automaticEvidence: async (query, reserveBytes) => createAutomaticEvidenceRecall({
        projectRoot: root, config: { ...config, automatic: true }, query, reserveBytes,
        signal: controller.signal,
        search: async (q, handoff, abort) => {
          retrievals++;
          await runtime.searchPublic(q, result => {
            handoffs++;
            controller.abort();
            handoff(result);
          }, abort);
        },
      }),
    });
    await runAgentTurn(collectingIo().io, cancelledDeps, [], "quartz");
    expect(handoffs).toBe(1);
    expect(retrievals).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1]!).instructions).toStartWith("sys");
    expect(bodies[1]).toContain("quartz");
    expect(bodies[1]).not.toContain("historical-evidence");
    expect(bodies[1]).not.toContain("quartz archived decision");
    expect(await loaded.runtime.revokeSessionEvidence(session.summary.id)).toEqual({ code: "revoked" });
    await runAgentTurn(collectingIo().io, deps, [], "quartz");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toContain("quartz archived decision");
    expect(bodies[2]).not.toContain("historical-evidence");
    const revoked = await loaded.runtime.searchPublic("quartz", value => value);
    expect(revoked.items).toEqual([]);
    expect((await invokeTool()).items).toEqual([]);
    expect(JSON.stringify(revoked)).not.toContain("archived decision");
    expect((await loaded.runtime.clear()).code).toBe("ok");
    loaded.runtime.close();
    loaded = await createEvidenceRuntime(options);
    if (!loaded.ok) throw Error("fixture restart unavailable");
    expect((await invokeTool()).items).toEqual([]);
    expect((await loaded.runtime.build([{ kind: "session-archive", id: session.summary.id }])).code).not.toBe("ok");
    expect((await loaded.runtime.searchPublic("quartz", value => value)).items).toEqual([]);
    await runAgentTurn(collectingIo().io, deps, [], "quartz");
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).not.toContain("historical-evidence");
    expect(bodies[3]).not.toContain("quartz archived decision");
    expect(await readFile(archive)).toEqual(bytes);
  } finally {
    if (loaded.ok) loaded.runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);


test("archive owner drains a gated archive build and prevents late publication", async () => {
  const root = await fixture(), dataDir = path.join(root, "data");
  const config = { schemaVersion: 1, enabled: true, sessionArchives: true };
  const session = createSession({ cwd: root, dataDir, id: "gated.archive" });
  persistHistory(session, [{ role: "user", content: "quartz pending archive evidence" }]);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const loaded = await createEvidenceRuntime({ projectRoot: root, dataDir, config,
    scannerFactory: async () => {
      entered(); await gate;
      return async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
    },
  });
  if (!loaded.ok) throw Error("fixture runtime unavailable");
  const pending = loaded.runtime.build([{ kind: "session-archive", id: session.summary.id }]);
  let revocation: ReturnType<typeof loaded.runtime.revokeSessionEvidence> | undefined;
  try {
    await Promise.race([ready, pending.then(() => { throw Error("archive missed scanner gate"); })]);
    let finished = false;
    revocation = loaded.runtime.revokeSessionEvidence(session.summary.id).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    release();
    expect((await pending).code).not.toBe("ok");
    expect((await revocation).code).toBe("revoked");
    expect(loaded.runtime.status().code).toBe("index-absent");
    expect((await loaded.runtime.searchPublic("quartz", value => value)).items).toEqual([]);
  } finally {
    release(); await pending; await revocation;
    loaded.runtime.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
