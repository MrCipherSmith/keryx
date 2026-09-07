import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listResources, readResource } from "./resources";

const SENTINEL = "outside-containment-sentinel";

type Fixture = { base: string; cwd: string; wiki: string; outside: string };

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "keryx-mcp-containment-"));
  const cwd = path.join(base, "project");
  const wiki = path.join(cwd, ".metaproject", "wiki");
  const outside = path.join(base, "outside");
  await mkdir(path.join(wiki, "nested"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(wiki, "nested", "target.md"), "inside-bytes\n", "utf8");
  await writeFile(path.join(outside, "secret.md"), SENTINEL, "utf8");
  await symlink(path.join("nested", "target.md"), path.join(wiki, "alias.md"));
  await symlink(path.join(wiki, "nested"), path.join(wiki, "alias-dir"));
  await symlink(path.join(outside, "secret.md"), path.join(wiki, "escape.md"));
  await symlink(".", path.join(wiki, "nested", "cycle"));
  return { base, cwd, wiki, outside };
}

let current: Fixture | undefined;
afterEach(async () => {
  if (current) await rm(current.base, { recursive: true, force: true });
  current = undefined;
});

describe("MCP resources containment RED scenarios", () => {
  test("ordinary files and internal file/directory link chains return the same bytes", async () => {
    current = await fixture();
    const direct = await readResource(current.cwd, ["wiki"], "metaproject://wiki/nested/target.md");
    const fileLink = await readResource(current.cwd, ["wiki"], "metaproject://wiki/alias.md");
    const directoryLink = await readResource(current.cwd, ["wiki"], "metaproject://wiki/alias-dir/target.md");
    expect(fileLink.text).toBe(direct.text);
    expect(directoryLink.text).toBe(direct.text);
  });

  test("external symlink reads fail without exposing the sentinel or target name", async () => {
    current = await fixture();
    let thrown: unknown;
    try {
      await readResource(current.cwd, ["wiki"], "metaproject://wiki/escape.md");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const message = String(thrown);
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain(current.outside);
  });

  test("replaced owner root fails closed instead of authorizing a new outside tree", async () => {
    current = await fixture();
    const replacement = path.join(current.base, "replacement-wiki");
    await mkdir(replacement, { recursive: true });
    await writeFile(path.join(replacement, "leak.md"), SENTINEL, "utf8");
    await rm(current.wiki, { recursive: true, force: true });
    await symlink(replacement, current.wiki);
    let thrown: unknown;
    try {
      await readResource(current.cwd, ["wiki"], "metaproject://wiki/leak.md");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain(SENTINEL);
  });

  test("listing follows internal links once, bounds directory cycles, and omits external links", async () => {
    current = await fixture();
    const listings = await listResources(current.cwd, ["wiki"]);
    const names = listings.map((entry) => entry.name);
    expect(names).toContain("alias.md");
    expect(names).toContain(path.join("alias-dir", "target.md").replaceAll(path.sep, "/"));
    expect(names).not.toContain("escape.md");
    expect(names.filter((name) => name.includes("cycle"))).toHaveLength(0);
  });
});
