import { afterEach, expect, spyOn, test } from "bun:test";
import { evidenceCommand } from "./evidence";
import type { PublicEvidenceSearchResult } from "../evidence/projection";
const log = spyOn(console, "log").mockImplementation(() => {});
const error = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => { log.mockClear(); error.mockClear(); process.exitCode = 0; });
function fixture() {
  const calls: string[] = [];
  const runtime = {
    async buildConfiguredFiles() { calls.push("index"); return { code: "ok", chunkCount: 1 }; },
    async searchPublic(query: string, send: (value: PublicEvidenceSearchResult) => void) {
      calls.push(`search:${query}`); send({ schemaVersion: 1, code: "no-match", coverage: "full",
        generation: null, items: [], diagnostics: [] });
    },
    status() { calls.push("status"); return { code: "index-absent", mode: "lexical", model: null }; },
    async clear() { calls.push("clear"); return { code: "ok" }; },
    async maintenance() { calls.push("maintenance"); return { code: "ok" }; },
    close() { calls.push("close"); },
  };
  return { calls, deps: { cwd: "/trusted", loadRuntime: async () => ({ ok: true as const, runtime }) } };
}
test("CLI search serializes in the runtime handoff and closes without mutations", async () => {
  const f = fixture(); await evidenceCommand(["search", "runtime evidence", "--json"], f.deps);
  expect(f.calls).toEqual(["search:runtime evidence", "close"]);
  expect(JSON.parse(String(log.mock.calls[0]?.[0])).code).toBe("no-match");
});
test("CLI exposes configured full-build, metadata status and derived clear", async () => {
  for (const command of [["index", "--full"], ["status"], ["clear"], ["maintenance"]]) {
    const f = fixture(); await evidenceCommand(command, f.deps);
    expect(f.calls).toEqual([command[0]!, "close"]);
  }
});
test("invalid arguments never load a runtime or echo arbitrary input", async () => {
  let loaded = 0;
  const deps = { loadRuntime: async () => { loaded++; throw Error("must not load"); } };
  for (const args of [["index", "private/path"], ["clear", "--force"], ["maintenance", "--force"], ["search"], ["search", "x", "--root", "private"], ["status", "secret"]]) {
    await evidenceCommand(args, deps); expect(process.exitCode).toBe(1);
  }
  expect(loaded).toBe(0);
  expect(JSON.stringify(error.mock.calls)).not.toContain("private");
});


test("CLI forwards --full to the owner runtime, but not on ordinary indexing", async () => {
  const flags: unknown[] = [];
  const f = fixture();
  const deps = { loadRuntime: async () => {
    const loaded = await f.deps.loadRuntime();
    return { ...loaded, runtime: { ...loaded.runtime,
      async buildConfiguredFiles(signal?: AbortSignal, forceFull?: boolean) {
        flags.push([signal, forceFull]); return { code: "ok" };
      },
    } };
  } };
  await evidenceCommand(["index", "--full"], deps);
  await evidenceCommand(["index"], deps);
  expect(flags).toEqual([[undefined, true], [undefined, false]]);
});
