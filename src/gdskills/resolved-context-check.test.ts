import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectContextResolution } from "./context-resolver";
import { checkResolvedContext, formatResolvedHeadline, formatResolvedReport } from "./resolved-context-check";
import { sha256Hex } from "./project-rules";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const FLAT = ".metaproject/rules/project/styling.mdc";
const NESTED = ".metaproject/rules/project/core/styling.mdc";

async function fixture(): Promise<{ root: string; resolved: ProjectContextResolution; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-resolved-check-"));
  roots.push(root);
  const text = "---\nglobs: src/**\n---\nstyling\n";
  for (const rel of [FLAT, NESTED]) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
  }
  const sha = sha256Hex(text);
  const resolved: ProjectContextResolution = {
    schema: 1,
    for: "implement",
    files: ["src/a.ts"],
    entries: [{ kind: "rule", source: "project", path: FLAT, sha256: sha, bytes: text.length, reason: "glob:src/**", tier: "must_read", also_at: [NESTED] }],
    budget: { limitBytes: 1000, usedBytes: text.length, exceeded: false, limitSource: "default" },
    warnings: [],
  };
  return { root, resolved, sha };
}

test("citing the primary path or an also_at path with the pinned sha256 satisfies a must_read entry", async () => {
  const { root, resolved, sha } = await fixture();
  for (const cited of [FLAT, NESTED]) {
    const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [{ path: cited, sha256: sha }] } });
    expect(report.misses).toEqual([]);
    expect(report.drifted).toEqual([]);
  }
});

test("an also_at citation with the wrong sha256 is still a miss and reports what was cited", async () => {
  const { root, resolved, sha } = await fixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [{ path: NESTED, sha256: "0".repeat(64) }] } });
  expect(report.misses).toEqual([{ path: FLAT, reason: "glob:src/**", expected: sha, cited: "0".repeat(64) }]);
});

test("no citation at all is a miss without a cited sha256", async () => {
  const { root, resolved, sha } = await fixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [] } });
  expect(report.misses).toEqual([{ path: FLAT, reason: "glob:src/**", expected: sha }]);
});

test("a changed also_at file is reported as drift", async () => {
  const { root, resolved, sha } = await fixture();
  await writeFile(path.join(root, NESTED), "changed\n", "utf8");
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [{ path: FLAT, sha256: sha }] } });
  expect(report.drifted.map((drift) => drift.path)).toEqual([NESTED]);
});

// --- conditional reads (flow 462): proof for entries promoted by a condition ---

const DOC = "docs/STYLING.md";
const DOC_TEXT = [
  "# Styling",
  "",
  "## Tokens",
  "",
  "Use design tokens instead of hex values. Spacing follows the spacing scale, and colours come from semantic tokens only.",
  "",
  "## Layout",
  "",
  "Grid containers carry the gutters.",
  "",
].join("\n");
const GOOD_SUMMARY = "Use design tokens instead of hex values and follow the spacing scale";
const GLOB_REASON = "condition:glob:src/**/*.css";

type DocOptions = { text?: string; anchor?: string | null; reason?: string };

async function docFixture(options: DocOptions = {}): Promise<{ root: string; resolved: ProjectContextResolution; sha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-resolved-proof-"));
  roots.push(root);
  const text = options.text ?? DOC_TEXT;
  await mkdir(path.dirname(path.join(root, DOC)), { recursive: true });
  await writeFile(path.join(root, DOC), text, "utf8");
  const sha = sha256Hex(text);
  const anchor = options.anchor === undefined ? "Tokens" : options.anchor;
  const resolved: ProjectContextResolution = {
    schema: 1,
    for: "implement",
    files: ["src/a.css"],
    entries: [
      {
        kind: "contract",
        source: "project",
        path: DOC,
        sha256: sha,
        bytes: text.length,
        reason: options.reason ?? GLOB_REASON,
        tier: "must_read",
        description: "Tokens and spacing for every stylesheet.",
        ...(anchor !== null ? { anchor } : {}),
        condition: { globs: ["src/**/*.css"], keywords: [] },
      },
    ],
    budget: { limitBytes: 1000, usedBytes: text.length, exceeded: false, limitSource: "default" },
    warnings: [],
  };
  return { root, resolved, sha };
}

function cite(sha: string, extra: Record<string, unknown> = {}): { project_context_applied: unknown[] } {
  return { project_context_applied: [{ path: DOC, sha256: sha, how: "read", anchor: "Tokens", summary: GOOD_SUMMARY, ...extra }] };
}

function demoted(resolved: ProjectContextResolution): ProjectContextResolution {
  return { ...resolved, entries: resolved.entries.map((entry) => ({ ...entry, tier: "on_demand" as const, reason: "declared" })) };
}

test("summary: a promoted entry cited with its anchor and a summary in the section's own words passes", async () => {
  const { root, resolved, sha } = await docFixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha) });
  expect(report.misses).toEqual([]);
  expect(report.drifted).toEqual([]);
});

test("summary: a keyword-promoted entry is held to the same rules, and the anchor must equal the declared one exactly", async () => {
  const { root, resolved, sha } = await docFixture({ reason: "condition:keyword:styling" });
  expect((await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha) })).misses).toEqual([]);
  const wrong = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { anchor: "tokens" }) });
  expect(wrong.misses.map((miss) => miss.rule)).toEqual(["anchor"]);
});

test("summary: a missing or different anchor is its own miss that names the declared anchor", async () => {
  const { root, resolved, sha } = await docFixture();
  const different = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { anchor: "Layout" }) });
  expect(different.misses).toHaveLength(1);
  expect(different.misses[0]).toMatchObject({ path: DOC, rule: "anchor" });
  expect(different.misses[0]?.detail).toContain('"Layout"');
  expect(different.misses[0]?.detail).toContain('"Tokens"');

  const absent = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { anchor: undefined }) });
  expect(absent.misses.map((miss) => miss.rule)).toEqual(["anchor"]);
  expect(absent.misses[0]?.detail).toContain('"Tokens"');
});

test("summary: fewer than 40 characters is its own miss, counted after trimming, and says how many were given", async () => {
  const { root, resolved, sha } = await docFixture();
  const short = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { summary: "design tokens, spacing scale" }) });
  expect(short.misses.map((miss) => miss.rule)).toEqual(["summary-length"]);
  expect(short.misses[0]?.detail).toContain("28");
  expect(short.misses[0]?.detail).toContain("40");

  const padded = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { summary: `   design tokens, spacing scale${" ".repeat(30)}` }) });
  expect(padded.misses.map((miss) => miss.rule)).toEqual(["summary-length"]);

  const absent = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { summary: undefined }) });
  expect(absent.misses.map((miss) => miss.rule)).toEqual(["summary-length"]);
  expect(absent.misses[0]?.detail).toContain("no summary");
});

test("summary: fewer than three distinct section words of five letters or more is a miss, and a repeated word counts once", async () => {
  const { root, resolved, sha } = await docFixture();
  const none = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { summary: "I read the whole document carefully and it was all fine really" }),
  });
  expect(none.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
  expect(none.misses[0]?.detail).toContain('"Tokens"');

  const one = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { summary: "Tokens tokens TOKENS matter a lot here, said the team to everybody" }),
  });
  expect(one.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
  expect(one.misses[0]?.detail).toContain("1 distinct");
  expect(one.misses[0]?.detail).toContain("3 required");
});

test("summary: exactly two shared words is a miss, three pass", async () => {
  const { root, resolved, sha } = await docFixture();
  const two = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { summary: "Design tokens matter a lot here, said the team to everybody" }),
  });
  expect(two.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
  expect(two.misses[0]?.detail).toContain("2 distinct");
  expect(two.misses[0]?.detail).toContain("3 required");

  const three = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { summary: "Design tokens and the scale matter a lot here, said the team" }),
  });
  expect(three.misses).toEqual([]);
});

test("summary: words are compared case-insensitively and a word shorter than five letters never counts", async () => {
  const { root, resolved, sha } = await docFixture();
  const upper = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { summary: "DESIGN TOKENS REPLACE the COLOURS everywhere, SPACING too, ok" }) });
  expect(upper.misses).toEqual([]);

  const short = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { summary: "Use hex from the come only and then some more of it, and so on" }) });
  expect(short.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
});

test("summary: each failure is its own miss with its own reason line", async () => {
  const { root, resolved, sha } = await docFixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { anchor: "Layout", summary: "too short" }) });
  expect(report.misses.map((miss) => miss.rule)).toEqual(["anchor", "summary-length", "summary-words"]);
  const lines = formatResolvedReport(report);
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(line).toContain(`project context miss: ${DOC} (${GLOB_REASON})`);
  expect(new Set(lines).size).toBe(3);
});

test("summary: the words come from the anchored section only, not from the rest of the file", async () => {
  const { root, resolved, sha } = await docFixture();
  const report = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { summary: "Grid containers carry the gutters, said the layout section here" }),
  });
  expect(report.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
});

test("summary: a section with fewer than three qualifying words requires as many as it holds, and a section with none requires only the length", async () => {
  const one = await docFixture({ text: "## Tiny\n\nTokens only.\n", anchor: "Tiny" });
  const withWord = await checkResolvedContext({
    projectRoot: one.root,
    resolved: one.resolved,
    result: cite(one.sha, { anchor: "Tiny", summary: "The tokens are the only thing that matters in it" }),
  });
  expect(withWord.misses).toEqual([]);
  const without = await checkResolvedContext({
    projectRoot: one.root,
    resolved: one.resolved,
    result: cite(one.sha, { anchor: "Tiny", summary: "Nothing about the single word that the text holds here" }),
  });
  expect(without.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
  expect(without.misses[0]?.detail).toContain("1 required");

  const none = await docFixture({ text: "## Hex\n\nA b c.\n", anchor: "Hex" });
  const lengthOnly = await checkResolvedContext({
    projectRoot: none.root,
    resolved: none.resolved,
    result: cite(none.sha, { anchor: "Hex", summary: "Whatever the worker wrote that is long enough to pass" }),
  });
  expect(lengthOnly.misses).toEqual([]);
});

test("summary: letters of any script count, so a Russian section is checked on Russian words", async () => {
  const text = "## Токены\n\nИспользуйте дизайн-токены вместо цветов. Отступы берутся из шкалы.\n";
  const { root, resolved, sha } = await docFixture({ text, anchor: "Токены" });
  const ok = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { anchor: "Токены", summary: "Используйте токены вместо цветов, отступы берутся из шкалы" }),
  });
  expect(ok.misses).toEqual([]);
  const bad = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: cite(sha, { anchor: "Токены", summary: "Прочитал весь документ внимательно, всё понятно и логично" }),
  });
  expect(bad.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
});

test("summary: a declaration without an anchor takes the words from the whole file and needs no cited anchor", async () => {
  const { root, resolved, sha } = await docFixture({ anchor: null });
  const report = await checkResolvedContext({
    projectRoot: root,
    resolved,
    result: { project_context_applied: [{ path: DOC, sha256: sha, how: "followed", summary: "Grid containers carry the gutters and design tokens everywhere" }] },
  });
  expect(report.misses).toEqual([]);
});

test("summary: an anchored section that cannot be found in the file now is reported with the anchor, not skipped", async () => {
  const { root, resolved, sha } = await docFixture();
  await writeFile(path.join(root, DOC), "# Styling\n\nNo sections any more.\n", "utf8");
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha) });
  expect(report.misses.map((miss) => miss.rule)).toEqual(["summary-words"]);
  expect(report.misses[0]?.detail).toContain('"Tokens"');
  expect(report.drifted.map((drift) => drift.path)).toEqual([DOC]);
});

test("summary: an on_demand declared entry and a rule are not held to the proof, whatever they cite", async () => {
  const { root, resolved, sha } = await docFixture();
  const onDemand = demoted(resolved);
  expect((await checkResolvedContext({ projectRoot: root, resolved: onDemand, result: { project_context_applied: [] } })).misses).toEqual([]);
  expect((await checkResolvedContext({ projectRoot: root, resolved: onDemand, result: cite(sha, { summary: "x" }) })).misses).toEqual([]);

  const rule = await fixture();
  const withHow = await checkResolvedContext({
    projectRoot: rule.root,
    resolved: rule.resolved,
    result: { project_context_applied: [{ path: FLAT, sha256: rule.sha, how: "n/a" }] },
  });
  expect(withHow.misses).toEqual([]);
});

test("hash and n/a: a promoted entry cited with a different sha256 is a miss that names both hashes, as in flow 461", async () => {
  const { root, resolved, sha } = await docFixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite("0".repeat(64)) });
  expect(report.misses).toEqual([{ path: DOC, reason: GLOB_REASON, expected: sha, cited: "0".repeat(64) }]);
  expect(formatResolvedReport(report).join("\n")).toContain(`cited with sha256 ${"0".repeat(64)}, the resolver pinned ${sha}`);
});

test("hash and n/a: a promoted entry that is not cited at all is the single flow 461 miss", async () => {
  const { root, resolved, sha } = await docFixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: [] } });
  expect(report.misses).toEqual([{ path: DOC, reason: GLOB_REASON, expected: sha }]);
});

test("hash and n/a: a promoted entry cited only with how n/a is a miss, however good its summary", async () => {
  const { root, resolved, sha } = await docFixture();
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { how: "n/a" }) });
  expect(report.misses).toHaveLength(1);
  expect(report.misses[0]).toMatchObject({ path: DOC, rule: "how" });
  expect(report.misses[0]?.detail).toContain("n/a");
  expect(report.misses[0]?.detail).toContain("read");
  expect(formatResolvedReport(report)[0]).toContain(`project context miss: ${DOC} (${GLOB_REASON})`);
});

test("hash and n/a: citing the document twice, n/a and followed, is satisfied by the followed citation in either order", async () => {
  const { root, resolved, sha } = await docFixture();
  const na = { path: DOC, sha256: sha, how: "n/a" };
  const followed = { path: DOC, sha256: sha, how: "followed", anchor: "Tokens", summary: GOOD_SUMMARY };
  for (const list of [[na, followed], [followed, na]]) {
    expect((await checkResolvedContext({ projectRoot: root, resolved, result: { project_context_applied: list } })).misses).toEqual([]);
  }
});

test("drift: editing a promoted document between resolve and validate is reported as drift", async () => {
  const { root, resolved, sha } = await docFixture();
  const edited = `${DOC_TEXT}\nA new rule.\n`;
  await writeFile(path.join(root, DOC), edited, "utf8");
  const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha) });
  expect(report.drifted).toEqual([{ path: DOC, tier: "must_read", pinned: sha, current: sha256Hex(edited) }]);
  expect(formatResolvedReport(report).join("\n")).toContain("project context drift");
});

test("drift: an on_demand declared document that was edited is drift as well, and a deleted one can no longer be read", async () => {
  const { root, resolved } = await docFixture();
  const onDemand = demoted(resolved);
  await writeFile(path.join(root, DOC), "edited\n", "utf8");
  const edited = await checkResolvedContext({ projectRoot: root, resolved: onDemand, result: {} });
  expect(edited.drifted.map((drift) => [drift.path, drift.tier])).toEqual([[DOC, "on_demand"]]);
  await rm(path.join(root, DOC));
  const gone = await checkResolvedContext({ projectRoot: root, resolved: onDemand, result: {} });
  expect(gone.drifted[0]?.current).toBeUndefined();
});

test("summary: warn blocks nothing and block does, for the new proof misses as for flow 461 ones", async () => {
  for (const [enforcement, blocking] of [["warn", false], ["block", true]] as const) {
    const { root, resolved, sha } = await docFixture();
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ gdskills: { projectContext: { enforcement } } }), "utf8");
    const report = await checkResolvedContext({ projectRoot: root, resolved, result: cite(sha, { summary: "short" }) });
    expect(report.misses.length).toBeGreaterThan(0);
    expect(report.blocking).toBe(blocking);
    expect(formatResolvedHeadline(report)).toContain(`${report.misses.length} miss(es)`);
  }
});
