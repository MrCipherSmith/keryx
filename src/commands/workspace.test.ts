import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "..", "cli.ts");
async function invoke(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "workspace", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("workspace CLI exposes only offline create/list/show/add-resource operations", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-cli-")); await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "CLI workspace", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["list"])).stdout).toContain(manifest.id);
  expect((await invoke(cwd, ["show", manifest.id])).stdout).toContain("CLI workspace");
  const unknownActor = await invoke(cwd, ["create", "--title", "No actor flag", "--actor", "user:other"]);
  expect(unknownActor.exitCode).toBe(1);
  expect((await invoke(cwd, ["add-resource", manifest.id, "--kind", "component", "--uri", "../escape"])).exitCode).toBe(1);
});
