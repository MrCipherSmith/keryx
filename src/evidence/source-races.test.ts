import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lstatSync } from "node:fs";
import { readDescriptorChainAsync } from "../lib/descriptor-read";
import { parseEvidenceConfig } from "./config";
import { readEvidenceArchive } from "./sources";
import { createSession, persistHistory } from "../session/store";
const fixtures: string[] = [];
afterEach(async () => { for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "erl-race-")); fixtures.push(root);
  await mkdir(path.join(root, "docs")); await writeFile(path.join(root, "docs/note"), "allowed"); return root;
}
test("explicit undefined cannot erase finite defaults", () => {
  for (const key of ["maxSourceBytes", "enabled", "roots", "timeoutMs"]) expect(parseEvidenceConfig({ schemaVersion: 1, [key]: undefined }).ok).toBe(false);
});
test("parent symlink swap before descriptor open refuses bytes", async () => {
  const root = await fixture(); await mkdir(path.join(root, ".git")); await writeFile(path.join(root, ".git/note"), "private");
  const target = path.join(root, "docs/note"), identity = lstatSync(target);
  await expect(readDescriptorChainAsync(root, target, { requireRegularFile: true, maxBytes: 100, expectedTargetIdentity: identity,
    beforeOpen: async () => { await rename(path.join(root, "docs"), path.join(root, "old")); await symlink(path.join(root, ".git"), path.join(root, "docs")); },
  })).rejects.toThrow();
});
test("archive directory replacement during scanning invalidates ownership", async () => {
  const root = await fixture(), dataDir = path.join(root, "data");
  const handle = createSession({ cwd: root, dataDir, id: "fixture" }); persistHistory(handle, [{ role: "user", content: "original" }]);
  const result = await readEvidenceArchive({ projectRoot: root, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096,
    scanner: async text => {
      await rename(handle.dir, `${handle.dir}-old`); await mkdir(handle.dir);
      await writeFile(path.join(handle.dir, "summary.json"), JSON.stringify(handle.summary));
      await writeFile(path.join(handle.dir, "archive.jsonl"), '{"role":"user","content":"foreign"}\n');
      return { code: "ok", text, redaction: "not-needed" };
    },
  }); expect(result.code).toBe("source-unavailable");
});
test("legacy content survives but reasoning is excluded", async () => {
  const root = await fixture(), dataDir = path.join(root, "data"), handle = createSession({ cwd: root, dataDir, id: "fixture" });
  await writeFile(path.join(handle.dir, "archive.jsonl"), '{"role":"assistant","content":"public","reasoning":"private"}\n');
  const result = await readEvidenceArchive({ projectRoot: root, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096,
    scanner: async text => ({ code: "ok", text, redaction: "not-needed" }),
  }); expect(result.code).toBe("ok"); if (result.code === "ok") expect(result.records.map(record => record.text)).toEqual(["public"]);
});

test("scanner deadline aborts the injected scanner and returns no text", async () => {
  const root = await fixture(); let aborted = false;
  const { readEvidenceFile } = await import("./sources");
  const result = await readEvidenceFile({ projectRoot: root, path: "docs/note", roots: ["docs"], maxSourceBytes: 4096, timeoutMs: 500,
    scanner: (_text, signal) => new Promise(resolve => signal?.addEventListener("abort", () => { aborted = true; resolve({ code: "blocked" }); }, { once: true })),
  }); expect(result.code).toBe("timeout"); expect(aborted).toBe(true); expect("text" in result).toBe(false);
});
test("record budget refuses whole archive without partial success", async () => {
  const root = await fixture(), dataDir = path.join(root, "data"), handle = createSession({ cwd: root, dataDir, id: "fixture" });
  await writeFile(path.join(handle.dir, "archive.jsonl"), '{"role":"user","content":"one"}\n{"role":"user","content":"two"}\n');
  let scans = 0;
  const result = await readEvidenceArchive({ projectRoot: root, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096, maxRecords: 1,
    scanner: async text => { scans++; return { code: "ok", text, redaction: "not-needed" }; },
  }); expect(result.code).toBe("budget-exceeded"); expect(scans).toBe(0); expect("records" in result).toBe(false);
});
test("tool-call-only messages project allowed text, not opaque replay or spills", async () => {
  const root = await fixture(), dataDir = path.join(root, "data"), handle = createSession({ cwd: root, dataDir, id: "fixture" });
  await writeFile(path.join(handle.dir, "archive.jsonl"), JSON.stringify({ role: "assistant", content: "", toolCalls: [{ id: "call", name: "search", arguments: '{"query":"public"}' }], reasoning: { text: "private", replay: [{ data: "opaque" }] }, spillPath: "foreign" })+"\nnull\n");
  const result = await readEvidenceArchive({ projectRoot: root, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096,
    scanner: async text => ({ code: "ok", text: text.replace("public", "masked"), redaction: "applied" }),
  }); expect(result.code).toBe("ok"); if (result.code === "ok") expect(result.records.map(record => record.text)).toEqual(['{"query":"masked"}']);
});

test("archive intermediate storage symlink refuses otherwise valid ownership", async () => {
  const root = await fixture(), dataDir = path.join(root, "data");
  const handle = createSession({ cwd: root, dataDir, id: "fixture" }); persistHistory(handle, [{ role: "user", content: "private" }]);
  const parent = path.dirname(handle.dir), external = path.join(root, "external");
  await rename(parent, external); await symlink(external, parent);
  let scans = 0;
  const answer = await readEvidenceArchive({ projectRoot: root, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096,
    scanner: async text => { scans++; return { code: "ok", text, redaction: "not-needed" }; },
  });
  expect(answer.code).toBe("source-unavailable"); expect("records" in answer).toBe(false); expect(scans).toBe(0);
});
