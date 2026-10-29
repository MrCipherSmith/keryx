import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowServiceDeps } from "../../commands/flow";
import { acCheckCachePath, runCheckAc } from "../../commands/flow-check-ac";
import { createFlowService, renderAcCheckReport } from "../../flow/service";
import { acCheckCommands, executeAcCheck } from "./ac-check";
import { createAnalysisReadPorts } from "./analysis-read-ports";
import type { SessionCommandInspection } from "./effects";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const gitEnv = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
async function git(cwd: string, args: string[]) { expect(await Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "ignore", stderr: "ignore" }).exited).toBe(0); }
/** A committed checkout with one frozen local Flow whose base is the checkout's own HEAD, and one draft Flow. */
async function checkout() {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-native-ac-check-")); roots.push(cwd);
  await git(cwd, ["init", "-q"]); await writeFile(path.join(cwd, "seed.txt"), "seed\n");
  const service = createFlowService(flowServiceDeps());
  const draft = await service.init({ cwd, title: "Draft" });
  const frozen = await service.init({ cwd, title: "Frozen", baseBranch: "HEAD" });
  await writeFile(path.join(cwd, ".metaproject", "flows", path.basename(frozen.dir), "acceptance-criteria.md"), "# Acceptance Criteria\n\n## Criteria\n\n- AC1: `seed.txt` keeps its seed line.\n- AC2: Live check confirms the real endpoint.\n");
  await service.freeze({ cwd, id: frozen.flow.id });
  await git(cwd, ["add", "."]); await git(cwd, ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  return { cwd, draft: draft.flow.id, frozen: frozen.flow.id, frozenDir: path.basename(frozen.dir) };
}
/** The host's inspection scope: the owned git read port over real git, recording every argv it runs. */
function inspection(cwd: string, ran: (readonly string[])[], signal = new AbortController().signal): SessionCommandInspection {
  const ports = createAnalysisReadPorts({ cwd, runOwned: async () => { throw new Error("not-used"); }, runOwnedGit: async (argv) => {
    ran.push(argv); const proc = Bun.spawn([...argv], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); return { stdout, stderr, exitCode };
  } });
  return { signal, beforeAction: async () => {}, analysisRead: { ciSpawn: async () => { throw new Error("not-used"); }, acCheckGit: ports.acCheckGit } };
}

test("ac.check reports exactly the deterministic check the TUI runs without Jev, through the hardened owned git read, writing no cache", async () => {
  const f = await checkout(); const ran: (readonly string[])[] = [];
  // The project opts in to Jev: natively it is still never asked (a security-local setup boundary).
  await writeFile(path.join(f.cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));
  const native = await executeAcCheck({ cwd: f.cwd, inspection: inspection(f.cwd, ran) }, { flowId: f.frozen });
  if (!native.ok) throw new Error(JSON.stringify(native));
  const data = native.data as { flowId: string; jevAsked: boolean; cached: boolean; at: string; criteriaChecksum: string; diffHash: string; text: string; verdicts: unknown[] };
  expect(data).toMatchObject({ flowId: f.frozen, jevAsked: false, cached: false });
  expect(ran.map((argv) => argv.slice(0, 4))).toEqual([["git", "--no-pager", "merge-base", "HEAD"], ["git", "--no-pager", "diff", "--no-ext-diff"]]);
  expect(existsSync(acCheckCachePath(f.cwd, f.frozenDir))).toBe(false);
  // The TUI's own run of the same Flow without a credential: the same verdicts and report, apart from when it ran.
  const local = await runCheckAc(f.cwd, f.frozen, { askJev: false, noCache: true, persist: false });
  expect(data.verdicts).toEqual(JSON.parse(JSON.stringify(local.verdicts)));
  expect(data.text).toBe(renderAcCheckReport({ flowId: local.flowId, verdicts: local.verdicts, jevAsked: false, at: data.at, criteriaChecksum: local.criteriaChecksum, diffHash: local.diffHash }));
});

test("ac.check refuses with the check's own words, and attempts nothing without the owned read or with a bad request", async () => {
  const f = await checkout(); const ran: (readonly string[])[] = [];
  expect(await executeAcCheck({ cwd: f.cwd, inspection: inspection(f.cwd, ran) }, { flowId: f.draft })).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringMatching(/^acceptance-criteria check failed: .*not frozen/) } });
  expect(await executeAcCheck({ cwd: f.cwd, inspection: inspection(f.cwd, ran) }, { flowId: "999" })).toMatchObject({ ok: false, error: { code: "refused" } });
  expect(await executeAcCheck({ cwd: f.cwd }, { flowId: f.frozen })).toMatchObject({ ok: false, error: { code: "implementation-gap" } });
  expect(await executeAcCheck({ cwd: f.cwd, inspection: inspection(f.cwd, ran) }, {})).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  const cancelled = new AbortController(); cancelled.abort();
  expect(await executeAcCheck({ cwd: f.cwd, inspection: inspection(f.cwd, ran, cancelled.signal) }, { flowId: f.frozen })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(ran).toEqual([]);
});

test("ac.check is an available read with its Flow named, never a mutation", () => {
  expect(acCheckCommands().map(({ entry }) => entry)).toMatchObject([{ commandName: "ac.check", mutationClass: "read", busyPolicy: "read-only", confirmation: "none", availability: "available",
    inputSchema: { required: ["flowId"] } }]);
});
