import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InteractiveTool, builtinReadOnlyTools, confineToRoot, resolveReferenceFolders } from "./interactive-tools";

let root: string;
let tools: InteractiveTool[];

function tool(name: string): InteractiveTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(`tool not found: ${name}`);
  }
  return found;
}

beforeAll(async () => {
  // macOS exposes /var through /private/var; confineToRoot canonicalizes paths
  // to keep symlink escapes out, so the fixture root must be canonical too.
  root = await realpath(await mkdtemp(join(tmpdir(), "keryx-tools-")));
  await writeFile(join(root, "hello.txt"), "hi there", "utf8");
  await writeFile(join(root, "second.md"), "# second", "utf8");
  tools = builtinReadOnlyTools(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("all builtin tools are risk read with valid names", () => {
  expect(tools.map((t) => t.definition.name).sort()).toEqual(["get_cwd", "list_dir", "read_file"]);
  for (const t of tools) {
    expect(t.definition.risk).toBe("read");
  }
});

test("confineToRoot resolves inside the root and rejects escapes", () => {
  expect(confineToRoot(root, ".")).toBe(root);
  expect(confineToRoot(root, "sub/file.txt")).toBe(join(root, "sub/file.txt"));
  expect(confineToRoot(root, "../../etc/passwd")).toBeNull();
  expect(confineToRoot(root, "/etc/passwd")).toBeNull();
});

test("get_cwd returns the project root", async () => {
  const result = await tool("get_cwd").invoke({});
  expect(result.isError).toBe(false);
  expect(result.output).toBe(root);
});

test("list_dir lists directory entries (happy path)", async () => {
  const result = await tool("list_dir").invoke({});
  expect(result.isError).toBe(false);
  expect(result.output).toContain("hello.txt");
  expect(result.output).toContain("second.md");
});

test("list_dir rejects a path that escapes the project root", async () => {
  const result = await tool("list_dir").invoke({ path: "../../.." });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/escapes the project root/);
});

test("read_file reads a file (happy path)", async () => {
  const result = await tool("read_file").invoke({ path: "hello.txt" });
  expect(result.isError).toBe(false);
  expect(result.output).toBe("hi there");
});

test("read_file errors on a missing file without throwing", async () => {
  const result = await tool("read_file").invoke({ path: "nope.txt" });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/read_file failed/);
});

test("read_file rejects an absolute-path escape", async () => {
  const result = await tool("read_file").invoke({ path: "/etc/hosts" });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/escapes the project root/);
});

test("read_file outside-cwd refusal names the cause and the alternative", async () => {
  const result = await tool("read_file").invoke({ path: "/etc/hosts" });
  expect(result.output).toContain("working directory");
  expect(result.output).toContain("outside it use shell_exec `cat <path>`");
});

test("reference folders are discoverable and readable without allowing reads outside them", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "keryx-references-")));
  try {
    const docs = join(fixture, "docs");
    const outside = join(fixture, "other.txt");
    await mkdir(docs);
    await writeFile(join(docs, "guide.md"), "Guide");
    await writeFile(outside, "Outside");
    await symlink(outside, join(docs, "link.txt"));
    const folders = resolveReferenceFolders([docs, docs]);
    expect(folders).toEqual([docs]);
    expect(() => resolveReferenceFolders([outside])).toThrow(/not a directory/);
    expect(() => resolveReferenceFolders(["docs"])).toThrow(/absolute paths/);

    const roster = new Map(builtinReadOnlyTools(root, { referenceFolders: folders })
      .map(entry => [entry.definition.name, entry]));
    expect([...roster.values()].every(entry => entry.definition.risk === "read")).toBe(true);
    expect(await roster.get("list_reference_folders")!.invoke({})).toEqual({ output: JSON.stringify([docs]), isError: false });
    expect((await roster.get("list_dir")!.invoke({ path: docs })).output).toContain("guide.md");
    expect(await roster.get("read_file")!.invoke({ path: join(docs, "guide.md") })).toEqual({ output: "Guide", isError: false });
    expect((await roster.get("read_file")!.invoke({ path: outside })).isError).toBe(true);
    expect((await roster.get("read_file")!.invoke({ path: join(docs, "link.txt") })).isError).toBe(true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
