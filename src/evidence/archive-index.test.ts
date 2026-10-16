import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSession, persistHistory } from "../session/store";
import { readEvidenceArchive } from "./sources";
import { chunkArchiveEvidence, archiveChunkId } from "./archive-chunks";
import { createEvidenceSourceOwner, evidenceSourceIdentity } from "./source-owner";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";
import { publishValidatedEvidenceGeneration, searchValidatedEvidenceGeneration } from "./index";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
test("archive records survive validated publication, ranking and revocation", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-archive-index-"));
  await mkdir(path.join(base, "project"));
  const projectRoot = await realpath(path.join(base, "project")), dataDir = path.join(base, "data");
  const handle = createSession({ cwd: projectRoot, dataDir, id: "fixture" });
  persistHistory(handle, [{ role: "user", content: "archive evidence" }, { role: "assistant", content: "second evidence" }]);
  const config = { schemaVersion: 1, enabled: true, sessionArchives: true };
  const source = await readEvidenceArchive({ projectRoot, dataDir, sessionId: "fixture", sessionArchives: true, maxSourceBytes: 4096, scanner });
  if (source.code !== "ok") throw Error("archive unavailable");
  const ref = { ...evidenceSourceIdentity(projectRoot, { kind: "session-archive", id: "fixture" }), versionHash: source.versionHash };
  const owner = await createEvidenceSourceOwner({ projectRoot, dataDir, config, scannerFactory: async () => scanner });
  if (owner.code !== "ok") throw Error("owner unavailable");
  const chunks = chunkArchiveEvidence({ ...ref, records: source.records });
  const store = openEvidenceStorage(projectRoot), lifecycle = createEvidenceLifecycle(store);
  const options = { store, lifecycle, scopeHash: "b".repeat(64), ...owner.owner };
  try {
    expect(await owner.owner.validateSources([ref], new AbortController().signal, chunks)).toBe(true);
    const reordered = chunks.map(chunk => Object.fromEntries(Object.entries(chunk).reverse())) as typeof chunks;
    expect(await owner.owner.validateSources([ref], new AbortController().signal, reordered)).toBe(true);

    for (const mutation of [
      { ...chunks[0]!, role: "tool" },
      { ...chunks[0]!, locator: { ...chunks[0]!.locator, endByte: 1 } },
      { ...chunks[0]!, text: "forged evidence", contentHash: hash("forged evidence") },
    ]) {
      mutation.chunkId = archiveChunkId(mutation);
      expect(await owner.owner.validateSources([ref], new AbortController().signal, [mutation, ...chunks.slice(1)])).toBe(false);
    }
    await publishValidatedEvidenceGeneration({ ...options, documents: [{ ...ref, records: source.records }] });
    const result = await searchValidatedEvidenceGeneration({ ...options, query: "archive" }, value => value);
    expect(result.code).toBe("ok");
    expect(result.items).toHaveLength(1);
    const { score, ...actualChunk } = result.items[0]! as typeof chunks[number] & { score: number };
    expect(score).toBeGreaterThan(0);
    expect(Number.isFinite(score)).toBe(true);
    expect(actualChunk).toEqual(chunks[0]!);
    expect(result.items[0]).toHaveProperty("locator", chunks[0]!.locator);
    const poisonedPointer = JSON.parse(store.read("CURRENT", 4096)!.toString());
    const poisoned = JSON.parse(store.read(poisonedPointer.generation, 256 * 1024 * 1024)!.toString());
    poisoned.chunks[0].role = "tool";
    poisoned.chunks[0].chunkId = archiveChunkId(poisoned.chunks[0]);
    const poisonedBytes = Buffer.from(JSON.stringify(poisoned));
    store.withWriter(() => {
      store.writeAtomic(poisonedPointer.generation, poisonedBytes);
      store.writeAtomic("CURRENT", Buffer.from(JSON.stringify({ ...poisonedPointer, sha256: hash(poisonedBytes.toString()) })));
    });
    const poisonedResult = await searchValidatedEvidenceGeneration({ ...options, query: "archive" }, value => value);
    expect(poisonedResult.code).toBe("source-unavailable");
    expect(poisonedResult.items).toEqual([]);
    await publishValidatedEvidenceGeneration({ ...options, documents: [{ ...ref, records: source.records }] });
    const pointer = JSON.parse(store.read("CURRENT", 4096)!.toString());
    const generation = JSON.parse(store.read(pointer.generation, 256 * 1024 * 1024)!.toString());
    generation.chunks[0].locator.endByte = -1;
    generation.chunks[0].chunkId = archiveChunkId(generation.chunks[0]);
    const bytes = Buffer.from(JSON.stringify(generation));
    store.withWriter(() => { store.writeAtomic(pointer.generation, bytes);
      store.writeAtomic("CURRENT", Buffer.from(JSON.stringify({ ...pointer, sha256: hash(bytes.toString()) }))); });
    expect((await searchValidatedEvidenceGeneration({ ...options, query: "archive" }, value => value)).code).toBe("index-corrupt");
    await publishValidatedEvidenceGeneration({ ...options, documents: [{ ...ref, records: source.records }] });
    expect((await searchValidatedEvidenceGeneration({ ...options, query: "archive" }, value => value)).code).toBe("ok");
    await lifecycle.sessionOwner.revokeSessionEvidence("fixture");
    const revoked = await searchValidatedEvidenceGeneration({ ...options, query: "archive" }, value => value);
    expect(revoked.items).toEqual([]);
  } finally { lifecycle.close(); store.close(); await rm(base, { recursive: true, force: true }); }
});
