import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "..", "cli.ts");
async function invoke(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "workspace", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("workspace overview --explain keeps JSON on stdout and FWK labels on stderr", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-explain-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "Explain workspace", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0);
  const manifest = JSON.parse(created.stdout) as { id: string };
  const overview = await invoke(cwd, ["overview", manifest.id, "--explain"]);
  expect(overview.exitCode).toBe(0);
  expect(JSON.parse(overview.stdout)).toHaveProperty("manifest");
  expect(overview.stderr).toContain("SAC explain (FWK — Facts / Work / Know-how)");
  expect(overview.stderr).toContain("Know-how");
  expect(overview.stderr).toContain("graph nodes/edges (navigation only)");
});

test("workspace CLI exposes only offline create/list/show/add-resource and guarded read operations", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-cli-")); await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "CLI workspace", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["list"])).stdout).toContain(manifest.id);
  expect((await invoke(cwd, ["show", manifest.id])).stdout).toContain("CLI workspace");
  const unknownActor = await invoke(cwd, ["create", "--title", "No actor flag", "--actor", "user:other"]);
  expect(unknownActor.exitCode).toBe(1);
  expect((await invoke(cwd, ["add-resource", manifest.id, "--kind", "component", "--uri", "../escape"])).exitCode).toBe(1);
});

// --- WSL-1..4 CLI subcommands (`archive`, `remove-resource`, `rename`,
// `list --include-archived`) do not exist yet — see
// docs/requirements/sac-workspace-lifecycle/specification.md. These tests are
// expected to fail red (unknown workspace command / unknown option) until
// task-implementer wires the new CLI subcommands into src/commands/workspace.ts.

test("workspace archive marks the workspace archived and hides it from list unless --include-archived is passed", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-archive-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Archive Me"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  const archived = await invoke(cwd, ["archive", manifest.id]);
  expect(archived.exitCode).toBe(0);
  expect(JSON.parse(archived.stdout)).toMatchObject({ id: manifest.id, status: "archived" });
  const defaultList = await invoke(cwd, ["list"]);
  expect(defaultList.stdout).not.toContain(manifest.id);
  const withArchived = await invoke(cwd, ["list", "--include-archived"]);
  expect(withArchived.stdout).toContain(manifest.id);
});

test("workspace list --include-archived=<value> parses the `=` spelling the same as every other option in this file, and refuses an unrecognized value instead of silently hiding archived workspaces", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-includearchived-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Include Archived Me"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["archive", manifest.id])).exitCode).toBe(0);

  const bare = await invoke(cwd, ["list", "--include-archived"]);
  expect(bare.exitCode).toBe(0); expect(bare.stdout).toContain(manifest.id);

  const equalsTrue = await invoke(cwd, ["list", "--include-archived=true"]);
  expect(equalsTrue.exitCode).toBe(0); expect(equalsTrue.stdout).toContain(manifest.id);

  const equalsFalse = await invoke(cwd, ["list", "--include-archived=false"]);
  expect(equalsFalse.exitCode).toBe(0); expect(equalsFalse.stdout).not.toContain(manifest.id);

  const noFlag = await invoke(cwd, ["list"]);
  expect(noFlag.exitCode).toBe(0); expect(noFlag.stdout).not.toContain(manifest.id);

  const unrecognized = await invoke(cwd, ["list", "--include-archived=maybe"]);
  expect(unrecognized.exitCode).toBe(1);
  expect(unrecognized.stderr).toContain("--include-archived");
});

test("workspace remove-resource removes a resource by uri and rejects a uri that was never added", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-removeresource-cli-")); await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src", "a.ts"), "export {};\n");
  const created = await invoke(cwd, ["create", "--title", "Remove Resource Me", "--component", "./src/a.ts"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  const removed = await invoke(cwd, ["remove-resource", manifest.id, "--uri", "./src/a.ts"]);
  expect(removed.exitCode).toBe(0);
  const removedManifest = JSON.parse(removed.stdout) as { resources: unknown[] };
  expect(removedManifest.resources).toEqual([]);
  const missing = await invoke(cwd, ["remove-resource", manifest.id, "--uri", "./src/missing.ts"]);
  expect(missing.exitCode).toBe(1);
});

test("workspace rename updates the title and it is visible via a subsequent show", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-rename-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Original CLI Title"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  const renamed = await invoke(cwd, ["rename", manifest.id, "--title", "New CLI Title"]);
  expect(renamed.exitCode).toBe(0);
  expect(JSON.parse(renamed.stdout)).toMatchObject({ id: manifest.id, title: "New CLI Title" });
  const shown = await invoke(cwd, ["show", manifest.id]);
  expect(shown.stdout).toContain("New CLI Title");
  expect(shown.stdout).not.toContain("Original CLI Title");
});

test("workspace CLI ships no member-management or delete subcommand (AC-7, AC-8)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-nongoal-cli-"));
  const created = await invoke(cwd, ["create", "--title", "Non-goal Check"]);
  expect(created.exitCode).toBe(0); const manifest = JSON.parse(created.stdout) as { id: string };
  expect((await invoke(cwd, ["add-member", manifest.id, "--subject", "user:other", "--role", "editor"])).exitCode).toBe(1);
  expect((await invoke(cwd, ["remove-member", manifest.id, "--subject", "user:other"])).exitCode).toBe(1);
  expect((await invoke(cwd, ["delete", manifest.id])).exitCode).toBe(1);
});
