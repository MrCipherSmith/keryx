import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowServiceDeps } from "../../commands/flow";
import { createFlowService } from "../../flow/service";
import { PROJECT_CONTEXT_CONFIG_REFUSAL } from "../../tui/project-context-inspector";
import { runFlowOriginForShell } from "../../tui/flow-origin-command";
import type { SessionCommandEffect } from "./effects";
import { executeProjectRecord, projectRecordCommands } from "./project-records";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function checkout() { const cwd = await mkdtemp(path.join(tmpdir(), "keryx-native-records-")); roots.push(cwd); return cwd; }
/** The owned-effect hook as the host gives it to a command: it records exactly which paths each write names. */
function effect(mutations: { kind: string; paths: readonly string[] }[]): SessionCommandEffect {
  return { runId: "run", turnId: "turn", association: { mode: "ad-hoc", profileConsentVersion: 1 }, snapshot: {} as SessionCommandEffect["snapshot"], signal: new AbortController().signal,
    beforeAction: async () => {}, mutate: async (kind, paths, write) => { mutations.push({ kind, paths }); return write(); },
    policy: { profileId: "test", fingerprint: "a".repeat(64), allowedTools: [], maxRounds: 1, maxToolCalls: 1 }, progress: () => {}, usage: () => {} };
}

test("projectctx.set writes the enforcement mode the TUI writes, as one owned write of exactly the project config", async () => {
  const cwd = await checkout(); const mutations: { kind: string; paths: readonly string[] }[] = [];
  await mkdir(path.join(cwd, ".metaproject")); await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ keep: true }));
  expect(await executeProjectRecord({ cwd, effect: effect(mutations) }, "projectctx.set", { mode: "block" })).toEqual({ ok: true, source: "local-native", data: { enforcement: "block", text: "ProjectCtx: block" } });
  expect(mutations).toEqual([{ kind: "project-record", paths: [".metaproject/tasks.config.json"] }]);
  expect(JSON.parse(await readFile(path.join(cwd, ".metaproject", "tasks.config.json"), "utf8"))).toEqual({ keep: true, gdskills: { projectContext: { enforcement: "block" } } });
});

test("projectctx.set refuses an unreadable config exactly as the TUI does, and never writes outside an admitted run", async () => {
  const cwd = await checkout(); const mutations: { kind: string; paths: readonly string[] }[] = [];
  await mkdir(path.join(cwd, ".metaproject")); await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), "{ not json");
  expect(await executeProjectRecord({ cwd, effect: effect(mutations) }, "projectctx.set", { mode: "warn" })).toMatchObject({ ok: false, error: { code: "refused", message: PROJECT_CONTEXT_CONFIG_REFUSAL } });
  expect(await executeProjectRecord({ cwd }, "projectctx.set", { mode: "warn" })).toMatchObject({ ok: false, error: { code: "not-admitted" } });
  expect(await executeProjectRecord({ cwd, effect: effect(mutations) }, "projectctx.set", { mode: "strict" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(mutations).toEqual([]); expect(await readFile(path.join(cwd, ".metaproject", "tasks.config.json"), "utf8")).toBe("{ not json");
});

test("flow origin set and summary go through the flow service exactly as /flow origin does, writing only that Flow's record", async () => {
  const cwd = await checkout(); const service = createFlowService(flowServiceDeps()); const mutations: { kind: string; paths: readonly string[] }[] = [];
  expect(await executeProjectRecord({ cwd }, "flow.origins", {}, service)).toMatchObject({ ok: true, data: { text: "No flows." } });
  const created = await service.init({ cwd, title: "Native parity" }); const dir = path.basename(created.dir);
  const set = await executeProjectRecord({ cwd, effect: effect(mutations) }, "flow.origin.set", { flowId: created.flow.id, kind: "human-request", reason: "asked in chat", quote: "Ship the parity fixture", source: "hub-session" }, service);
  expect(set).toMatchObject({ ok: true, data: { flowId: created.flow.id, previous: "unknown", next: "human-request", changed: true } });
  expect(mutations).toEqual([{ kind: "project-record", paths: [`.metaproject/flows/${dir}/flow.json`, `.metaproject/flows/${dir}/journal.md`] }]);
  // The TUI's own text for the change, and the TUI then sees the origin the native set wrote.
  expect(set.ok && (set.data as { text: string }).text).toStartWith(`origin unknown -> human-request\n${created.flow.id}`);
  expect(await runFlowOriginForShell(cwd, `/flow origin ${created.flow.id} human-request --reason "asked in chat"`, service)).toStartWith("origin already human-request; nothing written");
  expect(await executeProjectRecord({ cwd }, "flow.origins", {}, service)).toMatchObject({ ok: true, data: { text: await runFlowOriginForShell(cwd, "/flow origin", service) } });
  // Missing evidence is the service's own note, written nowhere; an unknown Flow and a multi-line reason are refused before any owned effect.
  const note = await executeProjectRecord({ cwd, effect: effect(mutations) }, "flow.origin.set", { flowId: created.flow.id, kind: "agent-finding", reason: "seen" }, service);
  expect(note).toMatchObject({ ok: true, data: { changed: false, next: "human-request" } });
  expect(note.ok && (note.data as { text: string }).text).toContain("Nothing written; origin stays human-request.");
  const before = mutations.length;
  expect(await executeProjectRecord({ cwd, effect: effect(mutations) }, "flow.origin.set", { flowId: "999", kind: "unknown", reason: "x" }, service)).toMatchObject({ ok: false, error: { code: "not-found", message: expect.stringContaining("Flow not found: 999") } });
  expect(await executeProjectRecord({ cwd, effect: effect(mutations) }, "flow.origin.set", { flowId: created.flow.id, kind: "unknown", reason: "two\nlines" }, service)).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(mutations.length).toBe(before);
});

test("record writes are workspace-class runs; the origin summary is a read", () => {
  const entries = Object.fromEntries(projectRecordCommands().map((row) => [row.entry.commandName, row.entry]));
  for (const name of ["projectctx.set", "flow.origin.set"]) expect(entries[name]).toMatchObject({ mutationClass: "workspace", busyPolicy: "reject", confirmation: "none", availability: "available", states: ["idle"] });
  expect(entries["flow.origins"]).toMatchObject({ mutationClass: "read", busyPolicy: "read-only", availability: "available" });
});
