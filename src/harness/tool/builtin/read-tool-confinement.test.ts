// `read_file` and `list_dir` stay inside the project root — through symlinks.
//
// `confineToRoot`'s realpath resolution was pinned only INCIDENTALLY, by two
// `search_code` tests that happen to call it. The existing tests in
// `interactive-tools.test.ts` cover `..` and an absolute path, and both of those
// are caught by a purely lexical check — so a review mutated the realpath step to
// lexical-only, watched exactly two tests fail (both `search_code`), and then
// read an SSH key through a home-symlink with `read_file` while every test about
// `read_file` stayed green.
//
// That is backwards for the unattended posture. `read_file` and `list_dir` are
// two of the three general read tools it registers, they are `risk: "read"` so
// they never reach an approver, and with no `shell_exec` they are the primary
// read channel rather than a convenience beside one.
//
// So: real symlinks, real files outside the root, asserting the refusal AND that
// the out-of-root content never appears in the result. Every case here passes a
// lexical containment check and is caught only by resolving the real path.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { builtinReadOnlyTools, confineToRoot, type InteractiveTool } from "./interactive-tools";

/** Content that exists only outside the project root. */
const OUTSIDE_MARKER = "OUTSIDE-ROOT-MARKER-3f9a2c";

let base: string;
let root: string;
let outside: string;
let tools: InteractiveTool[];

function tool(name: string): InteractiveTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(`tool not found: ${name}`);
  }
  return found;
}

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-read-confine-"));
  root = path.join(base, "proj");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(outside, "nested"), { recursive: true });

  writeFileSync(path.join(root, "inside.txt"), "ordinary content\n", "utf8");
  writeFileSync(path.join(outside, "secret.txt"), `${OUTSIDE_MARKER}\n`, "utf8");
  writeFileSync(path.join(outside, "nested", "deep.txt"), `${OUTSIDE_MARKER}-deep\n`, "utf8");

  // Every shape a lexical check accepts and a realpath check refuses.
  symlinkSync(outside, path.join(root, "vendor")); // dir symlink
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt")); // file symlink
  symlinkSync(outside, path.join(root, "src", "nested-link")); // dir symlink one level down
  symlinkSync(path.join(root, "vendor"), path.join(root, "indirect")); // symlink to a symlink

  tools = builtinReadOnlyTools(root);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Paths that resolve outside the root, each of which is lexically innocent. */
const SYMLINK_ESCAPES: ReadonlyArray<{ label: string; path: string }> = [
  { label: "dir symlink", path: "vendor" },
  { label: "file through a dir symlink", path: "vendor/secret.txt" },
  { label: "file symlink named directly", path: "link.txt" },
  { label: "dir symlink one level down", path: "src/nested-link" },
  { label: "file under a nested dir symlink", path: "src/nested-link/secret.txt" },
  { label: "symlink to a symlink", path: "indirect" },
  { label: "file through a symlinked symlink", path: "indirect/secret.txt" },
  { label: "deeper file through a dir symlink", path: "vendor/nested/deep.txt" },
];

test("confineToRoot refuses every symlink that resolves outside the root", () => {
  for (const { label, path: candidate } of SYMLINK_ESCAPES) {
    expect(confineToRoot(root, candidate), `${label} (${candidate}) was allowed`).toBeNull();
  }
  // The control: it is not simply refusing everything.
  expect(confineToRoot(root, "inside.txt")).toBe(path.join(root, "inside.txt"));
  expect(confineToRoot(root, "src")).toBe(path.join(root, "src"));
  expect(confineToRoot(root, ".")).toBe(root);
});

test("read_file cannot read an out-of-root file through any symlink shape", async () => {
  for (const { label, path: candidate } of SYMLINK_ESCAPES) {
    const result = await tool("read_file").invoke({ path: candidate });
    expect(result.isError, `${label} (${candidate}) was read`).toBe(true);
    // The message names the property that produced the refusal, not a filename.
    expect(result.output).toMatch(/escapes the project root/);
    // And nothing from outside the root came back under any circumstances.
    expect(result.output, `${label} leaked out-of-root content`).not.toContain(OUTSIDE_MARKER);
  }

  // Control: the tool genuinely reads what is genuinely inside.
  const inside = await tool("read_file").invoke({ path: "inside.txt" });
  expect(inside.isError).toBe(false);
  expect(inside.output).toContain("ordinary content");
});

test("list_dir cannot list an out-of-root directory through any symlink shape", async () => {
  for (const { label, path: candidate } of SYMLINK_ESCAPES.filter((e) => !e.path.endsWith(".txt"))) {
    const result = await tool("list_dir").invoke({ path: candidate });
    expect(result.isError, `${label} (${candidate}) was listed`).toBe(true);
    expect(result.output).toMatch(/escapes the project root/);
    expect(result.output, `${label} leaked an out-of-root listing`).not.toContain("secret.txt");
  }

  // Control.
  const inside = await tool("list_dir").invoke({ path: "src" });
  expect(inside.isError).toBe(false);
});

test("a symlink pointing at the user's home is refused like any other escape", async () => {
  // The shape a review actually used to read an SSH key: nothing in the path is
  // lexically suspicious — no `..`, no leading `/` — and the whole defence is
  // that the real path is resolved before it is compared.
  const home = path.join(base, "fake-home");
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
  writeFileSync(path.join(home, ".ssh", "id_rsa"), `PRIVATE-KEY-${OUTSIDE_MARKER}\n`, "utf8");
  symlinkSync(home, path.join(root, "home-link"));

  const viaSymlink = await tool("read_file").invoke({ path: "home-link/.ssh/id_rsa" });
  expect(viaSymlink.isError).toBe(true);
  expect(viaSymlink.output).not.toContain("PRIVATE-KEY");
  expect(confineToRoot(root, "home-link/.ssh/id_rsa")).toBeNull();
});
