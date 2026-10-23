import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadReferences, parseReferences, REFERENCES_PATH, REFERENCES_SCHEMA } from "./references-config";

// AC1: `.metaproject/rules/project/references.json` (schema 1) is loaded; a
// committed JSON schema validates it; a declaration with neither globs nor
// keywords, an empty description or an absolute or escaping path is rejected with
// a message naming the entry.

const SCHEMA_FILE = path.join(import.meta.dir, "..", "..", "docs", "requirements", "keryx-conditional-reads", "schemas", "references.schema.json");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(references?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-references-config-"));
  roots.push(root);
  if (references !== undefined) {
    await mkdir(path.dirname(path.join(root, REFERENCES_PATH)), { recursive: true });
    await writeFile(path.join(root, REFERENCES_PATH), references, "utf8");
  }
  return root;
}

const GOOD_ENTRY = {
  path: "STYLING.md",
  when: { globs: ["src/**/*.css"], keywords: ["className", "tailwind"] },
  anchor: "Class conventions",
  description: "Class naming and the Tailwind 4 cascade contract.",
};

const doc = (...references: unknown[]): unknown => ({ schema: 1, references });

describe("parseReferences", () => {
  test("accepts a complete declaration and returns it typed", () => {
    const result = parseReferences(doc(GOOD_ENTRY));
    expect(result).toEqual({
      ok: true,
      references: [
        {
          path: "STYLING.md",
          when: { globs: ["src/**/*.css"], keywords: ["className", "tailwind"] },
          anchor: "Class conventions",
          description: "Class naming and the Tailwind 4 cascade contract.",
        },
      ],
    });
  });

  test("anchor is optional, and globs-only or keywords-only conditions are valid", () => {
    const result = parseReferences(
      doc(
        { path: "A.md", when: { globs: ["src/**"] }, description: "Only globs." },
        { path: "B.md", when: { keywords: ["theme"] }, description: "Only keywords." },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references[0]).toEqual({ path: "A.md", when: { globs: ["src/**"], keywords: [] }, description: "Only globs." });
    expect(result.references[1]?.when).toEqual({ globs: [], keywords: ["theme"] });
    expect(result.references[0]?.anchor).toBeUndefined();
  });

  test("normalises a path to posix and trims strings", () => {
    const result = parseReferences(doc({ ...GOOD_ENTRY, path: "docs\\.\\STYLING.md", description: "  Padded description.  " }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.references[0]?.path).toBe("docs/STYLING.md");
      expect(result.references[0]?.description).toBe("Padded description.");
    }
  });

  test("rejects a declaration with neither globs nor keywords, naming the entry", () => {
    for (const when of [{}, { globs: [], keywords: [] }, undefined]) {
      const result = parseReferences(doc({ ...GOOD_ENTRY, when }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('references[0] ("STYLING.md")');
      expect(result.errors[0]).toMatch(/globs|keywords/);
    }
  });

  test("rejects an empty or blank description", () => {
    for (const description of ["", "   ", undefined, 7]) {
      const result = parseReferences(doc({ ...GOOD_ENTRY, description }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toContain('references[0] ("STYLING.md"): description');
    }
  });

  test("rejects absolute paths", () => {
    for (const bad of ["/etc/passwd", "\\windows\\x.md", "C:/x.md", "c:\\x.md"]) {
      const result = parseReferences(doc({ ...GOOD_ENTRY, path: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain(`("${bad}")`);
        expect(result.errors[0]).toContain("absolute");
      }
    }
  });

  test("rejects paths that escape the project root", () => {
    for (const bad of ["../x.md", "docs/../../x.md", "..", "a/b/../../../c.md"]) {
      const result = parseReferences(doc({ ...GOOD_ENTRY, path: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toContain(`("${bad}")`);
        expect(result.errors[0]).toContain("escapes");
      }
    }
  });

  test("allows .. that stays inside the root", () => {
    const result = parseReferences(doc({ ...GOOD_ENTRY, path: "docs/../STYLING.md" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.references[0]?.path).toBe("STYLING.md");
  });

  test("rejects an empty path and names the entry by index", () => {
    const result = parseReferences(doc(GOOD_ENTRY, { ...GOOD_ENTRY, path: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("references[1]");
  });

  test("reports every bad entry, not only the first", () => {
    const result = parseReferences(doc({ ...GOOD_ENTRY, path: "../a.md" }, GOOD_ENTRY, { ...GOOD_ENTRY, description: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain("references[0]");
      expect(result.errors[1]).toContain("references[2]");
    }
  });

  test("rejects unknown properties, a wrong schema number and malformed shapes", () => {
    expect(parseReferences({ schema: 2, references: [] }).ok).toBe(false);
    expect(parseReferences({ references: [] }).ok).toBe(false);
    expect(parseReferences({ schema: 1 }).ok).toBe(false);
    expect(parseReferences({ schema: 1, references: [], extra: 1 }).ok).toBe(false);
    expect(parseReferences(doc({ ...GOOD_ENTRY, extra: true })).ok).toBe(false);
    expect(parseReferences(doc({ ...GOOD_ENTRY, anchor: "" })).ok).toBe(false);
    expect(parseReferences(doc({ ...GOOD_ENTRY, when: { globs: "src/**" } })).ok).toBe(false);
    expect(parseReferences(doc({ ...GOOD_ENTRY, when: { globs: [""], keywords: ["x"] } })).ok).toBe(false);
    expect(parseReferences(doc({ ...GOOD_ENTRY, when: { globs: ["a"], extra: 1 } })).ok).toBe(false);
    expect(parseReferences(doc("not an object")).ok).toBe(false);
    expect(parseReferences([]).ok).toBe(false);
    expect(parseReferences(null).ok).toBe(false);
  });

  test("an empty list is valid", () => {
    expect(parseReferences({ schema: 1, references: [] })).toEqual({ ok: true, references: [] });
  });

  test("two declarations of one document are an error naming both entries and the path, even with different anchors or spellings", () => {
    const result = parseReferences(
      doc(
        { ...GOOD_ENTRY, anchor: "Class conventions" },
        { path: "A.md", when: { globs: ["src/**"] }, description: "Another document." },
        { ...GOOD_ENTRY, path: "./docs/../STYLING.md", anchor: "Tailwind cascade" },
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('references[2] ("STYLING.md")');
    expect(result.errors[0]).toContain("references[0]");
    expect(result.errors[0]).toContain("declare each document once");
  });

  test("distinct documents may share a condition and an anchor", () => {
    const result = parseReferences(doc({ ...GOOD_ENTRY, path: "A.md" }, { ...GOOD_ENTRY, path: "B.md" }));
    expect(result.ok).toBe(true);
  });
});

describe("loadReferences", () => {
  test("a missing file means no declarations, without an error", async () => {
    const root = await project();
    expect(await loadReferences(root)).toEqual({ ok: true, present: false, references: [] });
  });

  test("loads a present file", async () => {
    const root = await project(JSON.stringify(doc(GOOD_ENTRY)));
    const result = await loadReferences(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(true);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.path).toBe("STYLING.md");
  });

  test("a leading byte order mark (an editor on Windows adds one) does not make the file invalid", async () => {
    const root = await project(`\uFEFF${JSON.stringify(doc(GOOD_ENTRY))}`);
    const result = await loadReferences(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.references).toHaveLength(1);
  });

  test("invalid JSON is an error naming the file, not a throw", async () => {
    const root = await project("{ not json");
    const result = await loadReferences(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain(REFERENCES_PATH);
  });

  test("a schema violation is an error naming the file and the entry", async () => {
    const root = await project(JSON.stringify(doc({ ...GOOD_ENTRY, description: "" })));
    const result = await loadReferences(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain(REFERENCES_PATH);
      expect(result.errors[0]).toContain('references[0] ("STYLING.md")');
    }
  });

  test("a directory in place of the file is an error, not a throw", async () => {
    const root = await project();
    await mkdir(path.join(root, REFERENCES_PATH), { recursive: true });
    const result = await loadReferences(root);
    expect(result.ok).toBe(false);
  });
});

// A minimal evaluator for the JSON Schema keywords references.schema.json uses,
// so the committed schema and the loader are shown to give one verdict.
type Node = Record<string, unknown>;

function validates(schema: Node, value: unknown): boolean {
  if ("const" in schema && schema["const"] !== value) return false;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return false;
  if (Array.isArray(schema["anyOf"]) && !(schema["anyOf"] as Node[]).some((branch) => validates(branch, value))) return false;
  const type = schema["type"] ?? (Array.isArray(schema["required"]) ? "object" : undefined);
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Node;
    for (const key of (schema["required"] as string[] | undefined) ?? []) if (!(key in record)) return false;
    const properties = (schema["properties"] as Record<string, Node> | undefined) ?? {};
    for (const [key, child] of Object.entries(record)) {
      const rule = properties[key];
      if (rule === undefined) {
        if (schema["additionalProperties"] === false) return false;
      } else if (!validates(rule, child)) return false;
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return false;
    if (schema["items"] !== undefined && !value.every((item) => validates(schema["items"] as Node, item))) return false;
  } else if (type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) return false;
    if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"], "u").test(value)) return false;
  } else if (type === "integer") {
    if (!Number.isInteger(value)) return false;
  }
  return true;
}

describe("references.schema.json", () => {
  test("the inline schema is the committed schema", async () => {
    const committed: unknown = JSON.parse(await readFile(SCHEMA_FILE, "utf8"));
    expect(committed).toEqual(REFERENCES_SCHEMA);
  });

  const cases: Array<[string, unknown, boolean]> = [
    ["full entry", doc(GOOD_ENTRY), true],
    ["empty list", { schema: 1, references: [] }, true],
    ["globs only", doc({ path: "A.md", when: { globs: ["a/**"] }, description: "x" }), true],
    ["keywords only", doc({ path: "A.md", when: { keywords: ["theme"] }, description: "x" }), true],
    ["neither globs nor keywords", doc({ ...GOOD_ENTRY, when: {} }), false],
    ["empty globs and keywords", doc({ ...GOOD_ENTRY, when: { globs: [], keywords: [] } }), false],
    ["missing when", doc({ path: "A.md", description: "x" }), false],
    ["empty description", doc({ ...GOOD_ENTRY, description: "" }), false],
    ["blank description", doc({ ...GOOD_ENTRY, description: "  " }), false],
    ["missing description", doc({ path: "A.md", when: { globs: ["a"] } }), false],
    ["absolute path", doc({ ...GOOD_ENTRY, path: "/etc/x.md" }), false],
    ["drive path", doc({ ...GOOD_ENTRY, path: "C:/x.md" }), false],
    ["empty path", doc({ ...GOOD_ENTRY, path: "" }), false],
    ["empty anchor", doc({ ...GOOD_ENTRY, anchor: "" }), false],
    ["unknown entry key", doc({ ...GOOD_ENTRY, extra: 1 }), false],
    ["unknown when key", doc({ ...GOOD_ENTRY, when: { globs: ["a"], extra: 1 } }), false],
    ["unknown root key", { schema: 1, references: [], extra: 1 }, false],
    ["wrong schema number", { schema: 2, references: [] }, false],
    ["missing schema", { references: [] }, false],
    ["missing references", { schema: 1 }, false],
    ["empty glob string", doc({ ...GOOD_ENTRY, when: { globs: [""] } }), false],
    ["globs not an array", doc({ ...GOOD_ENTRY, when: { globs: "a" } }), false],
  ];

  for (const [name, input, expected] of cases) {
    test(`schema and loader agree: ${name}`, () => {
      expect(validates(REFERENCES_SCHEMA as Node, input)).toBe(expected);
      expect(parseReferences(input).ok).toBe(expected);
    });
  }

  test("a path that escapes the root passes the schema and is rejected by the loader", () => {
    // JSON Schema cannot express normalisation; the loader owns this check.
    const input = doc({ ...GOOD_ENTRY, path: "../x.md" });
    expect(validates(REFERENCES_SCHEMA as Node, input)).toBe(true);
    expect(parseReferences(input).ok).toBe(false);
  });
});
