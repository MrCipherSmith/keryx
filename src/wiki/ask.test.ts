import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiAsk } from "./ask";

// C4 (AC-C9): deterministic lexical retrieval over the project's OWN wiki +
// memory → citations + assembled answer. Reproducible; never mutates the store.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-wiki-ask-"));
  await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "billing.md"),
    "# Billing pipeline\n\nType: architecture\n\n## Summary\n\nInvoices are generated nightly and charged via the payment provider.\n",
    "utf8",
  );
  await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "retry.md"),
    "# Payment retries\n\nType: decision\nStatus: accepted\n\n## Summary\n\nFailed payment charges are retried with exponential backoff.\n",
    "utf8",
  );
  // A superseded memory entry that must NOT appear in citations (current-only).
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "old-payment.md"),
    "# Legacy payment flow\n\nType: decision\nStatus: superseded\nSuperseded-By: decisions/retry.md\n\n## Summary\n\nPayment charges used a synchronous legacy flow.\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function memorySnapshot(): Promise<string[]> {
  const dir = path.join(root, ".metaproject", "memory", "decisions");
  const files = await readdir(dir);
  return Promise.all(files.sort().map((f) => readFile(path.join(dir, f), "utf8")));
}

test("returns deterministic citations from wiki + memory and never mutates the store", async () => {
  const before = await memorySnapshot();
  const first = await wikiAsk({ cwd: root, question: "how are failed payments retried" });
  const second = await wikiAsk({ cwd: root, question: "how are failed payments retried" });

  // Deterministic: two runs are byte-identical.
  expect(second.answerMarkdown).toBe(first.answerMarkdown);
  expect(first.citations.length).toBeGreaterThan(0);

  // Provenance is confined to this project's wiki/memory.
  for (const citation of first.citations) {
    expect(
      citation.path.startsWith("wiki/") || citation.path.startsWith("memory/"),
    ).toBe(true);
  }
  // The superseded entry is excluded (current-only retrieval).
  expect(first.citations.some((c) => c.path === "memory/decisions/old-payment.md")).toBe(false);
  // The current retry decision is cited.
  expect(first.citations.some((c) => c.path === "memory/decisions/retry.md")).toBe(true);

  // Store is untouched.
  expect(await memorySnapshot()).toEqual(before);
});

test("assembled answer carries a Sources section listing the citation paths", async () => {
  const result = await wikiAsk({ cwd: root, question: "billing invoices payment" });
  expect(result.answerMarkdown).toContain("## Sources");
  for (const citation of result.citations) {
    expect(result.answerMarkdown).toContain(citation.path);
  }
});
