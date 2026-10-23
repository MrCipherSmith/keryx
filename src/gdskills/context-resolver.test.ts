import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importProjectRules } from "./import-rules";
import { type ContextEntry, LAST_RESOLVE_PATH, readLastResolve, recordLastResolve, resolveProjectContext, TASK_TEXT_MAX_CHARS } from "./context-resolver";
import { runResolveContextCommand } from "./resolve-context-command";
import { sha256Hex } from "./project-rules";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type RuleSpec = { globs?: string; always?: boolean; description?: string; body?: string; size?: number; taskTypes?: string };

function ruleText(spec: RuleSpec): string {
  const head = [
    "---",
    `description: ${spec.description ?? "a rule"}`,
    ...(spec.globs !== undefined ? [`globs: ${spec.globs}`] : []),
    `alwaysApply: ${spec.always === true ? "true" : "false"}`,
    ...(spec.taskTypes !== undefined ? [`taskTypes: ${spec.taskTypes}`] : []),
    "---",
    "",
  ].join("\n");
  const body = spec.body ?? "Rule body.\n";
  const text = head + body;
  if (spec.size === undefined) return text;
  if (text.length > spec.size) throw new Error(`rule text is already ${text.length} bytes`);
  return text + "x".repeat(spec.size - text.length);
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-context-resolver-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  return root;
}

async function put(root: string, rel: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text, "utf8");
}

async function importRules(root: string, rules: Record<string, string>, link = false): Promise<string> {
  const source = await mkdtemp(path.join(tmpdir(), "keryx-context-resolver-src-"));
  roots.push(source);
  for (const [ref, text] of Object.entries(rules)) await put(source, ref, text);
  await importProjectRules({ projectRoot: root, from: source, link });
  return source;
}

async function core(root: string, names: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(names)) await put(root, `.metaproject/rules/core/${name}`, text);
}

const paths = (entries: ContextEntry[]): string[] => entries.map((entry) => entry.path);
const P = (ref: string): string => `.metaproject/rules/project/${ref}`;
const C = (name: string): string => `.metaproject/rules/core/${name}`;

test("every project entry precedes every bundled entry, sha256 is the hash of the file bytes, and the output is byte-identical on a second run", async () => {
  const root = await project();
  await core(root, { "tdd-workflow.mdc": "tdd\n", "error-handling.mdc": "errors\n" });
  const styling = ruleText({ globs: "src/**/*.tsx" });
  await importRules(root, { "styling.mdc": styling });
  const first = await resolveProjectContext({ projectRoot: root, files: ["src/a.tsx"], taskType: "ui_component", for: "implement" });
  const second = await resolveProjectContext({ projectRoot: root, files: ["src/a.tsx"], taskType: "ui_component", for: "implement" });
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(paths(first.entries)).toEqual([P("styling.mdc"), C("tdd-workflow.mdc"), C("error-handling.mdc")]);
  expect(first.entries.map((entry) => entry.source)).toEqual(["project", "bundled", "bundled"]);
  expect(first.entries[0]?.sha256).toBe(sha256Hex(styling));
  expect(first.entries[0]?.bytes).toBe(Buffer.byteLength(styling));
  expect(first.entries[0]?.reason).toBe("glob:src/**/*.tsx");
  expect(first.schema).toBe(1);
  expect(first.for).toBe("implement");
});

test("a project rule that shares a ref with a bundled rule removes the bundled entry and records shadows", async () => {
  const root = await project();
  await core(root, { "tdd-workflow.mdc": "tdd\n", "error-handling.mdc": "bundled errors\n" });
  await importRules(root, { "error-handling.mdc": ruleText({ globs: "src/**/*.ts" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], taskType: "fix", for: "implement" });
  expect(paths(result.entries)).toEqual([P("error-handling.mdc"), C("tdd-workflow.mdc")]);
  expect(result.entries[0]?.shadows).toBe(C("error-handling.mdc"));
});

test("a project rule with a bundled name is read even when its globs do not match, because it replaces the bundled one", async () => {
  const root = await project();
  await core(root, { "error-handling.mdc": "bundled errors\n" });
  await importRules(root, { "error-handling.mdc": ruleText({ globs: "docs/**" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], taskType: "fix", for: "implement" });
  expect(result.entries.map((entry) => [entry.path, entry.reason, entry.tier])).toEqual([[P("error-handling.mdc"), "replaces-bundled", "must_read"]]);
});

test("a project rule under rules/project/core/ shadows the bundled rule of the same name, as a flat one does", async () => {
  const root = await project();
  await core(root, { "tdd-workflow.mdc": "tdd\n", "frontend-assistant.mdc": "bundled frontend\n", "storybook-guidelines.mdc": "bundled stories\n" });
  await importRules(root, { "core/storybook-guidelines.mdc": ruleText({ globs: "src/**/*.tsx" }), "core/frontend-assistant.mdc": ruleText({ globs: "docs/**" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.tsx"], taskType: "ui_component", for: "implement" });
  expect(result.entries.map((entry) => [entry.path, entry.reason, entry.shadows])).toEqual([
    [P("core/storybook-guidelines.mdc"), "glob:src/**/*.tsx", C("storybook-guidelines.mdc")],
    [P("core/frontend-assistant.mdc"), "replaces-bundled", C("frontend-assistant.mdc")],
    [C("tdd-workflow.mdc"), "bundled-default", undefined],
  ]);
  expect(result.warnings).toEqual([]);
});

test("selection: glob match, brace globs, a small alwaysApply rule, a task type; a rule that matches nothing is absent", async () => {
  const root = await project();
  await importRules(root, {
    "styling.mdc": ruleText({ globs: "src/**/*.css" }),
    "components.mdc": ruleText({ globs: "src/**/*.{ts,tsx}" }),
    "unquoted.mdc": ruleText({ globs: "lib/**/*.{ts,tsx}" }),
    "always.mdc": ruleText({ always: true }),
    "typed.mdc": ruleText({ taskTypes: "[store_logic]" }),
    "docs.mdc": ruleText({ globs: "docs/**" }),
  });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.tsx", "lib/b.ts"], taskType: "store_logic", for: "implement" });
  const byPath = new Map(result.entries.map((entry) => [entry.path, entry.reason]));
  expect(byPath.get(P("components.mdc"))).toBe("glob:src/**/*.{ts,tsx}");
  expect(byPath.get(P("unquoted.mdc"))).toBe("glob:lib/**/*.{ts,tsx}");
  expect(byPath.get(P("always.mdc"))).toBe("always");
  expect(byPath.get(P("typed.mdc"))).toBe("task-type:store_logic");
  expect(byPath.has(P("styling.mdc"))).toBe(false);
  expect(byPath.has(P("docs.mdc"))).toBe(false);
});

test("an alwaysApply rule above 30,720 bytes is an index: listed on_demand with index true and not counted against the cap", async () => {
  const root = await project();
  await importRules(root, { "AGENTS.mdc": ruleText({ always: true, size: 30721 }), "small.mdc": ruleText({ always: true, size: 30720 }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.tsx"], for: "implement" });
  const index = result.entries.find((entry) => entry.path === P("AGENTS.mdc"));
  expect(index).toMatchObject({ tier: "on_demand", index: true, bytes: 30721 });
  const small = result.entries.find((entry) => entry.path === P("small.mdc"));
  expect(small).toMatchObject({ tier: "must_read", bytes: 30720 });
  expect(small?.index).toBeUndefined();
  expect(result.budget.usedBytes).toBe(30720);
  expect(result.budget.exceeded).toBe(false);
});

test("the bundled task-type table adds the rules it adds today, only those present; with no project content the output is that bundled list", async () => {
  const root = await project();
  await core(root, {
    "tdd-workflow.mdc": "a\n",
    "error-handling.mdc": "b\n",
    "solid-principles.mdc": "c\n",
    "code-style-patterns.mdc": "d\n",
    "mobx-store-template.mdc": "e\n",
    "nestjs-dto.mdc": "f\n",
  });
  const store = await resolveProjectContext({ projectRoot: root, files: ["src/s.ts"], taskType: "store_logic", for: "implement" });
  expect(paths(store.entries)).toEqual([C("tdd-workflow.mdc"), C("error-handling.mdc"), C("solid-principles.mdc"), C("code-style-patterns.mdc"), C("mobx-store-template.mdc")]);
  expect(store.entries.every((entry) => entry.source === "bundled" && entry.tier === "must_read")).toBe(true);
  expect(store.budget).toMatchObject({ usedBytes: 0, exceeded: false });
  const mixed = await resolveProjectContext({ projectRoot: root, files: ["src/s.ts"], taskType: "mixed", for: "implement" });
  expect(paths(mixed.entries)).toContain(C("nestjs-dto.mdc"));
  const none = await resolveProjectContext({ projectRoot: root, files: ["src/s.ts"], for: "implement" });
  expect(paths(none.entries)).toEqual([C("tdd-workflow.mdc"), C("error-handling.mdc"), C("solid-principles.mdc")]);
});

test("for test returns testing skills and project rules for the test files; for review returns project rules only", async () => {
  const root = await project();
  await core(root, { "tdd-workflow.mdc": "tdd\n", "testing-conventions.mdc": "conv\n" });
  await importRules(root, { "testing.mdc": ruleText({ globs: "src/**/*.test.tsx" }), "styling.mdc": ruleText({ globs: "src/**/*.css" }) });
  for (const [module, name] of [["testing", "msw"], ["implementation", "stores"]] as const) {
    await put(root, `.metaproject/project-skills/${module}/${name}/SKILL.md`, `---\nname: ${name}\n---\nbody\n`);
  }
  await put(
    root,
    ".metaproject/metaproject.json",
    JSON.stringify({
      modules: {
        gdskills: {
          projectSkillRegistry: [
            { module: "testing", name: "msw", target: "src/**/*.test.tsx", path: ".metaproject/project-skills/testing/msw", version: "1.0.0", status: "active", updatedAt: "x" },
            { module: "implementation", name: "stores", target: "src/stores", path: ".metaproject/project-skills/implementation/stores", version: "1.0.0", status: "active", taskTypes: ["store_logic"], updatedAt: "x" },
          ],
        },
      },
    }),
  );
  const test_ = await resolveProjectContext({ projectRoot: root, files: ["src/a.test.tsx"], taskType: "ui_component", for: "test" });
  expect(paths(test_.entries)).toEqual([P("testing.mdc"), ".metaproject/project-skills/testing/msw/SKILL.md", C("tdd-workflow.mdc"), C("testing-conventions.mdc")]);
  expect(test_.entries.find((entry) => entry.kind === "skill")).toMatchObject({ source: "project", reason: "route" });

  const impl = await resolveProjectContext({ projectRoot: root, files: ["src/s.ts"], taskType: "store_logic", for: "implement" });
  expect(paths(impl.entries)).toContain(".metaproject/project-skills/implementation/stores/SKILL.md");
  const wrongType = await resolveProjectContext({ projectRoot: root, files: ["src/s.ts"], taskType: "ui_component", for: "implement" });
  expect(paths(wrongType.entries)).not.toContain(".metaproject/project-skills/implementation/stores/SKILL.md");

  const review = await resolveProjectContext({ projectRoot: root, files: ["src/a.css"], taskType: "ui_component", for: "review" });
  expect(paths(review.entries)).toEqual([P("styling.mdc")]);
});

test("ordering: a literal glob before a wildcard glob, fewer matched files before more, then smaller size, then path", async () => {
  const root = await project();
  await importRules(root, {
    "a-wide.mdc": ruleText({ globs: "src/**/*.tsx", size: 300 }),
    "b-narrow.mdc": ruleText({ globs: "src/one/*.tsx", size: 400 }),
    "c-literal.mdc": ruleText({ globs: "src/one/a.tsx", size: 500 }),
    "d-small.mdc": ruleText({ globs: "src/**/*.tsx", size: 200 }),
    "e-always.mdc": ruleText({ always: true, size: 100 }),
  });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/one/a.tsx", "src/two/b.tsx"], for: "implement" });
  expect(paths(result.entries)).toEqual([P("c-literal.mdc"), P("b-narrow.mdc"), P("d-small.mdc"), P("a-wide.mdc"), P("e-always.mdc")]);
});

test("budget at the cap and one byte over, for the default cap, a configured cap and the flag", async () => {
  const root = await project();
  await importRules(root, { "only.mdc": ruleText({ globs: "src/**", size: 4096 }) });
  const at = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement", maxBytes: 4096 });
  expect(at.entries[0]?.tier).toBe("must_read");
  expect(at.budget).toEqual({ limitBytes: 4096, usedBytes: 4096, exceeded: false, limitSource: "flag" });
  expect(at.warnings).toEqual([]);

  await put(root, ".metaproject/rules/project/only.mdc", ruleText({ globs: "src/**", size: 4097 }));
  const over = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement", maxBytes: 4096 });
  expect(over.entries[0]).toMatchObject({ tier: "on_demand", description: "a rule" });
  expect(over.budget).toEqual({ limitBytes: 4096, usedBytes: 0, exceeded: true, limitSource: "flag" });
  expect(over.warnings.join("\n")).toContain("gdskills.projectContext.maxBytes");

  const dflt = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(dflt.budget).toMatchObject({ limitBytes: 131072, limitSource: "default", exceeded: false });

  await put(root, ".metaproject/tasks.config.json", JSON.stringify({ gdskills: { projectContext: { maxBytes: 4097 } } }));
  const configured = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(configured.budget).toMatchObject({ limitBytes: 4097, limitSource: "config", exceeded: false });
  await put(root, ".metaproject/tasks.config.json", JSON.stringify({ gdskills: { projectContext: { maxBytes: 4096 } } }));
  const configuredOver = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(configuredOver.budget).toMatchObject({ limitBytes: 4096, limitSource: "config", exceeded: true });
});

test("invalid caps read as the default and warn; the walk lets a later, smaller entry fit after a skipped larger one", async () => {
  const root = await project();
  await importRules(root, {
    "big.mdc": ruleText({ globs: "src/one/a.tsx", size: 3000 }),
    "huge.mdc": ruleText({ globs: "src/**/*.tsx", size: 3000 }),
    "small.mdc": ruleText({ always: true, size: 500 }),
  });
  const files = ["src/one/a.tsx"];
  const tight = await resolveProjectContext({ projectRoot: root, files, for: "implement", maxBytes: 4096 });
  expect(tight.entries.map((entry) => [entry.path, entry.tier])).toEqual([
    [P("big.mdc"), "must_read"],
    [P("huge.mdc"), "on_demand"],
    [P("small.mdc"), "must_read"],
  ]);
  expect(tight.budget.exceeded).toBe(true);
  for (const bad of [100, 5_000_000, 2.5, Number.NaN]) {
    const result = await resolveProjectContext({ projectRoot: root, files, for: "implement", maxBytes: bad });
    expect(result.budget.limitBytes).toBe(131072);
    expect(result.budget.limitSource).toBe("default");
    expect(result.warnings.join("\n")).toContain("--max-bytes");
  }
});

test("a linked rule is read from its origin while the hash matches; on a mismatch it is excluded with a warning that names the file and `skills update`", async () => {
  const root = await project();
  const source = await importRules(root, { "styling.mdc": ruleText({ globs: "src/**/*.css" }) }, true);
  const linked = await resolveProjectContext({ projectRoot: root, files: ["src/a.css"], for: "implement" });
  expect(linked.entries).toHaveLength(1);
  expect(linked.entries[0]).toMatchObject({ linked: true, path: path.join(source, "styling.mdc"), tier: "must_read" });
  expect(linked.entries[0]?.sha256).toBe(sha256Hex(await readFile(path.join(source, "styling.mdc"), "utf8")));

  await writeFile(path.join(source, "styling.mdc"), ruleText({ globs: "src/**/*.css", body: "changed\n" }), "utf8");
  const drifted = await resolveProjectContext({ projectRoot: root, files: ["src/a.css"], for: "implement" });
  expect(drifted.entries).toEqual([]);
  expect(drifted.warnings.join("\n")).toContain("styling.mdc");
  expect(drifted.warnings.join("\n")).toContain("keryx skills update");
});

test("a copy of a rule wins over a link of the same ref", async () => {
  const root = await project();
  await importRules(root, { "styling.mdc": ruleText({ globs: "src/**/*.css", body: "copy\n" }) });
  const source = await mkdtemp(path.join(tmpdir(), "keryx-context-resolver-src-"));
  roots.push(source);
  await put(source, "styling.mdc", ruleText({ globs: "src/**/*.css", body: "link\n" }));
  await importProjectRules({ projectRoot: root, from: source, link: true });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.css"], for: "implement" });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]?.path).toBe(P("styling.mdc"));
  expect(result.entries[0]?.linked).toBeUndefined();
});

test("a hand-written rule under rules/project is resolved like an imported one", async () => {
  const root = await project();
  await put(root, P("hand.mdc"), ruleText({ globs: "src/**" }));
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(paths(result.entries)).toEqual([P("hand.mdc")]);
});

test("a repo-relative .md path cited in backticks is listed as an on_demand contract with its hash", async () => {
  const root = await project();
  const claude = "# Project contract\n";
  await put(root, "CLAUDE.md", claude);
  await put(root, ".claude/rules/mobx.md", "mobx\n");
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body: "See `CLAUDE.md` and `.claude/rules/mobx.md`, also `CLAUDE.md` again.\n" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  const contracts = result.entries.filter((entry) => entry.kind === "contract");
  expect(contracts.map((entry) => entry.path)).toEqual([".claude/rules/mobx.md", "CLAUDE.md"]);
  const claudeEntry = contracts.find((entry) => entry.path === "CLAUDE.md");
  expect(claudeEntry).toMatchObject({ source: "project", tier: "on_demand", reason: `referenced-by:${P("overlay.mdc")}`, sha256: sha256Hex(claude) });
  expect(result.budget.exceeded).toBe(false);
  expect(result.entries.findIndex((entry) => entry.kind === "contract")).toBeGreaterThan(0);
});

test("a citation with a heading anchor, `docs/x.md#some-heading` or `core/nested.mdc#part`, cites the file itself", async () => {
  const root = await project();
  const doc = "# X\n\n## Some heading\n\nBody.\n";
  const nested = ruleText({ globs: "docs/**" });
  await put(root, "docs/x.md", doc);
  await put(root, P("core/nested.mdc"), nested);
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body: "See `docs/x.md#some-heading` and `core/nested.mdc#part`.\n" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries.filter((entry) => entry.kind === "contract").map((entry) => [entry.path, entry.reason, entry.sha256])).toEqual([
    [P("core/nested.mdc"), `referenced-by:${P("overlay.mdc")}`, sha256Hex(nested)],
    ["docs/x.md", `referenced-by:${P("overlay.mdc")}`, sha256Hex(doc)],
  ]);
  expect(result.warnings).toEqual([]);
});

test("a cited path that is absolute, climbs out, escapes through a symlink, is a directory, is too large or is missing is not listed and warns", async () => {
  const root = await project();
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-context-resolver-out-"));
  roots.push(outside);
  await writeFile(path.join(outside, "secret.md"), "secret\n", "utf8");
  await symlink(path.join(outside, "secret.md"), path.join(root, "escape.md"));
  await mkdir(path.join(root, "dir.md"));
  await put(root, "huge.md", "x".repeat(262145));
  await put(root, "edge.md", "x".repeat(262144));
  const body = ["`/etc/passwd.md`", "`../up.md`", "`escape.md`", "`dir.md`", "`huge.md`", "`missing.md`", "`edge.md`"].join(" ");
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries.filter((entry) => entry.kind === "contract").map((entry) => entry.path)).toEqual(["edge.md"]);
  const warnings = result.warnings.join("\n");
  for (const cited of ["/etc/passwd.md", "../up.md", "escape.md", "dir.md", "huge.md", "missing.md"]) expect(warnings).toContain(cited);
  expect(warnings).not.toContain("edge.md");
});

test("a contract that is also a project rule keeps its rule entry and is not listed twice", async () => {
  const root = await project();
  await importRules(root, {
    "overlay.mdc": ruleText({ globs: "src/**", body: "Follow `.metaproject/rules/project/styling.mdc`.\n" }),
    "styling.mdc": ruleText({ globs: "src/**" }),
  });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries.filter((entry) => entry.path === P("styling.mdc"))).toHaveLength(1);
  expect(result.entries.some((entry) => entry.kind === "contract")).toBe(false);
});

test("file arguments are normalised: ./ stripped, duplicates dropped, absolute paths inside the project made relative, outside paths dropped with a warning", async () => {
  const root = await project();
  await importRules(root, { "any.mdc": ruleText({ globs: "src/**" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["./src/b.ts", "src/b.ts", path.join(root, "src/a.ts"), "../elsewhere.ts"], for: "implement" });
  expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  expect(result.warnings.join("\n")).toContain("../elsewhere.ts");
});

test("the last resolve is recorded and read back; a missing or unreadable record reads as undefined", async () => {
  const root = await project();
  expect(await readLastResolve(root)).toBeUndefined();
  await importRules(root, { "any.mdc": ruleText({ globs: "src/**" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  await recordLastResolve(root, result);
  const recorded = await readLastResolve(root);
  expect(recorded?.result).toEqual(result);
  expect(typeof recorded?.recordedAt).toBe("string");
  await writeFile(path.join(root, ".metaproject/data/skills/project-context/last.json"), "{broken", "utf8");
  expect(await readLastResolve(root)).toBeUndefined();
});

test("the same rule under two project paths with one sha256 is one entry, the second path goes to also_at", async () => {
  const root = await project();
  const text = ruleText({ globs: "src/**" });
  await put(root, P("styling.mdc"), text);
  await put(root, P("core/styling.mdc"), text);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  const rules = result.entries.filter((entry) => entry.kind === "rule");
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ path: P("styling.mdc"), sha256: sha256Hex(text), also_at: [P("core/styling.mdc")] });
  expect(result.budget.usedBytes).toBe(Buffer.byteLength(text));
  expect(result.warnings).toEqual([]);
});

test("duplicates keep the project-first order and the shadows record", async () => {
  const root = await project();
  await core(root, { "tdd-workflow.mdc": "tdd\n", "error-handling.mdc": "bundled errors\n" });
  const text = ruleText({ globs: "src/**/*.ts" });
  await put(root, P("core/error-handling.mdc"), text);
  await put(root, P("error-handling.mdc"), text);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], taskType: "fix", for: "implement" });
  expect(paths(result.entries)).toEqual([P("error-handling.mdc"), C("tdd-workflow.mdc")]);
  expect(result.entries[0]).toMatchObject({ shadows: C("error-handling.mdc"), also_at: [P("core/error-handling.mdc")] });
});

test("the same file name under two project paths with different sha256 stays two entries and warns about the conflict", async () => {
  const root = await project();
  await put(root, P("styling.mdc"), ruleText({ globs: "src/**", body: "flat\n" }));
  await put(root, P("core/styling.mdc"), ruleText({ globs: "src/**", body: "nested\n" }));
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(paths(result.entries.filter((entry) => entry.kind === "rule")).sort()).toEqual([P("core/styling.mdc"), P("styling.mdc")]);
  expect(result.entries.every((entry) => entry.also_at === undefined)).toBe(true);
  expect(result.warnings.join("\n")).toMatch(/styling\.mdc.*different content/);
});

test("a core/ citation finds the flat project rule, and a flat citation finds the core/ one, with no does-not-exist warning", async () => {
  const root = await project();
  await put(root, P("flat.mdc"), ruleText({ globs: "docs/**" }));
  await put(root, P("core/nested.mdc"), ruleText({ globs: "docs/**" }));
  await put(root, P("overlay.mdc"), ruleText({ globs: "src/**", body: "See `core/flat.mdc` and `nested.mdc`, then `core/gone.mdc`.\n" }));
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  const contracts = result.entries.filter((entry) => entry.kind === "contract");
  expect(contracts.map((entry) => entry.path)).toEqual([P("core/nested.mdc"), P("flat.mdc")]);
  expect(contracts.every((entry) => entry.tier === "on_demand")).toBe(true);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("core/gone.mdc");
  expect(result.warnings[0]).toContain("does not exist");
});

test("a core/ citation of a rule that is already selected adds no second entry", async () => {
  const root = await project();
  await put(root, P("styling.mdc"), ruleText({ globs: "src/**" }));
  await put(root, P("overlay.mdc"), ruleText({ globs: "src/**", body: "See `core/styling.mdc`.\n" }));
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries.filter((entry) => entry.path === P("styling.mdc"))).toHaveLength(1);
  expect(result.entries.some((entry) => entry.kind === "contract")).toBe(false);
  expect(result.warnings).toEqual([]);
});

// --- flow 462: conditional mandatory reads ---------------------------------------------

type RefSpec = { path: string; globs?: string[]; keywords?: string[]; anchor?: string; description?: string };

async function declare(root: string, references: RefSpec[]): Promise<void> {
  const body = references.map((ref) => ({
    path: ref.path,
    when: { ...(ref.globs !== undefined ? { globs: ref.globs } : {}), ...(ref.keywords !== undefined ? { keywords: ref.keywords } : {}) },
    ...(ref.anchor !== undefined ? { anchor: ref.anchor } : {}),
    description: ref.description ?? "What the document governs and when to read it.",
  }));
  await put(root, ".metaproject/rules/project/references.json", `${JSON.stringify({ schema: 1, references: body }, null, 2)}\n`);
}

const STYLING = ["# Styling", "", "Intro of the document.", "", "## Class conventions", "", "Use tokens, never raw colours.", "", "### Cascade", "", "Layers win over specificity.", "", "## Other topic", "", "Unrelated tail.", ""].join("\n");
const SECTION = ["## Class conventions", "", "Use tokens, never raw colours.", "", "### Cascade", "", "Layers win over specificity.", "", ""].join("\n");

test("task text: the last resolve records its length and whether it was cut, never the text, and nothing when absent", async () => {
  const root = await project();
  await importRules(root, { "any.mdc": ruleText({ globs: "src/**" }) });
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  const recordedFile = () => readFile(path.join(root, LAST_RESOLVE_PATH), "utf8");

  const text = "Fix the spacing of the card, token sk-live-1234";
  await recordLastResolve(root, result, { taskText: text });
  expect(await readLastResolve(root)).toMatchObject({ taskTextLength: text.length });
  expect((await readLastResolve(root))?.taskTextTruncated).toBeUndefined();
  expect(await recordedFile()).not.toContain("sk-live-1234");

  await recordLastResolve(root, result, { taskText: `${"x".repeat(TASK_TEXT_MAX_CHARS + 50)}` });
  const long = await readLastResolve(root);
  expect(long?.taskTextLength).toBe(TASK_TEXT_MAX_CHARS + 50);
  expect(long?.taskTextTruncated).toBe(true);
  expect(await recordedFile()).not.toContain("xxxxxxxxxx");

  await recordLastResolve(root, result);
  expect(Object.keys((await readLastResolve(root)) ?? {})).toEqual(["recordedAt", "result"]);
});

test("task text from --task-text reaches the last-resolve record as a length only, and the resolve result itself does not carry it", async () => {
  const root = await project();
  await importRules(root, { "any.mdc": ruleText({ globs: "src/**" }) });
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const withText = await runResolveContextCommand(["--files", "src/a.ts", "--for", "implement", "--task-text", "Adjust the theme tokens"], root);
    expect((await readLastResolve(root))?.taskTextLength).toBe("Adjust the theme tokens".length);
    expect(await readFile(path.join(root, LAST_RESOLVE_PATH), "utf8")).not.toContain("Adjust the theme tokens");
    const without = await runResolveContextCommand(["--files", "src/a.ts", "--for", "implement"], root);
    expect(JSON.stringify(withText)).toBe(JSON.stringify(without));
    expect((await readLastResolve(root))?.taskTextLength).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

test("a declared reference whose glob promotes it is must_read with the glob as reason, the anchor, the description, the section size and the hash of the whole file", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await declare(root, [{ path: "STYLING.md", globs: ["src/**/*.css"], keywords: ["tailwind"], anchor: "Class conventions", description: "Class naming and the cascade." }]);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/app.css"], for: "implement" });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    kind: "contract",
    source: "project",
    path: "STYLING.md",
    tier: "must_read",
    reason: "condition:glob:src/**/*.css",
    anchor: "Class conventions",
    description: "Class naming and the cascade.",
    section_bytes: Buffer.byteLength(SECTION),
    sha256: sha256Hex(STYLING),
    bytes: Buffer.byteLength(STYLING),
  });
  expect(result.budget.usedBytes).toBe(Buffer.byteLength(SECTION));
  expect(result.budget.exceeded).toBe(false);
  expect(result.warnings).toEqual([]);
});

test("a declared reference whose keyword promotes it matches the task text case-insensitively on a word boundary; a task matching neither keeps description, anchor and condition on_demand", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await declare(root, [{ path: "STYLING.md", globs: ["src/**/*.css"], keywords: ["tailwind", "z-index"], anchor: "Class conventions", description: "Class naming." }]);
  const resolve = (taskText?: string) => resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement", ...(taskText !== undefined ? { taskText } : {}) });

  const hit = await resolve("Migrate the TAILWIND config.");
  expect(hit.entries[0]).toMatchObject({ path: "STYLING.md", tier: "must_read", reason: "condition:keyword:tailwind", anchor: "Class conventions", section_bytes: Buffer.byteLength(SECTION) });
  expect((await resolve("fix the z-index of the modal")).entries[0]).toMatchObject({ tier: "must_read", reason: "condition:keyword:z-index" });

  for (const text of ["tailwinds are mentioned", "the pretailwind thing", undefined, ""]) {
    const miss = await resolve(text);
    expect(miss.entries).toHaveLength(1);
    expect(miss.entries[0]).toMatchObject({
      path: "STYLING.md",
      tier: "on_demand",
      description: "Class naming.",
      anchor: "Class conventions",
      condition: { globs: ["src/**/*.css"], keywords: ["tailwind", "z-index"] },
    });
    expect(miss.budget.usedBytes).toBe(0);
  }
});

test("a reference whose anchor is missing falls back to the whole file and warns at resolve time", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await declare(root, [{ path: "STYLING.md", globs: ["src/**"], anchor: "No such heading" }]);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries[0]).toMatchObject({ tier: "must_read", section_bytes: Buffer.byteLength(STYLING), anchor: "No such heading" });
  expect(result.budget.usedBytes).toBe(Buffer.byteLength(STYLING));
  const warning = result.warnings.join("\n");
  expect(warning).toContain("STYLING.md");
  expect(warning).toContain("No such heading");
  expect(warning).toContain("whole file");
});

test("cap keeps promoted references: an over-cap promoted reference stays must_read and the warning gives the sizes, while rules keep flow 461 behaviour", async () => {
  const root = await project();
  await put(root, "STYLING.md", ruleText({ size: 10000 }));
  await put(root, "THEMING.md", ruleText({ size: 6000 }));
  await importRules(root, { "small.mdc": ruleText({ globs: "src/**", size: 2000 }) });
  await declare(root, [
    { path: "STYLING.md", globs: ["src/**"] },
    { path: "THEMING.md", globs: ["docs/**"] },
  ]);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement", maxBytes: 4096 });
  expect(result.entries.map((entry) => [entry.path, entry.tier])).toEqual([
    [P("small.mdc"), "must_read"],
    ["STYLING.md", "must_read"],
    ["THEMING.md", "on_demand"],
  ]);
  expect(result.budget).toEqual({ limitBytes: 4096, usedBytes: 12000, exceeded: true, limitSource: "flag" });
  const warning = result.warnings.join("\n");
  expect(warning).toContain("STYLING.md");
  expect(warning).toContain("10000");
  expect(warning).toContain("4096");
  expect(warning).toContain("12000");
});

test("undeclared citations keep the flow 461 on_demand contract entry and are listed as undeclared; a declared one is not listed twice", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await put(root, "THEMING.md", "# Theming\n");
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body: "See `STYLING.md` and `THEMING.md`.\n" }) });
  await declare(root, [{ path: "STYLING.md", globs: ["docs/**"], description: "Class naming." }]);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries.filter((entry) => entry.path === "STYLING.md")).toHaveLength(1);
  expect(result.entries.find((entry) => entry.path === "STYLING.md")).toMatchObject({ tier: "on_demand", description: "Class naming." });
  expect(result.entries.find((entry) => entry.path === "THEMING.md")).toMatchObject({ kind: "contract", tier: "on_demand", reason: `referenced-by:${P("overlay.mdc")}` });
  expect(result.undeclared).toEqual(["THEMING.md"]);
});

test("a rule that cites a declared document as ./STYLING.md does not list it twice or call it undeclared, and a cited .mdc is a contract but not an undeclared document", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await put(root, "THEMING.md", "# Theming\n");
  await put(root, "notes/OTHER.mdc", "other rule\n");
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body: "See `./STYLING.md`, `./THEMING.md` and `notes/OTHER.mdc`.\n" }) });
  await declare(root, [{ path: "STYLING.md", globs: ["docs/**"] }]);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries.filter((entry) => entry.path.endsWith("STYLING.md"))).toHaveLength(1);
  expect(result.entries.find((entry) => entry.path === "STYLING.md")).toMatchObject({ tier: "on_demand", reason: "declared" });
  expect(result.entries.find((entry) => entry.path === "THEMING.md")).toMatchObject({ kind: "contract", reason: `referenced-by:${P("overlay.mdc")}` });
  expect(result.entries.find((entry) => entry.path === "notes/OTHER.mdc")).toMatchObject({ kind: "contract", tier: "on_demand" });
  expect(result.undeclared).toEqual(["THEMING.md"]);
});

test("a task text over the cut warns that a keyword after the cut cannot promote; a text that fits, or a project without keywords or a references file, gets no warning", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await declare(root, [{ path: "STYLING.md", keywords: ["tailwind"], anchor: "Class conventions" }]);
  const resolve = (taskText: string) => resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement", taskText });

  const cut = await resolve(`${"x ".repeat(TASK_TEXT_MAX_CHARS)}tailwind`);
  expect(cut.entries[0]).toMatchObject({ path: "STYLING.md", tier: "on_demand" });
  const warning = cut.warnings.join("\n");
  expect(warning).toContain(`${TASK_TEXT_MAX_CHARS} characters`);
  expect(warning).toContain("keyword after the cut");

  const exact = await resolve(`${"x ".repeat(TASK_TEXT_MAX_CHARS / 2 - 4)}tailwind`);
  expect(exact.entries[0]).toMatchObject({ tier: "must_read", reason: "condition:keyword:tailwind" });
  expect(exact.warnings.join("\n")).not.toContain("keyword after the cut");

  await declare(root, [{ path: "STYLING.md", globs: ["docs/**"] }]);
  expect((await resolve("y ".repeat(TASK_TEXT_MAX_CHARS))).warnings.join("\n")).not.toContain("keyword after the cut");

  const bare = await project();
  expect((await resolveProjectContext({ projectRoot: bare, files: [], for: "implement", taskText: "y ".repeat(TASK_TEXT_MAX_CHARS) })).warnings).toEqual([]);
});

test("without a references file the result is byte-identical whatever the task text, and carries no undeclared list", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body: "See `STYLING.md`.\n" }) });
  const plain = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  const withText = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement", taskText: "tailwind everywhere" });
  expect(JSON.stringify(withText)).toBe(JSON.stringify(plain));
  expect("undeclared" in plain).toBe(false);
  expect(plain.entries.find((entry) => entry.path === "STYLING.md")).toMatchObject({ tier: "on_demand", reason: `referenced-by:${P("overlay.mdc")}` });
});

test("a malformed references file warns with its own messages, and the resolve carries on as flow 461 would", async () => {
  const root = await project();
  await put(root, "STYLING.md", STYLING);
  await importRules(root, { "overlay.mdc": ruleText({ globs: "src/**", body: "See `STYLING.md`.\n" }) });
  await put(root, ".metaproject/rules/project/references.json", "{ not json");
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.warnings.join("\n")).toContain("references.json");
  expect(result.warnings.join("\n")).toContain("not valid JSON");
  expect(result.entries.find((entry) => entry.path === "STYLING.md")).toMatchObject({ tier: "on_demand" });
  expect("undeclared" in result).toBe(false);

  await put(root, ".metaproject/rules/project/references.json", JSON.stringify({ schema: 1, references: [{ path: "STYLING.md", when: {}, description: "x" }] }));
  const invalid = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(invalid.warnings.join("\n")).toContain('references[0] ("STYLING.md")');
});

test("a declared reference whose file is missing, outside the root or a directory is not listed and warns", async () => {
  const root = await project();
  await mkdir(path.join(root, "dir.md"), { recursive: true });
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-context-outside-"));
  roots.push(outside);
  await writeFile(path.join(outside, "secret.md"), "secret\n", "utf8");
  await symlink(path.join(outside, "secret.md"), path.join(root, "escape.md"));
  await declare(root, [
    { path: "missing.md", globs: ["src/**"] },
    { path: "dir.md", globs: ["src/**"] },
    { path: "escape.md", globs: ["src/**"] },
  ]);
  const result = await resolveProjectContext({ projectRoot: root, files: ["src/a.ts"], for: "implement" });
  expect(result.entries).toEqual([]);
  const warnings = result.warnings.join("\n");
  for (const name of ["missing.md", "dir.md", "escape.md"]) expect(warnings).toContain(name);
});
