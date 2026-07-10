import { afterEach, beforeEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryService } from "./service";
import { wikiAsk } from "../wiki/ask";

// AC-C0 / T-4: every default memory + gdwiki command runs with NO socket opened
// and NO network call. Mirrors capability/golden-rule.test.ts. The default
// (embeddings off) paths must never reach the capability seam's runtime import.

let root: string;

function decisionMd(title: string, extra = ""): string {
  return `# ${title}\n\nType: decision\nStatus: accepted\n${extra}\n## Summary\n\n${title} summary about caching and retries.\n\n## Tags\n\n- cache\n`;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-mem-nonet-"));
  const decisions = path.join(root, ".metaproject", "memory", "decisions");
  await mkdir(decisions, { recursive: true });
  await writeFile(path.join(decisions, "a.md"), decisionMd("Cache old"), "utf8");
  await writeFile(path.join(decisions, "b.md"), decisionMd("Cache new"), "utf8");
  await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "cache.md"),
    "# Cache architecture\n\nType: architecture\n\n## Summary\n\nA read-through cache fronts the datastore.\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("default memory + gdwiki commands open no socket (AC-C0, T-4)", async () => {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let networkAttempts = 0;

  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("network blocked by memory no-network sandbox");
  }) as unknown as typeof fetch;
  net.Socket.prototype.connect = function connect(this: net.Socket): net.Socket {
    networkAttempts += 1;
    throw new Error("socket blocked by memory no-network sandbox");
  } as typeof net.Socket.prototype.connect;

  try {
    const service = createMemoryService();
    await service.search({ cwd: root, query: "cache" });
    await service.index({ cwd: root });
    await service.supersede({ cwd: root, oldPath: "decisions/a.md", newPath: "decisions/b.md" });
    await wikiAsk({ cwd: root, question: "how does the cache work" });
  } finally {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  }

  expect(networkAttempts).toBe(0);
});
