import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillsCommand } from "../commands/skills";
import { readLastResolve, type ContextEntry, type ProjectContextResolution } from "./context-resolver";
import { distinctWords } from "./reference-proof";
import { extractSection } from "./references-section";

// Flow 462, T13 (AC18): conditional mandatory reads, end to end.
//
// A fixture project carries a project rule that cites a STYLING-like and a
// THEMING-like document of the real sizes (about 90 KB and 80 KB), and a
// references.json that declares both. Three tasks are resolved and validated
// through the entry points an operator uses: `skills resolve-context
// --task-text`, `skills contracts validate --resolved` and `skills references
// check`, all via the `skills` router. Nothing is mocked: files are real, the
// output is what the command prints.
//
// What this proves: the resolver promotes the right documents, the validator
// accepts a proof built from the section's own words and refuses a summary that
// uses none of them. What it cannot prove: that a model read anything. The check
// is a proxy; the live run (docs/requirements/keryx-conditional-reads/live-run.md)
// is where a real agent meets it.

const STYLING_PATH = "STYLING.md";
const THEMING_PATH = "THEMING.md";
const STYLING_ANCHOR = "Class conventions";
const THEMING_ANCHOR = "Theme tokens";
const STYLING_TARGET_BYTES = 90_000;
const THEMING_TARGET_BYTES = 80_000;
const RULE_PATH = ".metaproject/rules/project/styling.mdc";
const CONFIG_PATH = ".metaproject/tasks.config.json";

/** Words of five letters or more that none of the fixture sections use, so a summary made of them shares nothing with the text. */
const FABRICATED_SUMMARY = "Looked over the whole thing, nothing unusual noticed, all requirements satisfied as expected.";
const SHORT_SUMMARY = "Read the section.";

// --- the fixture documents -------------------------------------------------

const STYLING_CLASS_CONVENTIONS = `## ${STYLING_ANCHOR}

Every stylesheet class is named after the component that owns it, in kebab-case, with a single block prefix. A selector never reaches into a child component: the child exposes a modifier class and the parent passes it down.

### Utility classes

Tailwind utilities may be combined on an element, but a run of more than eight utilities belongs in an extracted component class. Spacing always comes from the spacing scale; a literal pixel value in a className is a defect.

### Specificity

Selectors stay at one class deep. The cascade layer order is base, components, utilities, and a rule in an earlier layer never wins by specificity over a later one. Inline style is reserved for values computed at runtime, such as a measured width.
`;

const STYLING_CASCADE = `## Tailwind 4 cascade

The cascade contract follows layer order, not source order. A component class that must beat a utility declares itself in the utilities layer on purpose and says why in a comment.
`;

const THEMING_THEME_TOKENS = `## ${THEMING_ANCHOR}

A theme is a flat map of semantic tokens: surface, border, accent, danger and their foreground partners. Components read a token through a custom property and never a palette colour, so a palette swap changes no component.

### Naming

Token names describe a role, not a hue. Adding a role means adding it to every theme in the same change; a theme that lacks a role fails the token completeness check.

### Contrast

Each foreground and surface pair must keep a contrast ratio of at least 4.5 to 1 in every theme, including the high-contrast variant.
`;

const THEMING_DARK_MODE = `## Dark mode

The dark theme is selected by the user setting first and by the system preference second. Switching a theme never remounts a component and never reads a stored colour directly.
`;

const FILLER_SUBJECTS = ["buttons", "forms", "tables", "dialogs", "tooltips", "menus", "tabs", "badges", "charts", "icons", "toasts", "inputs"];
const FILLER_RULES = [
  "keeps its internal layout in one wrapper and exposes only documented hooks to the outside",
  "declares its states in a fixed order so that a reader can scan the list quickly",
  "avoids hard coded measurements and asks the layout engine for the available room",
  "documents each variant next to the component story and lists the supported combinations",
  "leaves focus handling to the shared primitive and adds no custom outline of its own",
  "limits animation to opacity and transform so that low powered devices stay responsive",
];

function fillerSection(label: string, index: number): string {
  const subject = FILLER_SUBJECTS[index % FILLER_SUBJECTS.length]!;
  const rule = FILLER_RULES[index % FILLER_RULES.length]!;
  const other = FILLER_RULES[(index + 3) % FILLER_RULES.length]!;
  const id = String(index).padStart(3, "0");
  return [
    `## ${label} guideline ${id}`,
    "",
    `The ${subject} family ${rule}. It also ${other}, and any exception is recorded in the review ledger together with the owner who approved it.`,
    "",
    "- Check the story for the default state before merging.",
    `- Record the decision for ${subject} in the ledger entry ${id}.`,
    "",
    "```tsx",
    `<${subject.slice(0, 1).toUpperCase()}${subject.slice(1)} data-testid="guideline-${id}" />`,
    "```",
    "",
  ].join("\n");
}

/** Anchored sections first, then numbered guideline sections until the document reaches `targetBytes`. */
function buildDocument(title: string, label: string, anchored: readonly string[], targetBytes: number): string {
  const parts = [`# ${title}`, "", `The ${label} contract of the application. Sections below are numbered guidelines, read the one that matches your change.`, "", ...anchored];
  let text = `${parts.join("\n")}\n`;
  for (let index = 0; Buffer.byteLength(text) < targetBytes; index += 1) text += `${fillerSection(label, index)}\n`;
  return text;
}

const RULE_TEXT = [
  "---",
  "description: Styling and theming rules of the application",
  "alwaysApply: true",
  "---",
  "",
  "# Styling",
  "",
  `Class naming and the cascade are described in \`${STYLING_PATH}\`. Colour roles and themes are described in \`${THEMING_PATH}\`.`,
  "Follow them whenever a change touches how something looks.",
  "",
].join("\n");

const REFERENCES = {
  schema: 1,
  references: [
    {
      path: STYLING_PATH,
      when: { globs: ["src/**/*.css", "src/**/*.tsx"], keywords: ["styling", "tailwind"] },
      anchor: STYLING_ANCHOR,
      description: "Class naming, spacing and the Tailwind 4 cascade contract. Read before adding or changing a className, a stylesheet or inline style.",
    },
    {
      path: THEMING_PATH,
      when: { globs: ["src/theme/**"], keywords: ["theme", "dark mode"] },
      anchor: THEMING_ANCHOR,
      description: "Semantic theme tokens, contrast and dark mode. Read before adding a colour role, a theme or a dark mode switch.",
    },
  ],
};

// --- harness ---------------------------------------------------------------

let root = "";
let stylingText = "";
let themingText = "";
const startCwd = process.cwd();
const startExitCode = process.exitCode;

type Captured = { out: string; err: string; exitCode: number };

/** Runs one `skills` command from the fixture root and returns what it printed and the exit code it set. */
async function skills(...args: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void err.push(parts.map(String).join(" "));
  process.exitCode = 0;
  try {
    await skillsCommand(args);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n"), exitCode: Number(process.exitCode ?? 0) };
}

async function writeProjectFile(rel: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text, "utf8");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-conditional-reads-"));
  stylingText = buildDocument("Styling", "styling", [STYLING_CLASS_CONVENTIONS, STYLING_CASCADE], STYLING_TARGET_BYTES);
  themingText = buildDocument("Theming", "theming", [THEMING_THEME_TOKENS, THEMING_DARK_MODE], THEMING_TARGET_BYTES);
  await writeProjectFile(".metaproject/metaproject.json", "{}\n");
  await writeProjectFile(RULE_PATH, RULE_TEXT);
  await writeProjectFile(".metaproject/rules/project/references.json", `${JSON.stringify(REFERENCES, null, 2)}\n`);
  await writeProjectFile(STYLING_PATH, stylingText);
  await writeProjectFile(THEMING_PATH, themingText);
});

beforeEach(() => {
  process.chdir(root);
});

afterEach(() => {
  process.chdir(startCwd);
  process.exitCode = startExitCode;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- scenario plumbing -----------------------------------------------------

type Scenario = { name: string; files: string[]; taskText: string };

const STYLING_TOUCHED: Scenario = {
  name: "styling-file",
  files: ["src/components/Button.tsx"],
  taskText: "Rename the Button prop and add a loading spinner",
};
const THEME_KEYWORD: Scenario = {
  name: "theme-keyword",
  files: ["src/pages/settings.ts"],
  taskText: "Let the user pick a theme in the settings page",
};
const UNRELATED: Scenario = {
  name: "unrelated",
  files: ["src/services/session.ts"],
  taskText: "Fix the token refresh race in the session service",
};

type Resolved = { printed: Captured; file: string; resolution: ProjectContextResolution };

async function resolve(scenario: Scenario): Promise<Resolved> {
  const file = `.metaproject/data/resolved/${scenario.name}.json`;
  const printed = await skills(
    "resolve-context",
    "--files",
    scenario.files.join(","),
    "--for",
    "implement",
    "--task-type",
    "ui_component",
    "--task-text",
    scenario.taskText,
    "--out",
    file,
  );
  const resolution = JSON.parse(await readFile(path.join(root, file), "utf8")) as ProjectContextResolution;
  return { printed, file, resolution };
}

function entryFor(resolution: ProjectContextResolution, entryPath: string): ContextEntry {
  const found = resolution.entries.find((entry) => entry.path === entryPath);
  if (found === undefined) throw new Error(`no resolver entry for ${entryPath}; entries: ${resolution.entries.map((entry) => entry.path).join(", ")}`);
  return found;
}

const documentText = (entryPath: string): string => (entryPath === STYLING_PATH ? stylingText : themingText);
const isPromoted = (entry: ContextEntry): boolean => entry.tier === "must_read" && entry.reason.startsWith("condition:");

/** What an honest worker writes: the opening sentences of the section it read, in its words, which are the section's words. */
function honestSummary(entry: ContextEntry): string {
  const section = extractSection(documentText(entry.path), entry.anchor ?? "");
  if (!section.found) throw new Error(`anchor ${entry.anchor ?? ""} not found in ${entry.path}`);
  const paragraph = section.text.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#")) ?? "";
  return paragraph.length > 200 ? paragraph.slice(0, paragraph.lastIndexOf(" ", 200)) : paragraph;
}

type Mode = "correct" | "fabricated" | "short" | "not-applicable" | "wrong-anchor";

/** A task-implementer result that cites every must_read entry; a promoted one gets the proof `mode` describes. */
function buildResult(resolution: ProjectContextResolution, mode: Mode): Record<string, unknown> {
  const applied = resolution.entries
    .filter((entry) => entry.tier === "must_read")
    .map((entry) => {
      const base = { path: entry.path, sha256: entry.sha256 };
      if (!isPromoted(entry)) return { ...base, how: "read" };
      switch (mode) {
        case "correct":
          return { ...base, how: "read", anchor: entry.anchor, summary: honestSummary(entry) };
        case "fabricated":
          return { ...base, how: "read", anchor: entry.anchor, summary: FABRICATED_SUMMARY };
        case "short":
          return { ...base, how: "read", anchor: entry.anchor, summary: SHORT_SUMMARY };
        case "not-applicable":
          return { ...base, how: "n/a" };
        case "wrong-anchor":
          return { ...base, how: "read", anchor: "Spacing", summary: honestSummary(entry) };
      }
    });
  return { task_id: "task-1", task_name: "Change the component", task_type: "ui_component", status: "success", project_context_applied: applied };
}

async function validate(scenario: Scenario, resolved: Resolved, result: Record<string, unknown>, label: string): Promise<Captured> {
  const resultFile = `.metaproject/data/results/${scenario.name}-${label}.json`;
  await writeProjectFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return skills("contracts", "validate", resultFile, "--schema", "task-implementer-output", "--resolved", resolved.file);
}

const CLEAN_VERDICT = "project context: every must_read entry cited, nothing drifted (enforcement warn)";

// --- the fixture itself ----------------------------------------------------

describe("fixture", () => {
  test("the documents have the real sizes and the anchored sections are a small part of them", () => {
    expect(Buffer.byteLength(stylingText)).toBeGreaterThanOrEqual(STYLING_TARGET_BYTES);
    expect(Buffer.byteLength(stylingText)).toBeLessThan(STYLING_TARGET_BYTES + 2_000);
    expect(Buffer.byteLength(themingText)).toBeGreaterThanOrEqual(THEMING_TARGET_BYTES);
    expect(Buffer.byteLength(themingText)).toBeLessThan(THEMING_TARGET_BYTES + 2_000);
    for (const [text, anchor] of [[stylingText, STYLING_ANCHOR], [themingText, THEMING_ANCHOR]] as const) {
      const section = extractSection(text, anchor);
      expect(section.found).toBe(true);
      if (section.found) expect(section.bytes).toBeLessThan(Buffer.byteLength(text) / 20);
    }
  });

  test("the fabricated summary shares no five-letter word with either anchored section", () => {
    for (const [text, anchor] of [[stylingText, STYLING_ANCHOR], [themingText, THEMING_ANCHOR]] as const) {
      const section = extractSection(text, anchor);
      const words = distinctWords(section.found ? section.text : "");
      expect([...distinctWords(FABRICATED_SUMMARY)].filter((word) => words.has(word))).toEqual([]);
    }
  });

  test("`skills references check` finds the declarations sound and nothing undeclared", async () => {
    const checked = await skills("references", "check");
    expect(checked.exitCode).toBe(0);
    expect(checked.out).toContain("2 declared");
    expect(checked.out).toContain("0 errors, 0 warnings");
    const suggested = await skills("references", "suggest");
    expect(JSON.parse(suggested.out)).toEqual({ schema: 1, references: [] });
  });
});

// --- scenario 1: a styling file is touched ---------------------------------

describe("scenario 1: a styling file is touched", () => {
  test("STYLING is promoted by the glob, THEMING stays on demand with its description", async () => {
    const resolved = await resolve(STYLING_TOUCHED);
    const styling = entryFor(resolved.resolution, STYLING_PATH);
    const theming = entryFor(resolved.resolution, THEMING_PATH);

    expect(styling).toMatchObject({ tier: "must_read", reason: "condition:glob:src/**/*.tsx", anchor: STYLING_ANCHOR, kind: "contract" });
    expect(styling.bytes).toBeGreaterThanOrEqual(STYLING_TARGET_BYTES);
    expect(styling.section_bytes).toBeGreaterThan(0);
    expect(styling.section_bytes).toBeLessThan(styling.bytes / 20);
    expect(styling.description).toBe(REFERENCES.references[0]!.description);
    expect(styling.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(theming).toMatchObject({ tier: "on_demand", reason: "declared", anchor: THEMING_ANCHOR, description: REFERENCES.references[1]!.description });
    expect(theming.condition).toEqual({ globs: ["src/theme/**"], keywords: ["theme", "dark mode"] });

    // The budget counts the section the worker must read, never the 90 KB file.
    expect(resolved.resolution.budget.usedBytes).toBe(entryFor(resolved.resolution, RULE_PATH).bytes + (styling.section_bytes ?? 0));
    expect(resolved.resolution.budget.exceeded).toBe(false);
    expect(resolved.resolution.undeclared).toEqual([]);
    expect(resolved.printed.err).toBe("");
    expect(resolved.printed.exitCode).toBe(0);
  });

  test("the printed report lists the promoted section and the on-demand document", async () => {
    const { printed, resolution } = await resolve(STYLING_TOUCHED);
    const styling = entryFor(resolution, STYLING_PATH);
    const theming = entryFor(resolution, THEMING_PATH);
    const lines = printed.out.split("\n");
    expect(lines).toContain("## must_read (2)");
    expect(lines).toContain("## on_demand (1)");
    expect(lines).toContain(
      `- ${STYLING_PATH} — project contract, condition:glob:src/**/*.tsx, ${styling.bytes} bytes, sha256 ${styling.sha256.slice(0, 12)} (anchor "${STYLING_ANCHOR}", section ${styling.section_bytes} bytes)`,
    );
    expect(lines).toContain(`- ${THEMING_PATH} — project contract, declared, ${theming.bytes} bytes, sha256 ${theming.sha256.slice(0, 12)} (anchor "${THEMING_ANCHOR}", section ${theming.section_bytes} bytes)`);
  });

  test("a correct result passes; THEMING does not have to be cited", async () => {
    const resolved = await resolve(STYLING_TOUCHED);
    const verdict = await validate(STYLING_TOUCHED, resolved, buildResult(resolved.resolution, "correct"), "correct");
    expect(verdict.out).toContain("schema: task-implementer-output");
    expect(verdict.out).toContain(CLEAN_VERDICT);
    expect(verdict.err).toBe("");
    expect(verdict.exitCode).toBe(0);
  });

  test("a fabricated summary is a miss with its reason, a printed warning under warn and exit 1 under block", async () => {
    const resolved = await resolve(STYLING_TOUCHED);
    const result = buildResult(resolved.resolution, "fabricated");

    const warned = await validate(STYLING_TOUCHED, resolved, result, "fabricated");
    expect(warned.exitCode).toBe(0);
    expect(warned.out).toContain("project context: 1 miss(es), 0 drifted (enforcement warn)");
    expect(warned.out).toContain(
      `- project context miss: ${STYLING_PATH} (condition:glob:src/**/*.tsx) has a summary that shares 0 distinct word(s) of 5 or more letters with the section "${STYLING_ANCHOR}"; 3 required. Write the summary in the wording of the text you read`,
    );

    await writeProjectFile(CONFIG_PATH, `${JSON.stringify({ gdskills: { projectContext: { enforcement: "block" } } })}\n`);
    try {
      const blocked = await validate(STYLING_TOUCHED, resolved, result, "fabricated");
      expect(blocked.exitCode).toBe(1);
      expect(blocked.err).toContain("project context: 1 miss(es), 0 drifted (enforcement block)");
      expect(blocked.err).toContain(`- project context miss: ${STYLING_PATH} (condition:glob:src/**/*.tsx) has a summary that shares 0 distinct word(s)`);
    } finally {
      await rm(path.join(root, CONFIG_PATH), { force: true });
    }
  });

  test("a summary that is too short, a wrong anchor and an n/a citation are each their own miss", async () => {
    const resolved = await resolve(STYLING_TOUCHED);

    const short = await validate(STYLING_TOUCHED, resolved, buildResult(resolved.resolution, "short"), "short");
    expect(short.out).toContain("project context: 2 miss(es), 0 drifted (enforcement warn)");
    expect(short.out).toContain(`${STYLING_PATH} (condition:glob:src/**/*.tsx) has a summary of ${SHORT_SUMMARY.length} characters; at least 40 are required`);
    expect(short.out).toContain("has a summary that shares 0 distinct word(s)");

    const wrongAnchor = await validate(STYLING_TOUCHED, resolved, buildResult(resolved.resolution, "wrong-anchor"), "wrong-anchor");
    expect(wrongAnchor.out).toContain("project context: 1 miss(es), 0 drifted (enforcement warn)");
    expect(wrongAnchor.out).toContain(`${STYLING_PATH} (condition:glob:src/**/*.tsx) cites anchor "Spacing"; the declaration says "${STYLING_ANCHOR}"`);

    const notApplicable = await validate(STYLING_TOUCHED, resolved, buildResult(resolved.resolution, "not-applicable"), "not-applicable");
    expect(notApplicable.out).toContain("project context: 1 miss(es), 0 drifted (enforcement warn)");
    expect(notApplicable.out).toContain(`${STYLING_PATH} (condition:glob:src/**/*.tsx) is cited only with how "n/a"`);
  });

  test("editing the promoted document after the resolve is reported as drift", async () => {
    const resolved = await resolve(STYLING_TOUCHED);
    const result = buildResult(resolved.resolution, "correct");
    await writeProjectFile(STYLING_PATH, `${stylingText}\n## Late addition\n\nChanged after the resolve.\n`);
    try {
      const verdict = await validate(STYLING_TOUCHED, resolved, result, "drift");
      expect(verdict.out).toContain("project context: 0 miss(es), 1 drifted (enforcement warn)");
      expect(verdict.out).toContain(`- project context drift: ${STYLING_PATH} (must_read) now hashes to`);
    } finally {
      await writeProjectFile(STYLING_PATH, stylingText);
    }
  });
});

// --- scenario 2: the task text names a theme -------------------------------

describe("scenario 2: only the theme keyword matches", () => {
  test("THEMING is promoted by the keyword, STYLING stays on demand", async () => {
    const resolved = await resolve(THEME_KEYWORD);
    const theming = entryFor(resolved.resolution, THEMING_PATH);
    const styling = entryFor(resolved.resolution, STYLING_PATH);

    expect(theming).toMatchObject({ tier: "must_read", reason: "condition:keyword:theme", anchor: THEMING_ANCHOR });
    expect(theming.bytes).toBeGreaterThanOrEqual(THEMING_TARGET_BYTES);
    expect(theming.section_bytes).toBeLessThan(theming.bytes / 20);
    expect(styling).toMatchObject({ tier: "on_demand", reason: "declared" });
    expect(resolved.resolution.budget.usedBytes).toBe(entryFor(resolved.resolution, RULE_PATH).bytes + (theming.section_bytes ?? 0));
    expect(resolved.printed.out).toContain(`- ${THEMING_PATH} — project contract, condition:keyword:theme, ${theming.bytes} bytes`);
    expect(resolved.printed.err).toBe("");
  });

  test("a correct result passes", async () => {
    const resolved = await resolve(THEME_KEYWORD);
    const verdict = await validate(THEME_KEYWORD, resolved, buildResult(resolved.resolution, "correct"), "correct");
    expect(verdict.out).toContain(CLEAN_VERDICT);
    expect(verdict.exitCode).toBe(0);
  });

  test("a fabricated summary is a miss with its reason", async () => {
    const resolved = await resolve(THEME_KEYWORD);
    const verdict = await validate(THEME_KEYWORD, resolved, buildResult(resolved.resolution, "fabricated"), "fabricated");
    expect(verdict.out).toContain("project context: 1 miss(es), 0 drifted (enforcement warn)");
    expect(verdict.out).toContain(
      `- project context miss: ${THEMING_PATH} (condition:keyword:theme) has a summary that shares 0 distinct word(s) of 5 or more letters with the section "${THEMING_ANCHOR}"; 3 required.`,
    );
  });

  test("a summary lifted from another document's section does not satisfy it", async () => {
    const resolved = await resolve(THEME_KEYWORD);
    const result = buildResult(resolved.resolution, "correct");
    const applied = result["project_context_applied"] as Array<Record<string, unknown>>;
    // A real worker could copy a paragraph of STYLING instead of reading THEMING.
    const stylingCascade = extractSection(stylingText, "Tailwind 4 cascade");
    const borrowed = (stylingCascade.found ? stylingCascade.text : "").split("\n").find((line) => line.startsWith("The cascade contract")) ?? "";
    const themingSection = extractSection(themingText, THEMING_ANCHOR);
    const themingWords = distinctWords(themingSection.found ? themingSection.text : "");
    // Precondition, so the test says what it proves: the borrowed text overlaps by fewer than 3 words.
    expect([...distinctWords(borrowed)].filter((word) => themingWords.has(word)).length).toBeLessThan(3);
    const wrong = applied.map((item) => (item["path"] === THEMING_PATH ? { ...item, summary: borrowed } : item));
    const verdict = await validate(THEME_KEYWORD, resolved, { ...result, project_context_applied: wrong }, "wrong-document");
    expect(verdict.out).toContain(`${THEMING_PATH} (condition:keyword:theme) has a summary that shares`);
    expect(verdict.out).toContain("project context: 1 miss(es), 0 drifted (enforcement warn)");
  });
});

// --- scenario 3: an unrelated task -----------------------------------------

describe("scenario 3: an unrelated task", () => {
  test("neither document is promoted; both are listed on demand with their conditions", async () => {
    const resolved = await resolve(UNRELATED);
    for (const documentPath of [STYLING_PATH, THEMING_PATH]) {
      const entry = entryFor(resolved.resolution, documentPath);
      expect(entry).toMatchObject({ tier: "on_demand", reason: "declared" });
      expect(entry.description).toBeDefined();
      expect(entry.anchor).toBeDefined();
      expect(entry.condition).toBeDefined();
    }
    expect(resolved.resolution.entries.filter(isPromoted)).toEqual([]);
    expect(resolved.resolution.entries.filter((entry) => entry.tier === "must_read").map((entry) => entry.path)).toEqual([RULE_PATH]);
    expect(resolved.resolution.budget.usedBytes).toBe(entryFor(resolved.resolution, RULE_PATH).bytes);
    expect(resolved.printed.out).toContain("## must_read (1)");
    expect(resolved.printed.out).toContain("## on_demand (2)");
  });

  test("a result citing only the rule passes; a promoted-looking proof is not required", async () => {
    const resolved = await resolve(UNRELATED);
    const verdict = await validate(UNRELATED, resolved, buildResult(resolved.resolution, "correct"), "correct");
    expect(verdict.out).toContain(CLEAN_VERDICT);
    expect(verdict.exitCode).toBe(0);
  });

  test("a fabricated summary on a document nobody had to read is not an obligation and not a miss", async () => {
    const resolved = await resolve(UNRELATED);
    const result = buildResult(resolved.resolution, "fabricated");
    const extra = [STYLING_PATH, THEMING_PATH].map((documentPath) => {
      const entry = entryFor(resolved.resolution, documentPath);
      return { path: documentPath, sha256: entry.sha256, how: "read", anchor: entry.anchor, summary: FABRICATED_SUMMARY };
    });
    const withExtras = { ...result, project_context_applied: [...(result["project_context_applied"] as unknown[]), ...extra] };
    const verdict = await validate(UNRELATED, resolved, withExtras, "fabricated");
    expect(verdict.out).toContain(CLEAN_VERDICT);
    expect(verdict.exitCode).toBe(0);
  });

  test("the resolve is recorded with the length of its task text, not the text", async () => {
    await resolve(UNRELATED);
    const recorded = await readLastResolve(root);
    expect(recorded?.taskTextLength).toBe(Array.from(UNRELATED.taskText).length);
    expect(JSON.stringify(recorded)).not.toContain(UNRELATED.taskText);
  });
});
