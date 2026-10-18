import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { knownSubcommandsFor } from "../cli-registry";
import { skillsCommand } from "./skills";
import type { ReferencesCheckReport, ReferencesSuggestion } from "../gdskills/references-check";

// Flow 462, T9: `keryx skills references check|suggest` and the import hint.
// The analysis is tested through the router, the way an operator reaches it.

const roots: string[] = [];
const startCwd = process.cwd();

afterEach(async () => {
  process.chdir(startCwd);
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void err.push(parts.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

const STYLING_DOC = "# Styling\n\nIntro.\n\n## Class conventions\n\nUse tokens, never raw colours.\n\n## Spacing\n\nUse the scale.\n";
const GOOD_DESCRIPTION = "Class naming and the Tailwind cascade contract.";
const RULE = "---\ndescription: styling\nglobs: src/**/*.css\nalwaysApply: false\n---\n\nRead `STYLING.md` before touching a class.\n";

type Declaration = { path: string; when: { globs?: string[]; keywords?: string[] }; anchor?: string | undefined; description: string };

/** `undefined` removes a field: an entry without an anchor is a declaration of the whole file. */
type Overrides = { [Key in keyof Declaration]?: Declaration[Key] | undefined };

function declaration(overrides: Overrides = {}): Declaration {
  const entry: Declaration = { path: "STYLING.md", when: { globs: ["src/**/*.css"], keywords: ["className"] }, anchor: "Class conventions", description: GOOD_DESCRIPTION };
  return {
    path: overrides.path ?? entry.path,
    when: overrides.when ?? entry.when,
    description: overrides.description ?? entry.description,
    ..."anchor" in overrides ? (overrides.anchor === undefined ? {} : { anchor: overrides.anchor }) : { anchor: entry.anchor },
  };
}

async function project(options: {
  rules?: Record<string, string>;
  files?: Record<string, string>;
  references?: Declaration[] | string;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-references-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject", "rules", "project"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{}\n", "utf8");
  for (const [name, text] of Object.entries(options.rules ?? { "styling.mdc": RULE })) {
    await mkdir(path.dirname(path.join(root, ".metaproject", "rules", "project", name)), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "rules", "project", name), text, "utf8");
  }
  for (const [name, text] of Object.entries(options.files ?? { "STYLING.md": STYLING_DOC })) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text, "utf8");
  }
  if (options.references !== undefined) {
    const text = typeof options.references === "string" ? options.references : `${JSON.stringify({ schema: 1, references: options.references }, null, 2)}\n`;
    await writeFile(path.join(root, ".metaproject", "rules", "project", "references.json"), text, "utf8");
  }
  process.chdir(root);
  return root;
}

async function check(...extra: string[]): Promise<{ out: string; err: string; report?: ReferencesCheckReport }> {
  const result = await capture(() => skillsCommand(["references", "check", ...extra]));
  return extra.includes("--json") ? { ...result, report: JSON.parse(result.out) as ReferencesCheckReport } : result;
}

function codes(report: ReferencesCheckReport | undefined, severity: "error" | "warning"): string[] {
  return (report?.findings ?? []).filter((finding) => finding.severity === severity).map((finding) => `${finding.code}:${finding.path}`);
}

async function listing(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const ref = relative === "" ? entry.name : `${relative}/${entry.name}`;
    found.push(ref);
    if (entry.isDirectory()) found.push(...(await listing(root, ref)));
  }
  return found.sort();
}

test("`references` is a known skills subcommand and the help lists check and suggest", async () => {
  expect(knownSubcommandsFor("skills")).toContain("references");
  const { out } = await capture(() => skillsCommand(["--help"]));
  expect(out).toContain("keryx skills references check");
  expect(out).toContain("keryx skills references suggest");
});

test("references check: a project whose declarations are sound reports nothing and exits 0", async () => {
  await project({ references: [declaration()] });
  const { out, err } = await check();
  expect(process.exitCode ?? 0).toBe(0);
  expect(err).toBe("");
  expect(out).toContain("0 errors");
  expect(out).toContain("0 warnings");
});

test("references check: a declared document that does not exist is an error naming the entry, and exits 1", async () => {
  await project({ references: [declaration(), declaration({ path: "docs/GONE.md", anchor: undefined })] });
  const { out, report } = await check("--json");
  expect(codes(report, "error")).toEqual(["document-missing:docs/GONE.md"]);
  expect(report?.ok).toBe(false);
  expect(process.exitCode).toBe(1);
  const text = await check();
  expect(text.out).toContain("docs/GONE.md");
  expect(out).toContain("document-missing");
});

test("references check: a declared document that resolves outside the project root is an error", async () => {
  const root = await project({ references: [declaration({ path: "linked.md", anchor: undefined })] });
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-skills-references-outside-"));
  roots.push(outside);
  await writeFile(path.join(outside, "SECRET.md"), "# Secret\n", "utf8");
  await symlink(path.join(outside, "SECRET.md"), path.join(root, "linked.md"));
  const { report } = await check("--json");
  expect(codes(report, "error")).toContain("document-outside-root:linked.md");
  expect(process.exitCode).toBe(1);
});

test("references check: a declared document over the size limit is an error", async () => {
  await project({
    references: [declaration({ anchor: undefined })],
    files: { "STYLING.md": `# Styling\n\n${"x".repeat(262145)}\n` },
  });
  const { report } = await check("--json");
  expect(codes(report, "error")).toEqual(["document-too-large:STYLING.md"]);
  expect(process.exitCode).toBe(1);
});

test("references check: an anchor that matches no heading is an error and lists the headings the file has", async () => {
  await project({ references: [declaration({ anchor: "Nonexistent section" })] });
  const { report } = await check("--json");
  expect(codes(report, "error")).toEqual(["anchor-not-found:STYLING.md"]);
  const finding = report?.findings.find((entry) => entry.code === "anchor-not-found");
  expect(finding?.message).toContain("Nonexistent section");
  expect(finding?.message).toContain("Class conventions");
  expect(process.exitCode).toBe(1);
});

test("references check: a description under 20 characters is a warning and does not fail the run", async () => {
  await project({ references: [declaration({ description: "Styling rules." })] });
  const { report } = await check("--json");
  expect(codes(report, "warning")).toEqual(["description-short:STYLING.md"]);
  expect(codes(report, "error")).toEqual([]);
  expect(report?.ok).toBe(true);
  expect(process.exitCode ?? 0).toBe(0);
});

test("references check: a keyword under 4 characters is a warning naming the keyword", async () => {
  await project({ references: [declaration({ when: { globs: ["src/**/*.css"], keywords: ["css", "className", "ui"] } })] });
  const { report } = await check("--json");
  expect(codes(report, "warning")).toEqual(["keyword-short:STYLING.md", "keyword-short:STYLING.md"]);
  const messages = (report?.findings ?? []).filter((entry) => entry.code === "keyword-short").map((entry) => entry.message);
  expect(messages.some((message) => message.includes('"css"'))).toBe(true);
  expect(messages.some((message) => message.includes('"ui"'))).toBe(true);
  expect(process.exitCode ?? 0).toBe(0);
});

test("references check: a citation with no declaration is a warning, and a missing references.json is not an error", async () => {
  await project({});
  const { report } = await check("--json");
  expect(report?.present).toBe(false);
  expect(codes(report, "error")).toEqual([]);
  expect(codes(report, "warning")).toEqual(["undeclared-citation:STYLING.md"]);
  expect(process.exitCode ?? 0).toBe(0);
});

test("references check: a declaration that no rule cites is a warning", async () => {
  await project({
    rules: { "styling.mdc": "---\ndescription: styling\nglobs: src/**/*.css\nalwaysApply: false\n---\n\nNo document is cited here.\n" },
    references: [declaration()],
  });
  const { report } = await check("--json");
  expect(codes(report, "warning")).toEqual(["unused-declaration:STYLING.md"]);
  expect(process.exitCode ?? 0).toBe(0);
});

test("references check: malformed JSON is an error that carries the loader's message", async () => {
  await project({ references: "{ not json" });
  const { out, err, report } = await check("--json");
  expect(process.exitCode).toBe(1);
  expect(report?.ok).toBe(false);
  expect(codes(report, "error")).toEqual([`invalid-file:.metaproject/rules/project/references.json`]);
  expect(report?.findings[0]?.message).toContain("is not valid JSON");
  expect(err).toBe("");
  expect(out).toContain("is not valid JSON");
});

test("references check: a schema violation names the entry", async () => {
  await project({ references: JSON.stringify({ schema: 1, references: [{ path: "STYLING.md", when: {}, description: GOOD_DESCRIPTION }] }) });
  const { report } = await check("--json");
  expect(process.exitCode).toBe(1);
  expect(report?.findings.some((entry) => entry.severity === "error" && entry.message.includes('references[0] ("STYLING.md")'))).toBe(true);
});

test("references check: --json carries the same findings the text report prints", async () => {
  await project({ references: [declaration({ description: "short", anchor: "Missing" })] });
  const json = await check("--json");
  process.exitCode = 0;
  const text = await check();
  for (const finding of json.report?.findings ?? []) {
    expect(text.out).toContain(finding.path);
    expect(text.out).toContain(finding.message);
  }
  expect(text.out).toContain(`${json.report?.errors} error`);
  expect(text.out).toContain(`${json.report?.warnings} warning`);
});

test("references check: an unknown action is refused with usage and exits 1", async () => {
  await project({});
  const { err } = await capture(() => skillsCommand(["references", "bogus"]));
  expect(err).toContain("keryx skills references");
  expect(process.exitCode).toBe(1);
});

test("references suggest: prints a skeleton for each undeclared citation and writes no file", async () => {
  const root = await project({});
  const before = await listing(root);
  const { out } = await capture(() => skillsCommand(["references", "suggest"]));
  const parsed = JSON.parse(out) as ReferencesSuggestion;
  expect(parsed.schema).toBe(1);
  expect(parsed.references).toHaveLength(1);
  const entry = parsed.references[0]!;
  expect(entry.path).toBe("STYLING.md");
  expect(entry.bytes).toBe(Buffer.byteLength(STYLING_DOC));
  expect(entry.anchorCandidates).toEqual(["Styling", "Class conventions", "Spacing"]);
  expect(entry.description).toBe("");
  expect(entry.when).toEqual({ globs: [], keywords: [] });
  expect(await listing(root)).toEqual(before);
  expect(process.exitCode ?? 0).toBe(0);
});

test("references suggest: leaves out citations that are already declared and prints an empty list when none remain", async () => {
  await project({ references: [declaration()] });
  const { out } = await capture(() => skillsCommand(["references", "suggest"]));
  expect((JSON.parse(out) as ReferencesSuggestion).references).toEqual([]);
});

test("references suggest: lists only citations that name a file inside the project", async () => {
  await project({
    rules: { "styling.mdc": `${RULE}\nAlso see \`docs/missing.md\`, \`../outside.md\` and \`THEMING.md\`; rule \`core/other.mdc\`.\n` },
    files: { "STYLING.md": STYLING_DOC, "THEMING.md": "# Theming\n" },
  });
  const { out } = await capture(() => skillsCommand(["references", "suggest"]));
  expect((JSON.parse(out) as ReferencesSuggestion).references.map((entry) => entry.path)).toEqual(["STYLING.md", "THEMING.md"]);
});

test("references suggest: a malformed references.json is reported and exits 1 instead of guessing what is declared", async () => {
  await project({ references: "{ not json" });
  const { out, err } = await capture(() => skillsCommand(["references", "suggest"]));
  expect(out).toBe("");
  expect(err).toContain("is not valid JSON");
  expect(process.exitCode).toBe(1);
});

async function importProject(ruleText: string, files: Record<string, string>): Promise<{ root: string; source: string }> {
  const root = await project({ rules: {}, files });
  const source = path.join(root, "upstream-rules");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "styling.mdc"), ruleText, "utf8");
  return { root, source };
}

test("references suggest: skills import --rules ends with the count of undeclared citations and the command to run", async () => {
  const { source } = await importProject(RULE, { "STYLING.md": STYLING_DOC });
  const { out } = await capture(() => skillsCommand(["import", "--rules", source]));
  const lines = out.trimEnd().split("\n");
  expect(lines.at(-1)).toContain("keryx skills references suggest");
  expect(lines.at(-2)).toContain("1 cited document");
  expect(out).toContain("imported");
});

test("references suggest: skills import --rules prints no hint when every citation is declared or none exists", async () => {
  const withoutCitation = await importProject("---\ndescription: s\nglobs: src/**/*.css\nalwaysApply: false\n---\n\nNo citation.\n", {});
  const quiet = await capture(() => skillsCommand(["import", "--rules", withoutCitation.source]));
  expect(quiet.out).not.toContain("references suggest");

  const declared = await importProject(RULE, { "STYLING.md": STYLING_DOC });
  await mkdir(path.join(declared.root, ".metaproject", "rules", "project"), { recursive: true });
  await writeFile(
    path.join(declared.root, ".metaproject", "rules", "project", "references.json"),
    `${JSON.stringify({ schema: 1, references: [declaration()] })}\n`,
    "utf8",
  );
  const done = await capture(() => skillsCommand(["import", "--rules", declared.source]));
  expect(done.out).not.toContain("references suggest");
});

test("references suggest: skills import --rules --json stays pure JSON", async () => {
  const { source } = await importProject(RULE, { "STYLING.md": STYLING_DOC });
  const { out } = await capture(() => skillsCommand(["import", "--rules", source, "--json"]));
  expect(() => JSON.parse(out)).not.toThrow();
});
