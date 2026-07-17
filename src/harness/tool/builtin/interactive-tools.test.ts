import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InteractiveTool, builtinReadOnlyTools, confineToRoot } from "./interactive-tools";

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
  root = await mkdtemp(join(tmpdir(), "keryx-tools-"));
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
