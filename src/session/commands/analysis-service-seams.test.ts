import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeJevRiskResult } from "../../commands/review-jev-risk";
import { computeJevScenariosResult } from "../../commands/review-jev-scenarios";
import { computeJevDocsResult } from "../../commands/review-jev-docs";
import { computeJevContractResult } from "../../commands/review-jev-contract";
import { computeJevTriageResult } from "../../commands/review-jev-triage";
import { computeJevRulesResult } from "../../commands/review-jev-rules";
import { computeJevCommentsResult } from "../../commands/review-jev-comments";
import { runConformForTarget } from "../../tui/conform-source";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const result = await mkdtemp(path.join(tmpdir(), "native-analysis-seam-")); roots.push(result); return result; }

test("existing analysis services stop an already cancelled remote operation before discovery or provider effects", async () => {
  const cwd = await root(); let discovered = false;
  const shared = { cwd, targetLabel: "native-fixture", regions: [], allChangedFiles: [], signal: AbortSignal.abort(), env: { OPENROUTER_API_KEY: "fixture-key-never-used" }, dir: cwd };
  const invocations = [
    () => computeJevRiskResult(shared),
    () => computeJevScenariosResult({ ...shared, discoverScenarios: async () => { discovered = true; return []; } }),
    () => computeJevDocsResult(shared),
    () => computeJevContractResult({ ...shared, description: "", diffText: "" }),
    () => computeJevTriageResult({ ...shared, findingsRaw: [] }),
    () => computeJevRulesResult(shared),
    () => computeJevCommentsResult({ ...shared, repo: "fixture/repo", number: 1,
      prPort: { pr: async () => { throw new Error("cancelled-before-pr-read"); } },
      factsPort: { commitsTouching: async () => [], resolvedThreadIds: async () => new Set<string>() } }),
  ];
  for (const invoke of invocations) await expect(invoke()).rejects.toMatchObject({ name: "AbortError" });
  expect(discovered).toBe(false);
});

test("conformance source observes cancellation before project setup or reference reads", async () => {
  const cwd = await root(); await mkdir(path.join(cwd, ".metaproject"));
  await writeFile(path.join(cwd, ".metaproject/tasks.config.json"), JSON.stringify({ review: { jev: { conform: false } } }));
  expect(await runConformForTarget(cwd, "not-read.md", { id: "diff:working", kind: "diff", label: "working diff" }, AbortSignal.abort())).toMatchObject({ ok: false, reason: "Conformance was cancelled." });
});

test("CI setup reader accepts an explicit cancellation boundary without reading ambient user credentials", async () => {
  const cwd = await root(); await mkdir(path.join(cwd, ".metaproject"));
  await writeFile(path.join(cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { ci_triage: false } } }));
  const file = path.resolve(import.meta.dir, "../../tui/ci-triage-source.ts");
  const source = `import {loadCiTriageList} from ${JSON.stringify(file)};
    const result=await loadCiTriageList(${JSON.stringify(cwd)},async()=>{throw new Error("unexpected-GitHub-call");},{env:{OPENROUTER_API_KEY:"explicit-fixture-key"},dir:${JSON.stringify(cwd)},signal:AbortSignal.abort()});
    if(result.note!=="CI inspection was cancelled.")throw new Error("cancellation-not-observed");`;
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--eval", source], { cwd, env: { PATH: process.env.PATH ?? "", OPENROUTER_API_KEY: "ambient-fixture-key" }, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect({ code, stderr }).toMatchObject({ code: 0 });
});

test("risk service uses its explicit project/config/env and forwards cancellation without touching ambient credentials", async () => {
  const cwd = await root(); const blocked = await root(); const dir = await root();
  for (const [base, external] of [[cwd, "on"], [blocked, "off"]] as const) {
    await mkdir(path.join(base, ".metaproject")); await writeFile(path.join(base, ".metaproject/tasks.config.json"), JSON.stringify({ external }));
  }
  const service = path.resolve(import.meta.dir, "../../commands/review-jev-risk.ts");
  const scope = path.resolve(import.meta.dir, "../../review/scope.ts");
  const diff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-export const a = 1;", "+export const a = 2;", ""].join("\n");
  const source = `import { computeJevRiskResult } from ${JSON.stringify(service)};
    import { buildReviewScope } from ${JSON.stringify(scope)};
    const diff = ${JSON.stringify(diff)};
    const s = buildReviewScope(diff); let calls=0;
    const controller = new AbortController();
    const fetchFn = Object.assign(async (_url, init) => {
      calls++; if (new Headers(init.headers).get("Authorization") !== "Bearer explicit-fixture-key") throw new Error("wrong-fixture-identity");
      if (!init.signal) throw new Error("missing-abort-signal");
      const q=JSON.parse(init.body).questions;
      return new Response(JSON.stringify({answers:Object.fromEntries(Object.keys(q).map(k=>[k,{type:"noul",noul:0.1}])),usage:{input_tokens:5,output_tokens:2,cost:0.01}}));
    }, {preconnect(){}});
    await computeJevRiskResult({cwd:${JSON.stringify(cwd)},dir:${JSON.stringify(dir)},env:{OPENROUTER_API_KEY:"explicit-fixture-key"},signal:controller.signal,regions:s.regions,allChangedFiles:s.files,targetLabel:"fixture",maxCalls:64,fetchFn});
    if(calls===0) throw new Error("expected-real-service-provider-call"); console.log("explicit-analysis-port-pass");`;
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "--eval", source], { cwd: blocked, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, stderr }).toMatchObject({ code: 0 }); expect(stdout).toContain("explicit-analysis-port-pass");
});
