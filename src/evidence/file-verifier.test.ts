import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, link } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readEvidenceFile, readVerifiedEvidenceFile } from "./sources";

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "erl-verifier-"));
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs/a.txt"), "alpha evidence");
  return { parent, root, target: path.join(root, "docs/a.txt") };
}
const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });

test("owner verifier confirms unchanged bytes without asynchronous handoff", async () => {
  const f = await fixture();
  try {
    const result = await readVerifiedEvidenceFile({ projectRoot: f.root, path: "docs/a.txt", roots: ["docs"], maxSourceBytes: 1024, scanner });
    expect(result.code).toBe("ok");
    if (result.code !== "ok") throw Error("fixture unavailable");
    expect(result.confirm()).toBe(true);
    expect(typeof result.confirm()).toBe("boolean");
    await writeFile(f.target, "changed bytes");
    expect(result.confirm()).toBe(false);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

for (const mutation of ["delete", "replace", "symlink", "root-replace"] as const) {
  test(`owner verifier refuses ${mutation} after scan`, async () => {
    const f = await fixture();
    try {
      const result = await readVerifiedEvidenceFile({ projectRoot: f.root, path: "docs/a.txt", roots: ["docs"], maxSourceBytes: 1024, scanner });
      expect(result.code).toBe("ok");
      if (result.code !== "ok") throw Error("fixture unavailable");
      if (mutation === "root-replace") {
        await rename(f.root, path.join(f.parent, "old"));
        await mkdir(path.join(f.root, "docs"), { recursive: true });
        await writeFile(f.target, "alpha evidence");
      } else {
        await rm(f.target);
        if (mutation === "replace") await writeFile(f.target, "alpha evidence");
        if (mutation === "symlink") {
          const outside = path.join(f.parent, "outside.txt");
          await writeFile(outside, "alpha evidence");
          await symlink(outside, f.target);
        }
      }
      expect(result.confirm()).toBe(false);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
  });
}


test("owner verifier refuses aborted delivery even with unchanged bytes", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const result = await readVerifiedEvidenceFile({ projectRoot: f.root, path: "docs/a.txt", roots: ["docs"], maxSourceBytes: 1024, scanner, signal: controller.signal });
    if (result.code !== "ok") throw Error("fixture unavailable");
    expect(result.confirm()).toBe(true);
    controller.abort();
    expect(result.confirm()).toBe(false);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("owner verifier refuses a new hardlink alias", async () => {
  const f = await fixture();
  try {
    const result = await readVerifiedEvidenceFile({ projectRoot: f.root, path: "docs/a.txt", roots: ["docs"], maxSourceBytes: 1024, scanner });
    if (result.code !== "ok") throw Error("fixture unavailable");
    await link(f.target, path.join(f.parent, "alias.txt"));
    expect(result.confirm()).toBe(false);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("ordinary file adapter does not expose the owner capability", async () => {
  const f = await fixture();
  try {
    const result = await readEvidenceFile({ projectRoot: f.root, path: "docs/a.txt", roots: ["docs"], maxSourceBytes: 1024, scanner });
    expect(result.code).toBe("ok");
    expect("confirm" in result).toBe(false);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
