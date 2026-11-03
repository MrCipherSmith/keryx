// Cross-process lost-update tests for the user-global stores written through
// `updateConfigFile` (`./config-update.ts`): auth.json, permissions.json,
// hooks-trust.json and routing-config-trust.json.
//
// Each test spawns REAL separate `bun` processes against one temp config dir,
// held to a shared start time, every one calling the production writers. An
// in-process interleaving cannot show this defect: the writers are
// synchronous, so inside one process they never overlap. Before the store
// lock, the same runs kept 310 of 600 API keys, 16 of 200 allow patterns and
// 34 of 200 trust entries, and put a spent refresh token back.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-store-race-"));
  roots.push(root);
  return root;
}

const here = import.meta.dir;
const mod = (rel: string): string => JSON.stringify(path.join(here, rel));

// One worker script for every role. It is written to the temp root, not kept
// in src/, and imports the production modules by absolute path.
const WORKER = `
import { saveApiKey, saveShellConfig } from ${mod("shell-config.ts")};
import { saveOAuthGrant } from ${mod("oauth/grants.ts")};
import { allowShellPattern, removeShellPattern } from ${mod("shell-permissions.ts")};
import { recordProjectHooksTrust, revokeProjectHooksTrust } from ${mod("../harness/hooks/trust.ts")};
import { approveProjectRouting } from ${mod("../harness/routing/trust.ts")};

const [dir, role, prefix, nRaw, extra] = process.argv.slice(2);
const n = Number(nRaw);
const start = Number(process.env.START_AT ?? "0");
while (Date.now() < start) {}
for (let i = 0; i < n; i++) {
  if (role === "key") saveApiKey(prefix + "_" + i, "v" + i, dir);
  else if (role === "grant") saveOAuthGrant("prov", { method: "device-code", access: "at-" + i, refresh: "rt-" + i, obtainedAt: "t" }, dir);
  else if (role === "setting") saveShellConfig({ reasoningEffort: prefix + i }, dir);
  else if (role === "allow") allowShellPattern("echo " + prefix + i, dir);
  else if (role === "remove") { Bun.sleepSync(Number(extra)); removeShellPattern(prefix, dir); }
  else if (role === "trust") recordProjectHooksTrust({ trustRoot: extra + "/" + prefix + i, digest: "sha256:x", hookIds: ["h"], configDir: dir });
  else if (role === "untrust") { Bun.sleepSync(Number(prefix)); revokeProjectHooksTrust({ trustRoot: extra, configDir: dir }); }
  else if (role === "route") approveProjectRouting(extra + "/" + prefix + i, { review: { model: "m" } }, dir);
}
`;

interface Job {
  role: string;
  prefix: string;
  n: number;
  extra?: string;
}

async function runConcurrently(root: string, dir: string, jobs: Job[]): Promise<void> {
  const script = path.join(root, "worker.ts");
  writeFileSync(script, WORKER);
  // Far enough ahead that every process has loaded its modules before it starts.
  const startAt = String(Date.now() + 1_500);
  const procs = jobs.map((job) =>
    Bun.spawn(["bun", script, dir, job.role, job.prefix, String(job.n), job.extra ?? ""], {
      env: { ...process.env, START_AT: startAt },
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const codes = await Promise.all(procs.map((proc) => proc.exited));
  for (const [index, code] of codes.entries()) {
    if (code !== 0) throw new Error(`worker ${jobs[index]!.role} exited ${code}: ${await new Response(procs[index]!.stderr).text()}`);
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("auth.json: two processes saving API keys at once keep every key", async () => {
  const root = tempRoot();
  const dir = path.join(root, "cfg");
  await runConcurrently(root, dir, [
    { role: "key", prefix: "A", n: 150 },
    { role: "key", prefix: "B", n: 150 },
  ]);
  const keys = readJson(path.join(dir, "auth.json")).apiKeys as Record<string, string>;
  expect(Object.keys(keys).length).toBe(300);
}, 60_000);

test("auth.json: a settings write in another process never restores a refresh token the grant writer replaced", async () => {
  const root = tempRoot();
  const dir = path.join(root, "cfg");
  await runConcurrently(root, dir, [
    { role: "grant", prefix: "g", n: 120 },
    { role: "setting", prefix: "s", n: 360 },
  ]);
  const saved = readJson(path.join(dir, "auth.json"));
  const grants = saved.oauthGrants as Record<string, { refresh: string }>;
  expect(grants.prov!.refresh).toBe("rt-119");
  expect(saved.reasoningEffort).toBe("s359");
}, 60_000);

test("permissions.json: four processes granting at once keep every pattern", async () => {
  const root = tempRoot();
  const dir = path.join(root, "cfg");
  await runConcurrently(root, dir, ["a", "b", "c", "d"].map((prefix) => ({ role: "allow", prefix, n: 50 })));
  const allow = readJson(path.join(dir, "permissions.json")).allow as string[];
  expect(new Set(allow).size).toBe(200);
}, 60_000);

test("permissions.json: a pattern removed while another process grants stays removed", async () => {
  const root = tempRoot();
  const dir = path.join(root, "cfg");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "permissions.json"), `${JSON.stringify({ allow: ["echo X"] })}\n`, { mode: 0o600 });
  await runConcurrently(root, dir, [
    { role: "allow", prefix: "z", n: 300 },
    { role: "remove", prefix: "echo X", n: 1, extra: "40" },
  ]);
  const allow = readJson(path.join(dir, "permissions.json")).allow as string[];
  expect(allow).not.toContain("echo X");
  expect(allow.length).toBe(300);
}, 60_000);

test("hooks-trust.json: parallel trusts keep every entry, and a revoke is not undone by them", async () => {
  const root = tempRoot();
  const dir = path.join(root, "cfg");
  const projects = path.join(root, "projects");
  mkdirSync(projects);
  const revoked = path.join(projects, "revoked");
  // Trusted first, then revoked by one process while three others trust.
  await runConcurrently(root, dir, [{ role: "trust", prefix: "revoked", n: 1, extra: projects }]);
  await runConcurrently(root, dir, [
    ...["a", "b", "c"].map((prefix) => ({ role: "trust", prefix, n: 40, extra: projects })),
    { role: "untrust", prefix: "60", n: 1, extra: `${revoked}0` },
  ]);
  const store = readJson(path.join(dir, "hooks-trust.json")).projects as Record<string, unknown>;
  expect(Object.keys(store).length).toBe(120);
  expect(Object.keys(store).some((key) => key.includes(`${path.sep}revoked0::`))).toBe(false);
}, 60_000);

test("routing-config-trust.json: parallel approvals keep every entry", async () => {
  const root = tempRoot();
  const dir = path.join(root, "cfg");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await runConcurrently(root, dir, ["a", "b", "c", "d"].map((prefix) => ({ role: "route", prefix, n: 30, extra: root })));
  const approvals = readJson(path.join(dir, "routing-config-trust.json")).approvals as Record<string, string>;
  expect(Object.keys(approvals).length).toBe(120);
}, 60_000);
