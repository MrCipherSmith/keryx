import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const client = resolve(import.meta.dir, "client-main.ts");
const command = resolve(import.meta.dir, "../commands/hub.ts");
const binding = {
    url: "http://127.0.0.1:1", projectId: "project-one", checkoutId: "checkout-one",
    tokenEnv: "PRIVATE_TOKEN_NAME", gitCommonDir: "/private/work/.git", lastRevisionId: "private-revision", token: "fixture-secret-not-for-output"
};
async function snapshot(root: string): Promise<unknown[]> {
    const entries: unknown[] = [];
    for (const name of (await readdir(root)).sort()) {
        const path = join(root, name);
        const info = await stat(path);
        entries.push([name, info.mode, info.mtimeMs, info.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64")]);
    }
    return entries;
}
async function fixture(run: (f: { root: string; cwd: string; trustedPath: string; env: Record<string, string> }) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "hub-status-"));
    const cwd = join(root, "checkout");
    const config = join(root, "config");
    const trustedPath = join(config, "keryx", "hub", "bindings", `${createHash("sha256").update(cwd).digest("hex")}.json`);
    await mkdir(cwd);
    await mkdir(dirname(trustedPath), { recursive: true });
    await mkdir(join(cwd, ".metaproject"));
    await writeFile(join(cwd, ".metaproject", "hub.json"), JSON.stringify({ ...binding, projectId: "untrusted-project" }));
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/unfinished\n");
    await writeFile(join(cwd, ".git", "index"), "unchanged index fixture");
    await writeFile(join(cwd, "unfinished.txt"), "keep my unfinished work\n");
    try { await run({ root, cwd, trustedPath, env: { HOME: root, XDG_CONFIG_HOME: config, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); }
    finally { await rm(root, { recursive: true, force: true }); }
}
function cli(cwd: string, env: Record<string, string>, args = ["status"]) {
    return Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", client, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
}

describe("hub status", () => {
    test("shows only the trusted connection projection without credentials, network, Git or file changes", async () => {
        await fixture(async ({ root, cwd, trustedPath, env }) => {
            await writeFile(trustedPath, JSON.stringify(binding));
            const before = await snapshot(root);
            const result = cli(cwd, env);
            expect(result.exitCode).toBe(0);
            expect(result.stderr.toString()).toBe("");
            expect(JSON.parse(result.stdout.toString())).toEqual({ url: binding.url, projectId: binding.projectId, checkoutId: binding.checkoutId });
            expect(result.stdout.toString()).not.toContain("private");
            expect(result.stdout.toString()).not.toContain("fixture-secret");
            expect(await snapshot(root)).toEqual(before);
        });
    });
    test("missing trusted binding reports unconnected and ignores the repository mirror", async () => {
        await fixture(async ({ root, cwd, env }) => {
            const before = await snapshot(root);
            const result = cli(cwd, env);
            expect(result.exitCode).toBe(0);
            expect(result.stdout.toString().trim()).toBe("This checkout is not connected to Team Hub.");
            expect(result.stderr.toString()).toBe("");
            expect(await snapshot(root)).toEqual(before);
        });
    });
    test("does not call fetch even when a token is present", async () => {
        await fixture(async ({ cwd, trustedPath, env }) => {
            await writeFile(trustedPath, JSON.stringify(binding));
            const script = `globalThis.fetch = () => { throw Error('NETWORK_WAS_CALLED'); }; const {hubCommand} = await import(${JSON.stringify(command)}); await hubCommand(['status']);`;
            const result = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], { cwd, env: { ...env, KERYX_HUB_TOKEN: "unused-fixture-token" }, stdout: "pipe", stderr: "pipe" });
            expect(result.exitCode).toBe(0);
            expect(JSON.parse(result.stdout.toString())).toEqual({ url: binding.url, projectId: binding.projectId, checkoutId: binding.checkoutId });
            expect(result.stderr.toString()).toBe("");
        });
    });
    test("invalid JSON fails without disclosing file content or location", async () => {
        await fixture(async ({ root, cwd, trustedPath, env }) => {
            await writeFile(trustedPath, 'SECRET_RAW_JSON{"token":"private"');
            const before = await snapshot(root);
            const result = cli(cwd, env);
            expect(result.exitCode).toBe(1);
            expect(result.stdout.toString()).toBe("");
            expect(result.stderr.toString().trim()).toBe("Invalid Hub connection binding.");
            expect(await snapshot(root)).toEqual(before);
        });
    });
    test("unreadable binding is an error, not unconnected, and hides the filesystem path", async () => {
        await fixture(async ({ cwd, trustedPath, env }) => {
            await mkdir(trustedPath);
            const result = cli(cwd, env);
            expect(result.exitCode).toBe(1);
            expect(result.stdout.toString()).toBe("");
            expect(result.stderr.toString().trim()).toBe("Cannot read Hub connection binding.");
        });
    });
    test.each([
        null, [], {}, { ...binding, projectId: "bad\nsecret" }, { ...binding, checkoutId: 42 },
        { ...binding, url: "https://user:secret@example.test" }, { ...binding, url: "https://hub.test/?token=secret" },
        { ...binding, url: "https://hub.test/#secret" }, { ...binding, url: "http://remote.test" },
        { ...binding, url: "file:///private/secret" }, { ...binding, url: "https://hub.test/\nsecret" }
    ].map(value => [value] as const))("invalid binding shape or credential-bearing URL is never printed (%#)", async (value) => {
        await fixture(async ({ cwd, trustedPath, env }) => {
            await writeFile(trustedPath, JSON.stringify(value));
            const result = cli(cwd, env);
            expect(result.exitCode).toBe(1);
            expect(result.stdout.toString()).toBe("");
            expect(result.stderr.toString().trim()).toBe("Invalid Hub connection binding.");
        });
    });
    test("help lists status as local and read-only; status rejects network flags", async () => {
        await fixture(async ({ cwd, env }) => {
            const help = cli(cwd, env, ["--help"]);
            expect(help.exitCode).toBe(0);
            expect(help.stdout.toString()).toContain("status");
            expect(help.stdout.toString()).toContain("local binding; no network or credentials");
            expect(cli(cwd, env, ["status", "--token-env", "PRIVATE"]).exitCode).toBe(1);
        });
    });
});
