import { describe, expect, test } from "bun:test";
import {
  frontmatterField,
  frontmatterLines,
  frontmatterList,
  frontmatterScalar,
  metadataList,
  parseSkillFrontmatter,
  readFrontmatter,
} from "./skill-frontmatter";

const LF_SKILL = [
  "---",
  "name: review-house",
  'description: "Fix #12 — a # inside quotes is text"',
  "category: quality # trailing comment",
  "metadata:",
  "  category: 'review'   # which module",
  "  flags: [--a, '--b', \"--c # still c\"] # flow list",
  "  paths:",
  "    - src/a/** # the a tree",
  "    -",
  '    - "src/#b/**"',
  "",
  "  version: 1.2.0",
  "---",
  "",
  "# Body",
  "",
  "metadata:",
  "  category: body",
  "",
].join("\n");

const EXPECTED = {
  name: "review-house",
  description: "Fix #12 — a # inside quotes is text",
  category: "quality",
  metadataCategory: "review",
  flags: ["--a", "--b", "--c # still c"],
  paths: ["src/a/**", "src/#b/**"],
  version: "1.2.0",
};

function observed(content: string): typeof EXPECTED {
  return {
    name: frontmatterScalar(content, "name") ?? "<none>",
    description: frontmatterScalar(content, "description") ?? "<none>",
    category: frontmatterScalar(content, "category") ?? "<none>",
    metadataCategory: frontmatterScalar(content, "category", "metadata") ?? "<none>",
    flags: metadataList(content, "flags"),
    paths: metadataList(content, "paths"),
    version: frontmatterScalar(content, "version", "metadata") ?? "<none>",
  };
}

describe("the frontmatter block", () => {
  const crlf = LF_SKILL.replace(/\n/g, "\r\n");
  test.each([
    ["LF", LF_SKILL],
    ["CRLF", crlf],
    ["BOM", `\uFEFF${LF_SKILL}`],
    ["BOM + CRLF", `\uFEFF${crlf}`],
  ])("%s reads the same fields", (_shape, content) => {
    expect(observed(content)).toEqual(EXPECTED);
  });

  test("a file that does not open with a fence has no frontmatter", () => {
    for (const content of [
      "# Title\n\n---\nname: x\n---\n",
      " ---\nname: x\n---\n",
      "\n---\nname: x\n---\n",
      "---name: x\n---\n",
      "",
    ]) {
      expect({ content, lines: frontmatterLines(content) }).toEqual({ content, lines: undefined });
      expect(readFrontmatter(content)).toBeUndefined();
      expect(parseSkillFrontmatter(content)).toEqual({});
    }
  });

  test("a missing closing fence is no frontmatter", () => {
    expect(frontmatterLines("---\nname: x\nmetadata:\n  category: review\n")).toBeUndefined();
    expect(frontmatterScalar("---\nname: x\n", "name")).toBeUndefined();
    expect(metadataList("---\nmetadata:\n  paths: src/**\n", "paths")).toEqual([]);
  });

  test("the block closes at the first `---` line; the body is never frontmatter", () => {
    expect(frontmatterLines("---\nname: x\n---\nname: y\n---\n")).toEqual(["name: x"]);
    expect(frontmatterScalar(LF_SKILL, "category", "metadata")).toBe("review");
    expect(frontmatterLines("---\n---\nbody\n")).toEqual([]);
  });
});

describe("values", () => {
  const skill = (frontmatter: string): string => `---\nname: x\n${frontmatter}---\n\nbody\n`;

  test.each([
    ["scalar list", "  paths: src/a/**, 'src/b/**'\n"],
    ["quoted scalar list", '  paths: "src/a/**, src/b/**" # both trees\n'],
    ["flow list", "  paths: [src/a/**, \"src/b/**\"]\n"],
    ["block list", "  paths:\n    - src/a/**\n    - 'src/b/**'\n"],
    ["block list at the key's indent", "  paths:\n  - src/a/**\n\n  - src/b/**\n"],
    ["block list with an empty item and a comment line", "  paths:\n    - src/a/**\n    -\n    # a note\n    - src/b/**\n"],
  ])("%s", (_shape, value) => {
    expect(metadataList(skill(`metadata:\n${value}`), "paths")).toEqual(["src/a/**", "src/b/**"]);
  });

  test("a trailing comment is dropped from scalars, flow lists and block items, never inside quotes", () => {
    const content = skill(
      [
        "deprecated: true # superseded",
        "quoted: 'a # b' # c",
        "hash: a#b",
        "metadata:",
        '  flags: ["--x # y", --z] # note',
        "  items:",
        "    - --a # family flag",
        "    - '--b # kept'",
        "",
      ].join("\n"),
    );
    expect(frontmatterScalar(content, "deprecated")).toBe("true");
    expect(frontmatterScalar(content, "quoted")).toBe("a # b");
    expect(frontmatterScalar(content, "hash")).toBe("a#b");
    expect(metadataList(content, "flags")).toEqual(["--x # y", "--z"]);
    expect(metadataList(content, "items")).toEqual(["--a", "--b # kept"]);
  });

  test("only keys at metadata's own indentation are its fields", () => {
    const content = skill("metadata:\n  nested:\n    category: review\n    paths: src/x/**\n  version: 2\n");
    expect(frontmatterScalar(content, "category", "metadata")).toBeUndefined();
    expect(metadataList(content, "paths")).toEqual([]);
    expect(frontmatterScalar(content, "version", "metadata")).toBe("2");
    const nested = frontmatterField(content, "nested", "metadata");
    expect(nested?.kind).toBe("mapping");
    // A key left of metadata's indentation is not one of its fields either.
    const outdented = skill("metadata:\n    version: 2\n  category: review\n");
    expect(frontmatterScalar(outdented, "version", "metadata")).toBe("2");
    expect(frontmatterScalar(outdented, "category", "metadata")).toBeUndefined();
  });

  test("a top-level key is not a metadata field, and a metadata field is not a top-level key", () => {
    const content = skill("paths: src/top/**\nmetadata:\n  category: review\nother:\n  paths: src/other/**\n");
    expect(metadataList(content, "paths")).toEqual([]);
    expect(frontmatterList(content, "paths")).toEqual(["src/top/**"]);
    expect(frontmatterScalar(content, "category")).toBeUndefined();
  });

  test("a block list ends at the first line under its key that is not an item", () => {
    // The stray line sits inside the key's value run, so the list reader itself
    // has to stop there: the item after it is not part of the list.
    expect(metadataList(skill("metadata:\n  paths:\n    - src/a/**\n    stray text\n    - src/no/**\n"), "paths")).toEqual([
      "src/a/**",
    ]);
    expect(metadataList(skill("metadata:\n  paths:\n  - src/a/**\n    nested: x\n  - src/no/**\n"), "paths")).toEqual(["src/a/**"]);
  });

  test("a block list's value run ends at the next key and at an item indented less than its key", () => {
    // These end before the list reader sees them: the key's value run stops at
    // a line at or left of the key that is not a `- item` at the key's indent.
    expect(metadataList(skill("metadata:\n  paths:\n    - src/a/**\n  flags: --x\n    - src/no/**\n"), "paths")).toEqual(["src/a/**"]);
    expect(metadataList(skill("metadata:\n    paths:\n    - src/a/**\n  - src/no/**\n"), "paths")).toEqual(["src/a/**"]);
  });

  test("a block scalar folds to one line and keeps a `#` as text", () => {
    const content = skill("description: >-\n  Use for #12,\n\n  and more.\ntriggers:\n  - one # c\n  - 'two'\n");
    expect(parseSkillFrontmatter(content)).toMatchObject({ description: "Use for #12, and more.", triggers: ["one", "two"] });
  });

  test("shapes outside the subset read as not declared", () => {
    const content = skill(
      ["flow_map: {a: 1}", "nested_flow: [[a], b]", "unclosed: [a, b", "metadata:", "  paths: {src: a}", "  other:", "    plain", ""].join("\n"),
    );
    expect(frontmatterField(content, "flow_map")?.kind).toBe("unsupported");
    expect(frontmatterList(content, "nested_flow")).toEqual([]);
    expect(frontmatterList(content, "unclosed")).toEqual([]);
    expect(frontmatterScalar(content, "unclosed")).toBeUndefined();
    expect(metadataList(content, "paths")).toEqual([]);
    expect(frontmatterField(content, "other", "metadata")?.kind).toBe("unsupported");
  });

  test("a key with no value is an empty scalar; the first of a duplicated key wins", () => {
    const content = skill("empty:\nname: second\n");
    expect(frontmatterScalar(content, "empty")).toBe("");
    expect(frontmatterScalar(content, "name")).toBe("x");
  });
});

/**
 * One row per behaviour the module header promises, each pinned by the value a
 * consumer reads. The `pins` column names the mutant of the reader the row
 * kills (flow 360 round-3 mutation pass, H-006).
 */
describe("the promised subset, one behaviour per row", () => {
  const skill = (frontmatter: string): string => `---\nname: x\n${frontmatter}---\n\nbody\n`;
  const top = (key: string) => (content: string) => frontmatterScalar(content, key);
  const meta = (key: string) => (content: string) => frontmatterScalar(content, key, "metadata");
  const list = (key: string) => (content: string) => metadataList(content, key);
  const kind = (key: string, scope: "top" | "metadata" = "top") => (content: string) => frontmatterField(content, key, scope)?.kind;

  type Row = {
    readonly pins: string;
    readonly behaviour: string;
    readonly content: string;
    readonly read: (content: string) => unknown;
    readonly expected: unknown;
  };
  const rows: readonly Row[] = [
    // The fences.
    { pins: "F03", behaviour: "the opening fence may carry trailing whitespace", content: "---  \t\nname: x\n---\n", read: top("name"), expected: "x" },
    { pins: "F06", behaviour: "the closing fence may carry trailing whitespace", content: "---\nname: x\n--- \t\n\nbody\n", read: top("name"), expected: "x" },
    // Keys.
    { pins: "F12, F22", behaviour: "a double-quoted key is read unquoted", content: skill('"title": T\n'), read: top("title"), expected: "T" },
    { pins: "F12, F22", behaviour: "a single-quoted key is read unquoted", content: skill("'owner': O\n"), read: top("owner"), expected: "O" },
    { pins: "F13", behaviour: "a `:` not followed by whitespace does not end a key", content: skill("url:http\n"), read: top("url"), expected: undefined },
    { pins: "F14", behaviour: "a `- ` line is never a key", content: "---\n- name: y\n---\n", read: (content) => [...(readFrontmatter(content)?.keys() ?? [])], expected: [] },
    { pins: "F63", behaviour: "a tab counts as indentation", content: skill("metadata:\n\tcategory: review\n"), read: meta("category"), expected: "review" },
    {
      pins: "I25r",
      behaviour: "a line left of a mapping's indentation is never one of its keys",
      content: skill("metadata:\n    version: 2\n  - category: review\n"),
      read: meta("category"),
      expected: undefined,
    },
    // Block scalars.
    {
      pins: "F23",
      behaviour: "a `#` line at the key's indentation inside a block scalar is a comment, not text",
      content: skill("description: |\n  line one\n# a note\n  line two\n"),
      read: top("description"),
      expected: "line one line two",
    },
    // Unsupported shapes.
    { pins: "F26", behaviour: "an anchor is unsupported", content: skill("anchor: &a x\n"), read: kind("anchor"), expected: "unsupported" },
    { pins: "F26", behaviour: "an alias is unsupported", content: skill("alias: *a\n"), read: kind("alias"), expected: "unsupported" },
    { pins: "F26", behaviour: "a tag is unsupported", content: skill("tagged: !str x\n"), read: kind("tagged"), expected: "unsupported" },
    { pins: "F37", behaviour: "a flow list as a block-list item is unsupported", content: skill("metadata:\n  paths:\n    - [src/a/**, src/b/**]\n"), read: kind("paths", "metadata"), expected: "unsupported" },
    { pins: "F37", behaviour: "a flow mapping as a block-list item reads as no list", content: skill("metadata:\n  paths:\n    - src/a/**\n    - {src: b}\n"), read: list("paths"), expected: [] },
    // Block list end.
    { pins: "F35", behaviour: "a block list ends at a non-item line under its key", content: skill("metadata:\n  paths:\n    - src/a/**\n    stray\n    - src/no/**\n"), read: list("paths"), expected: ["src/a/**"] },
    // Flow lists.
    { pins: "F42", behaviour: "a flow list drops empty items", content: skill("metadata:\n  paths: [src/a/**, , src/b/**,]\n"), read: list("paths"), expected: ["src/a/**", "src/b/**"] },
    // Comments and quotes.
    { pins: "F44", behaviour: "an apostrophe inside a word opens no quote (`it's # c`)", content: skill("note: it's # c\n"), read: top("note"), expected: "it's" },
    { pins: "F45", behaviour: 'a `\\"` does not close a double-quoted scalar, and is kept as written', content: skill('note: "a \\" # b" # c\n'), read: top("note"), expected: 'a \\" # b' },
    { pins: "F46", behaviour: "a `''` does not close a single-quoted scalar, and is kept as written", content: skill("note: 'it''s # b' # c\n"), read: top("note"), expected: "it''s # b" },
    { pins: "F49", behaviour: "a `#` that opens the value is a comment (`paths: # none`)", content: skill("metadata:\n  paths: # none\n"), read: list("paths"), expected: [] },
    { pins: "F49", behaviour: "a value that is only a comment is an empty scalar", content: skill("metadata:\n  paths: # none\n"), read: meta("paths"), expected: "" },
    { pins: "F54", behaviour: "a lone quote is not a quoted scalar", content: skill('note: "\n'), read: top("note"), expected: '"' },
    { pins: "F55", behaviour: "mismatched quotes are not removed", content: skill("note: \"abc'\n"), read: top("note"), expected: "\"abc'" },
    // Comma-separated scalar lists.
    { pins: "F51", behaviour: "a comma inside a quoted entry does not split it", content: skill("metadata:\n  paths: 'src/a,b/**', src/c/**\n"), read: list("paths"), expected: ["src/a,b/**", "src/c/**"] },
    { pins: "F51", behaviour: "a comma inside a quoted flow-list item does not split it", content: skill('metadata:\n  paths: ["src/a,b/**", src/c/**]\n'), read: list("paths"), expected: ["src/a,b/**", "src/c/**"] },
    { pins: "F52", behaviour: "a quote inside an entry opens no quote", content: skill("metadata:\n  paths: src/o'brien/**, src/b'/**\n"), read: list("paths"), expected: ["src/o'brien/**", "src/b'/**"] },
    // The routing projection.
    { pins: "F58", behaviour: "a scalar `triggers:` is not a list", content: skill("triggers: one, two\n"), read: (content) => parseSkillFrontmatter(content).triggers, expected: undefined },
    {
      pins: "F59",
      behaviour: "an empty metadata scalar reads as not declared",
      content: skill("metadata:\n  category:\n  version: \"\"\n  origin: ''\n"),
      read: parseSkillFrontmatter,
      expected: { name: "x" },
    },
    { pins: "F60", behaviour: "an empty compatible_harnesses reads as not declared", content: skill("metadata:\n  compatible_harnesses:\n"), read: parseSkillFrontmatter, expected: { name: "x" } },
  ];

  test.each(rows.map((row) => [`${row.behaviour} [${row.pins}]`, row] as const))("%s", (_name, row) => {
    expect(row.read(row.content)).toEqual(row.expected);
  });
});
