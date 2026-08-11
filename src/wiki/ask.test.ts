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

async function readRuntimeDictionary(): Promise<Record<string, unknown> | null> {
  const candidate = path.join(root, ".metaproject", "runtime", "wiki-ask", "translations.json");
  try {
    return JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
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

test("answers are supported for Russian questions", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "payments-ru.md"),
    "# Счет пользователя\n\n## Summary\n\nСчет создается в конце дня после успешной оплаты.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Как работает счет" });
  expect(result.citations.length).toBeGreaterThan(0);
  expect(result.answerMarkdown).toContain("Счет");
});

test("falls back to translation when Russian query matches English corpus", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "gate.md"),
    "# Security gate\n\nThe security gate validates all risky operations and returns allow/deny decisions.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Как работает шлюз" });
  expect(result.citations).toContainEqual(expect.objectContaining({ path: "wiki/architecture/gate.md" }));
});

test("persists dynamic translation after successful russian fallback", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "session.md"),
    "# Session lifecycle\n\n## Summary\n\nHow work session keeps command context after pause.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Как работают сессии" });
  expect(result.citations).toContainEqual(expect.objectContaining({ path: "wiki/architecture/session.md" }));

  const dictionary = await readRuntimeDictionary();
  expect(dictionary).not.toBeNull();
  expect((dictionary as { phrases?: Record<string, string> })?.phrases).toBeDefined();
  expect(
    (dictionary as { phrases?: Record<string, string> })?.phrases?.["как работают сессии"],
  ).toBeTruthy();
});

test("uses persisted runtime translations without rebuilding fallback", async () => {
  const runtimeDictionaryPath = path.join(
    root,
    ".metaproject",
    "runtime",
    "wiki-ask",
    "translations.json",
  );
  await mkdir(path.join(root, ".metaproject", "runtime", "wiki-ask"), { recursive: true });
  await writeFile(
    runtimeDictionaryPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        phrases: {
          "квазифраза для проверки": "validation token check",
        },
        terms: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "validation.md"),
    "# Validation token check\n\nUse this for internal validation tokens.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Квазифраза для проверки" });
  expect(result.citations).toContainEqual(expect.objectContaining({ path: "wiki/architecture/validation.md" }));
});
