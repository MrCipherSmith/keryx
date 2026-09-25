// Flow 327 (Routing A2), item 5 — CLI tests for the profiles suffix of
// `keryx providers test` (AC13). Hermetic: every test uses a fresh
// `mkdtemp` dir, never the real `~/.local/share/keryx`.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStoredModelProfiles, modelProfilesFilePath, profileKey } from "../harness/routing/model-profile";
import { providersCommand } from "./providers";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-providers-model-profiles-"));
}

function fetchWithBody(body: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => body }) as Response) as unknown as typeof fetch;
}

async function capture(run: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await run();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const result = { stdout, stderr };
  process.exitCode = origExit;
  return result;
}

const OPENROUTER_BODY = {
  data: [
    { id: "openrouter/model-a", pricing: { prompt: "0.000003", completion: "0.000015" }, context_length: 200000 },
    { id: "openrouter/model-b", pricing: { prompt: "0.000001", completion: "0.000005" }, context_length: 32000 },
  ],
};

test("keryx providers test: a brand-new refresh mentions the profile counts in plain text (AC13)", async () => {
  const dir = tempDir();
  const { stdout } = await capture(() =>
    providersCommand(["test", "openrouter"], { fetch: fetchWithBody(OPENROUTER_BODY), env: {}, dir }),
  );
  const text = stdout.join("\n");
  expect(text).toContain("OpenRouter: ok — 2 model(s)");
  expect(text).toContain("(profiles: 2 added)");
});

test("keryx providers test --json: the profiles summary is included with added/changed/unavailable", async () => {
  const dir = tempDir();
  const { stdout } = await capture(() =>
    providersCommand(["test", "openrouter", "--json"], { fetch: fetchWithBody(OPENROUTER_BODY), env: {}, dir }),
  );
  const parsed = JSON.parse(stdout.join("")) as { profiles?: { added: number; changed: number; unavailable: number } };
  expect(parsed.profiles).toEqual({ added: 2, changed: 0, unavailable: 0 });
});

test("keryx providers test: a second identical refresh mentions nothing (no added/changed/unavailable)", async () => {
  const dir = tempDir();
  await capture(() => providersCommand(["test", "openrouter"], { fetch: fetchWithBody(OPENROUTER_BODY), env: {}, dir }));
  const { stdout } = await capture(() =>
    providersCommand(["test", "openrouter"], { fetch: fetchWithBody(OPENROUTER_BODY), env: {}, dir }),
  );
  const text = stdout.join("\n");
  expect(text).toContain("OpenRouter: ok — 2 model(s)");
  expect(text).not.toContain("(profiles:");
});

test("keryx providers test: a shrunk live list reports 'now unavailable' in the suffix and keeps the profile", async () => {
  const dir = tempDir();
  await capture(() => providersCommand(["test", "openrouter"], { fetch: fetchWithBody(OPENROUTER_BODY), env: {}, dir }));
  const shrunk = { data: [OPENROUTER_BODY.data[0]] };
  const { stdout } = await capture(() => providersCommand(["test", "openrouter"], { fetch: fetchWithBody(shrunk), env: {}, dir }));
  expect(stdout.join("\n")).toContain("1 now unavailable");
  const stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("openrouter", "openrouter/model-b")]?.available).toBe(false);
});

test("keryx providers test: the refreshed profiles persist to model-profiles.json, never auth.json", async () => {
  const dir = tempDir();
  await capture(() => providersCommand(["test", "openrouter"], { fetch: fetchWithBody(OPENROUTER_BODY), env: {}, dir }));
  const raw = JSON.parse(await readFile(modelProfilesFilePath(dir), "utf8")) as Record<string, unknown>;
  expect(raw[profileKey("openrouter", "openrouter/model-a")]).toBeDefined();
  const authPath = path.join(dir, "auth.json");
  const authRaw = JSON.parse(await readFile(authPath, "utf8").catch(() => "{}")) as Record<string, unknown>;
  expect("modelProfiles" in authRaw).toBe(false);
});
