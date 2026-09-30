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

  test("a block list ends at the next key and at an item indented less than its key", () => {
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
