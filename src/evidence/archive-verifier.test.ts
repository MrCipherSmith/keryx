import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, rename, mkdir, link } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSession, persistHistory } from "../session/store";
import { readEvidenceArchive, readVerifiedEvidenceArchive } from "./sources";

const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-archive-confirm-"));
  const projectRoot = path.join(base, "project");
  await mkdir(projectRoot);
  const dataDir = path.join(base, "data");
  const handle = createSession({ cwd: projectRoot, dataDir, id: "fixture" });
  persistHistory(handle, [{ role: "user", content: "archive evidence" }]);
  return { base, projectRoot, handle, options: { projectRoot, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096, scanner } };
}
for (const mutation of ["unchanged", "archive", "summary", "session", "owner", "hardlink", "abort"] as const) {
  test(`archive owner final confirmation: ${mutation}`, async () => {
    const f = await fixture(), controller = new AbortController();
    try {
      const result = await readVerifiedEvidenceArchive({ ...f.options, signal: controller.signal });
      expect(result.code).toBe("ok");
      if (result.code !== "ok") throw Error("fixture unavailable");
      expect(result.confirm()).toBe(true);
      if (mutation === "archive") await writeFile(path.join(f.handle.dir, "archive.jsonl"), "changed\n");
      if (mutation === "summary") await writeFile(path.join(f.handle.dir, "summary.json"), "{}");
      if (mutation === "session") {
        await rename(f.handle.dir, f.handle.dir + "-old");
        await mkdir(f.handle.dir);
      }
      if (mutation === "owner") {
        await rename(f.projectRoot, f.projectRoot + "-old");
        await mkdir(f.projectRoot);
      }
      if (mutation === "hardlink") await link(path.join(f.handle.dir, "summary.json"), path.join(f.base, "alias"));
      if (mutation === "abort") controller.abort();
      expect(result.confirm()).toBe(mutation === "unchanged");
    } finally { await rm(f.base, { recursive: true, force: true }); }
  });
}
test("ordinary archive adapter does not expose confirmation", async () => {
  const f = await fixture();
  try {
    const result = await readEvidenceArchive(f.options);
    expect(result.code).toBe("ok");
    expect("confirm" in result).toBe(false);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
