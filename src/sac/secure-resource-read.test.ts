import { expect, test } from "bun:test";
import { mkdtemp, writeFile, appendFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWorkspaceFileNoFollow } from "./secure-resource-read";
import { DEFAULT_CONTAINED_READ_MAX_BYTES } from "../lib/contained-read";

test("SAC reader enforces the same byte ceiling as contained resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-size-"));
  try {
    const file = path.join(root, "fixture.txt");
    await writeFile(file, Buffer.alloc(DEFAULT_CONTAINED_READ_MAX_BYTES, 65));
    expect(readWorkspaceFileNoFollow(root, file).length).toBe(DEFAULT_CONTAINED_READ_MAX_BYTES);
    await appendFile(file, "x");
    expect(() => readWorkspaceFileNoFollow(root, file)).toThrow(/byte limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SAC reader rejects directories before attempting to read file content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-kind-"));
  try {
    const folder = path.join(root, "folder");
    await mkdir(folder);
    expect(() => readWorkspaceFileNoFollow(root, folder)).toThrow(/not a regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
