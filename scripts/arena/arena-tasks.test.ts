import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFrozenT1, parseTaskFile } from "./arena-tasks";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-tasks-"));
  const file = path.join(dir, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

describe("loadFrozenT1", () => {
  const frozen = {
    kind: "arena-t1",
    seed: 20260909,
    tasks: [{ id: "abc12345", sha: "s1", parent: "p1", query: "subject\n\nbody", gold: ["src/a.ts"] }],
  };

  test("maps a frozen record onto the arena's task shape", () => {
    const task = loadFrozenT1(tmpFile("t1.json", JSON.stringify(frozen)))[0];
    expect(task?.id).toBe("t1-abc12345");
    expect(task?.type).toBe("research");
    // The arm is checked out at the PARENT, never at the commit that holds the answer.
    expect(task?.base).toBe("p1");
    expect(task?.answerSha).toBe("s1");
    expect(task?.gold).toEqual(["src/a.ts"]);
  });

  test("refuses a file of the wrong kind rather than guessing its shape", () => {
    expect(() => loadFrozenT1(tmpFile("x.json", JSON.stringify({ tasks: [] })))).toThrow(/not an arena-t1 artifact/);
  });

  test("refuses an empty task list, because a sweep over zero tasks still prints a verdict", () => {
    expect(() => loadFrozenT1(tmpFile("e.json", JSON.stringify({ kind: "arena-t1", tasks: [] })))).toThrow(
      /carries no tasks/,
    );
  });

  test("the real frozen artifact loads and carries the pre-registered count", () => {
    // Guards the artifact itself, not just the loader: if the file is ever
    // regenerated with a different count, the pre-registration is void and this
    // fails rather than the run quietly measuring something else.
    const tasks = loadFrozenT1(path.join(import.meta.dir, "..", "..", "arena", "tasks", "t1-tasks.json"));
    expect(tasks).toHaveLength(13);
    expect(new Set(tasks.map((task) => task.base)).size).toBe(13);
    for (const task of tasks) expect(task.type).toBe("research");
  });
});

describe("parseTaskFile", () => {
  const good = `---
id: t2-4490
type: implement
base: 441526a25
answerNeedles:
  - "clamped into the iterator's bounds"
  - "isInsideParent is always"
---

Unassigning step from the iterator is only possible from iterator settings.

Implement this in the repository you are in.
`;

  test("reads the scalars and the needle list", () => {
    const task = parseTaskFile(good, "t2.md");
    expect(task.id).toBe("t2-4490");
    expect(task.type).toBe("implement");
    expect(task.base).toBe("441526a25");
    expect(task.answerNeedles).toEqual(["clamped into the iterator's bounds", "isInsideParent is always"]);
  });

  test("the prompt is the body verbatim, trimmed — never the front matter", () => {
    const task = parseTaskFile(good, "t2.md");
    expect(task.query.startsWith("Unassigning step")).toBe(true);
    expect(task.query).not.toContain("answerNeedles");
    expect(task.query).not.toContain("base:");
  });

  test("a comment line inside the needle list is not a needle", () => {
    const withComment = good.replace("answerNeedles:\n", "answerNeedles:\n  # from the published analysis\n");
    expect(parseTaskFile(withComment, "t2.md").answerNeedles).toHaveLength(2);
  });

  test("refuses a file with no front matter", () => {
    expect(() => parseTaskFile("just a prompt\n", "t2.md")).toThrow(/no front matter/);
  });

  test("refuses a missing required field rather than defaulting it", () => {
    expect(() => parseTaskFile(good.replace("base: 441526a25\n", ""), "t2.md")).toThrow(/missing `base`/);
  });

  test("refuses an unknown type", () => {
    expect(() => parseTaskFile(good.replace("type: implement", "type: review"), "t2.md")).toThrow(/must be/);
  });

  test("refuses an empty prompt body", () => {
    const headerOnly = "---\nid: t\ntype: implement\nbase: abc\n---\n\n";
    expect(() => parseTaskFile(headerOnly, "t2.md")).toThrow(/prompt body is empty/);
  });

  test("the real T2 file parses and asks for nothing keryx-shaped", () => {
    // The prompt must not hint at tooling: naming a tool would measure obedience
    // rather than whether the workspace helped.
    const file = path.join(import.meta.dir, "..", "..", "arena", "tasks", "t2-4490.md");
    const task = parseTaskFile(readFileSync(file, "utf8"), file);
    expect(task.type).toBe("implement");
    expect(task.query.toLowerCase()).not.toContain("keryx");
    expect(task.query.toLowerCase()).not.toContain("metaproject");
    expect(task.query.toLowerCase()).not.toContain("clamp");
    expect(task.answerNeedles.length).toBeGreaterThan(0);
  });
});
