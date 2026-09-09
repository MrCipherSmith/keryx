import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TemporalValidationError } from "../memory/temporal";
import { wikiAsk } from "./ask";

// C4 (AC-C9): deterministic lexical retrieval over the project's OWN wiki +
// memory → citations + assembled answer. Reproducible; never mutates the store.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-wiki-ask-"));
  await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "billing.md"),
    "# Billing pipeline\n\nType: architecture\nStatus: accepted\n\n## Summary\n\nInvoices are generated nightly and charged via the payment provider.\n",
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
    "# Счет пользователя\n\nStatus: accepted\n\n## Summary\n\nСчет создается в конце дня после успешной оплаты.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Как работает счет" });
  expect(result.citations.length).toBeGreaterThan(0);
  expect(result.answerMarkdown).toContain("Счет");
});

test("falls back to translation when Russian query matches English corpus", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "gate.md"),
    "# Security gate\n\nStatus: accepted\n\nThe security gate validates all risky operations and returns allow/deny decisions.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Как работает шлюз" });
  expect(result.citations).toContainEqual(expect.objectContaining({ path: "wiki/architecture/gate.md" }));
});

// AFC-30 (flow 235) T5 — "pure search не пишет history".
//
// These three tests replace the ones that asserted the OPPOSITE: that a
// Russian fallback persisted the user's own query text, its derived
// translation and a timestamp into
// `.metaproject/runtime/wiki-ask/translations.json`, and that a later query
// read that file back. Measured on this repository before the change:
// `keryx wiki ask "какая политика безопасности"` created that file containing
// `{"phrases":{"какая политика безопасности":"which policy безопасности"},…}`.
// The writer ran from `wikiAsk` itself, so it fired from the CLI, from MCP
// `wiki.ask` (declared `mutating: false`) and from the agent `wiki_ask` op
// (declared `risk: "read"`) alike — a tool-contract violation as well as an
// AC-30 one. The learned dictionary was also derived from this same heuristic's
// own output, which `wiki-specification.md` §3 excludes for aliases: they must
// be explicit versioned data, "не скрытая LLM-генерация". The capability is
// removed rather than reworked, and the fixed RU→EN table below still carries
// the cross-lingual case (see the fallback test above).
test("a Russian fallback answers without writing anything", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "session.md"),
    "# Session lifecycle\n\nStatus: accepted\n\n## Summary\n\nHow work session keeps command context after pause.\n",
    "utf8",
  );
  const result = await wikiAsk({ cwd: root, question: "Как работают сессии" });
  expect(result.citations).toContainEqual(
    expect.objectContaining({ path: "wiki/architecture/session.md" }),
  );

  expect(await readRuntimeDictionary()).toBeNull();
});

test("no wiki ask, in any language, creates the runtime directory at all", async () => {
  await wikiAsk({ cwd: root, question: "какая политика безопасности" });
  await wikiAsk({ cwd: root, question: "how are failed payments retried" });
  await wikiAsk({ cwd: root, question: "the of and is a" });

  expect(
    await Bun.file(path.join(root, ".metaproject", "runtime", "wiki-ask", "translations.json")).exists(),
  ).toBe(false);
  expect(await Bun.file(path.join(root, ".metaproject", "runtime")).exists()).toBe(false);
});

test("a pre-existing runtime dictionary is neither read nor rewritten", async () => {
  const runtimeDictionaryPath = path.join(
    root,
    ".metaproject",
    "runtime",
    "wiki-ask",
    "translations.json",
  );
  await mkdir(path.join(root, ".metaproject", "runtime", "wiki-ask"), { recursive: true });
  const seeded = `${JSON.stringify(
    { schemaVersion: 1, phrases: { "квазифраза для проверки": "validation token check" }, terms: {} },
    null,
    2,
  )}\n`;
  await writeFile(runtimeDictionaryPath, seeded, "utf8");
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "validation.md"),
    "# Validation token check\n\nStatus: accepted\n\nUse this for internal validation tokens.\n",
    "utf8",
  );

  const result = await wikiAsk({ cwd: root, question: "Квазифраза для проверки" });
  // The phrase is not in the fixed table, so it does not resolve — and that is
  // the honest outcome. A hidden, self-generated dictionary answering it was
  // the defect, not the feature.
  expect(result.status).not.toBe("ok");
  // Byte-identical: the file was not rewritten either.
  expect(await readFile(runtimeDictionaryPath, "utf8")).toBe(seeded);
});

// AFC-06 (flow 234, T14, defect 1): the local `isCurrent` used to gate
// memory candidates never checked `validFrom`/`status` and compared
// `validTo` as an unvalidated raw string. Each of these entries is wrong to
// admit as "current" under the AC1 formula (accepted AND validFrom<=now AND
// (no validTo OR now<validTo) AND no effective supersededBy).
test("AC1 defect 1: memory citations exclude future-dated, non-accepted, and malformed entries", async () => {
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "future-plan.md"),
    "# Future plan rollout\nType: decision\nStatus: accepted\nValid-From: 2999-01-01\n\n## Summary\n\nFuture plan rollout instructions for retries.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "draft-plan.md"),
    "# Draft plan rollout\nType: decision\nStatus: draft\n\n## Summary\n\nDraft plan rollout instructions for retries.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "memory", "decisions", "malformed-plan.md"),
    "# Malformed plan rollout\nType: decision\nStatus: accepted\nValid-To: not-a-date\n\n## Summary\n\nMalformed plan rollout instructions for retries.\n",
    "utf8",
  );

  const result = await wikiAsk({ cwd: root, question: "future draft malformed plan rollout retries instructions" });
  const paths = result.citations.map((c) => c.path);

  expect(paths).not.toContain("memory/decisions/future-plan.md");
  expect(paths).not.toContain("memory/decisions/draft-plan.md");
  expect(paths).not.toContain("memory/decisions/malformed-plan.md");
});

// AFC-06 (flow 234), T18 item 1: `wikiCandidates` used to admit every wiki
// page unconditionally -- a future-dated, deprecated or superseded page was
// cited today as though it were current, even though `collectPages` (T14
// defect 3) already exposes the lifecycle fields on `WikiPage`. This is the
// larger half of AC1: wiki must admit/reject through the same shared
// `computeLifecycle` memory candidates already use (see `memoryCandidates`
// and the AC1 defect 1 test above).
test("AC1 (wiki): future-dated, deprecated, and superseded wiki pages are excluded from citations", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "future-rollout.md"),
    "# Future rollout probe\n\nType: architecture\nStatus: accepted\nValidFrom: 2999-01-01\n\n## Summary\n\nWiki lifecycle admission probe for future rollout instructions.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "deprecated-rollout.md"),
    "# Deprecated rollout probe\n\nType: architecture\nStatus: deprecated\n\n## Summary\n\nWiki lifecycle admission probe for deprecated rollout instructions.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "superseded-rollout.md"),
    "# Superseded rollout probe\n\nType: architecture\nStatus: accepted\nSupersededBy: architecture/replacement.md\n\n## Summary\n\nWiki lifecycle admission probe for superseded rollout instructions.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "current-rollout.md"),
    "# Current rollout probe\n\nType: architecture\nStatus: accepted\n\n## Summary\n\nWiki lifecycle admission probe for current rollout instructions.\n",
    "utf8",
  );

  const result = await wikiAsk({ cwd: root, question: "wiki lifecycle admission probe rollout instructions" });
  const paths = result.citations.map((c) => c.path);

  expect(paths).not.toContain("wiki/architecture/future-rollout.md");
  expect(paths).not.toContain("wiki/architecture/deprecated-rollout.md");
  expect(paths).not.toContain("wiki/architecture/superseded-rollout.md");
  expect(paths).toContain("wiki/architecture/current-rollout.md");
});

// AFC-06 (flow 234), T18 item 3, restored after T20. The two surfaces spell
// these fields differently and always have: memory frontmatter hyphenates
// them, wiki frontmatter does not. An author who copies a working entry from
// one surface to the other otherwise gets a field that parses to nothing and
// a page admitted when the rule says reject it, which is a silent trap in the
// direction that releases.
//
// T18 covered it by re-reading each page's raw bytes through the alias-aware
// parser. T20 removed that re-read, correctly: its stated justification was
// false and it cost a second pass over every page. But it also dropped the
// alias support and rewrote this test to assert the loss. The fallback
// belongs in the collector, which is where it now lives, so the retrieval
// path stays a single pass AND the trap stays closed.
test("AC1 (wiki): a hyphenated Valid-From, the memory spelling, is honoured on the wiki path", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "hyphenated-future.md"),
    "# Hyphenated future probe\n\nType: architecture\nStatus: accepted\nValid-From: 2999-01-01\n\n## Summary\n\nHyphenated spelling admission probe rollout instructions.\n",
    "utf8",
  );

  const result = await wikiAsk({ cwd: root, question: "hyphenated spelling admission probe rollout instructions" });
  const paths = result.citations.map((c) => c.path);

  // Future-dated under either spelling, so it is not current and not cited.
  expect(paths).not.toContain("wiki/architecture/hyphenated-future.md");
});

test("repeated identical questions are byte-identical and leave the tree untouched", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "session-mode.md"),
    "# Session mode\n\nStatus: accepted\n\nSession mode configures context switching between command runs.\n",
    "utf8",
  );

  const first = await wikiAsk({ cwd: root, question: "session mode context switching" });
  expect(first.citations).toContainEqual(
    expect.objectContaining({ path: "wiki/architecture/session-mode.md" }),
  );

  const second = await wikiAsk({ cwd: root, question: "session mode context switching" });
  // Determinism is what makes "the second run reused something it learned"
  // observable at all: with nothing persisted, both runs must be identical.
  expect(second).toEqual(first);
  expect(await readRuntimeDictionary()).toBeNull();
});

// AFC-06 (flow 234) T22 -- AC1's second half: "historical режим явно
// размечен". Default retrieval must stay exactly as the tests above already
// pin it (no `asOf` ⇒ non-current items excluded, no `historical` field on
// any citation); `asOf` is the explicit mode the policy requires before
// history becomes reachable at all, and every non-current item it admits
// must carry the SAME `state`/`reasons` vocabulary `computeLifecycle`
// produces (`../memory/lifecycle.ts`), visibly in both the citation objects
// and the markdown a model actually reads.
test("historical mode (default, no --as-of): deprecated wiki page and superseded memory entry stay excluded, and no citation carries a historical marker", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "deprecated-probe.md"),
    "# Deprecated probe\n\nType: architecture\nStatus: deprecated\n\n## Summary\n\nHistorical mode admission probe deprecated architecture instructions.\n",
    "utf8",
  );

  const result = await wikiAsk({
    cwd: root,
    question: "historical mode admission probe deprecated architecture instructions failed payments retried",
  });
  const paths = result.citations.map((c) => c.path);

  expect(paths).not.toContain("wiki/architecture/deprecated-probe.md");
  expect(paths).not.toContain("memory/decisions/old-payment.md");
  for (const citation of result.citations) {
    expect(citation.historical).toBeUndefined();
  }
  expect(result.answerMarkdown).not.toContain("HISTORICAL");
});

test("historical mode (--as-of / asOf given): a deprecated wiki page and a superseded memory entry are admitted and labelled with their lifecycle state and reason", async () => {
  await writeFile(
    path.join(root, ".metaproject", "wiki", "architecture", "deprecated-probe.md"),
    "# Deprecated probe\n\nType: architecture\nStatus: deprecated\n\n## Summary\n\nHistorical mode admission probe deprecated architecture instructions.\n",
    "utf8",
  );

  const today = new Date().toISOString().slice(0, 10);
  const result = await wikiAsk({
    cwd: root,
    question:
      "historical mode admission probe deprecated architecture instructions legacy payment flow synchronous charges",
    asOf: today,
  });

  const wikiCitation = result.citations.find((c) => c.path === "wiki/architecture/deprecated-probe.md");
  expect(wikiCitation).toBeDefined();
  expect(wikiCitation?.historical).toBe(true);
  expect(wikiCitation?.lifecycleState).toBe("deprecated");
  expect(wikiCitation?.lifecycleReasons).toEqual(["status-deprecated"]);

  const memoryCitation = result.citations.find((c) => c.path === "memory/decisions/old-payment.md");
  expect(memoryCitation).toBeDefined();
  expect(memoryCitation?.historical).toBe(true);
  expect(memoryCitation?.lifecycleState).toBe("superseded");

  // Current items in the same result carry no historical marker.
  const currentCitation = result.citations.find((c) => c.path === "memory/decisions/retry.md");
  expect(currentCitation).toBeDefined();
  expect(currentCitation?.historical).toBeUndefined();

  // The marking is legible in the actual text output, not only the JSON shape.
  expect(result.answerMarkdown).toContain("HISTORICAL");
  expect(result.answerMarkdown).toContain("state=deprecated");
  expect(result.answerMarkdown).toContain("state=superseded");
});

test("historical mode: a malformed --as-of date is rejected the same way memory's --as-of already is", async () => {
  await expect(
    wikiAsk({ cwd: root, question: "billing invoices payment", asOf: "not-a-date" }),
  ).rejects.toThrow(TemporalValidationError);
});
