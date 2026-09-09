import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveContainedPath } from "./contained-path";

const SENTINEL = "outside-containment-sentinel";

type Fixture = { base: string; root: string };

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "keryx-shared-containment-"));
  const root = path.join(base, "project");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "inside.txt"), "inside\n", "utf8");
  return { base, root };
}

let current: Fixture | undefined;
afterEach(async () => {
  if (current) await rm(current.base, { recursive: true, force: true });
  current = undefined;
});

test("shared lexical containment rejects an owner-root replacement", async () => {
  current = await fixture();
  const replacement = path.join(current.base, "replacement");
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(replacement, "leak.txt"), SENTINEL, "utf8");
  await rm(current.root, { recursive: true, force: true });
  await symlink(replacement, current.root);
  const result = await resolveContainedPath(current.root, "leak.txt");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("outside-project");
});

test("shared contained reader allows internal links and rejects external targets without a fallback", async () => {
  current = await fixture();
  const internal = path.join(current.root, "alias.txt");
  const outside = path.join(current.base, "outside.txt");
  await symlink("inside.txt", internal);
  await writeFile(outside, SENTINEL, "utf8");
  await symlink(outside, path.join(current.root, "escape.txt"));
  const reader = await import("./contained-read");
  const direct = await reader.readContainedFile(current.root, path.join(current.root, "inside.txt"));
  const linked = await reader.readContainedFile(current.root, internal);
  expect(linked.toString("utf8")).toBe(direct.toString("utf8"));
  await expect(reader.readContainedFile(current.root, path.join(current.root, "escape.txt"))).rejects.toThrow();
});

test("shared contained reader enforces regular-file and max-byte policy", async () => {
  current = await fixture();
  const reader = await import("./contained-read");
  await expect(reader.readContainedFile(current.root, current.root, { requireRegularFile: true })).rejects.toThrow();
  await expect(reader.readContainedFile(current.root, path.join(current.root, "inside.txt"), { maxBytes: 2 })).rejects.toThrow();
});

test("shared contained reader fails closed with a typed capability error when descriptor reads are unavailable", async () => {
  current = await fixture();
  const reader = await import("./contained-read");
  await expect(reader.readContainedFile(current.root, path.join(current.root, "inside.txt"), { backend: "unsupported" })).rejects.toMatchObject({ code: "CONTAINED_READ_UNAVAILABLE" });
});

test("shared contained reader closes an injected owner-root replacement race", async () => {
  current = await fixture();
  const replacement = path.join(current.base, "replacement");
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(replacement, "inside.txt"), SENTINEL, "utf8");
  const reader = await import("./contained-read");
  let swapped = false;
  const beforeOpen = async (): Promise<void> => {
    await rm(current!.root, { recursive: true, force: true });
    await symlink(replacement, current!.root);
    swapped = true;
  };
  await expect(reader.readContainedFile(current.root, path.join(current.root, "inside.txt"), { hooks: { beforeOpen } })).rejects.toThrow();
  expect(swapped).toBe(true);
});

test("shared contained reader refuses an owner replacement with another real directory", async () => {
  current = await fixture();
  const original = path.join(current.base, "original-owner");
  const replacement = path.join(current.base, "replacement-owner");
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(replacement, "inside.txt"), SENTINEL, "utf8");
  const reader = await import("./contained-read");
  let swapped = false;
  const beforeOpen = async (): Promise<void> => {
    await rename(current!.root, original);
    await mkdir(current!.root, { recursive: true });
    await writeFile(path.join(current!.root, "inside.txt"), SENTINEL, "utf8");
    swapped = true;
  };
  await expect(reader.readContainedFile(current.root, path.join(current.root, "inside.txt"), { hooks: { beforeOpen } })).rejects.toThrow();
  expect(swapped).toBe(true);
});

test("shared contained reader refuses a same-path regular-file replacement after resolution", async () => {
  current = await fixture();
  const reader = await import("./contained-read");
  let swapped = false;
  const beforeOpen = async (): Promise<void> => {
    await rename(path.join(current!.root, "inside.txt"), path.join(current!.base, "original-inside.txt"));
    await writeFile(path.join(current!.root, "inside.txt"), SENTINEL, "utf8");
    swapped = true;
  };
  await expect(reader.readContainedFile(current.root, path.join(current.root, "inside.txt"), { hooks: { beforeOpen } })).rejects.toThrow();
  expect(swapped).toBe(true);
});
