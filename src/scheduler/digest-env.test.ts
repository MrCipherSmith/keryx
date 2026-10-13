import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupDigestEnv } from "./digest.test-helpers";

test("digest setup initializes a real repository and teardown restores globals", async () => {
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  const log = console.log;
  const env = await setupDigestEnv({ board: false });
  try {
    await access(path.join(env.root, ".git", "HEAD"));
    expect(process.env.HOME).not.toBe(saved.HOME);
  } finally {
    await env.teardown();
  }
  expect(process.env.HOME).toBe(saved.HOME);
  expect(process.env.XDG_DATA_HOME).toBe(saved.XDG_DATA_HOME);
  expect(console.log).toBe(log);
  expect(await access(env.root).then(() => true, () => false)).toBe(false);
});

for (const mode of ["failure", "timeout"] as const) {
  test(`digest setup rolls back globals and directories on git ${mode}`, async () => {
    const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, PATH: process.env.PATH };
    const log = console.log;
    const error = console.error;
    const aside = await mkdtemp(path.join(tmpdir(), "keryx-digest-git-test-"));
    const marker = path.join(aside, "paths");
    await writeFile(path.join(aside, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$HOME" "$PWD" > '${marker}'\n${mode === "failure" ? "exit 23" : "exec /bin/sleep 8"}\n`,
      { mode: 0o755 });
    process.env.PATH = `${aside}${path.delimiter}${saved.PATH ?? ""}`;
    let paths: string[] = [];
    let env: Awaited<ReturnType<typeof setupDigestEnv>> | undefined;
    let rejected = false;
    try {
      try {
        env = await setupDigestEnv({ board: false });
      } catch {
        rejected = true;
      }
      paths = (await readFile(marker, "utf8")).trim().split("\n");
      expect(rejected).toBe(true);
      expect(process.env.HOME).toBe(saved.HOME);
      expect(process.env.XDG_DATA_HOME).toBe(saved.XDG_DATA_HOME);
      expect(console.log).toBe(log);
      expect(console.error).toBe(error);
      for (const dir of paths) {
        expect(await access(dir).then(() => true, () => false)).toBe(false);
      }
    } finally {
      await env?.teardown();
      console.log = log;
      console.error = error;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const dir of paths) await rm(dir, { recursive: true, force: true });
      await rm(aside, { recursive: true, force: true });
    }
  }, 15_000);
}
