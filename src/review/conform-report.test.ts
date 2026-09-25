// Flow 308, AC6/AC9: report rendering and the opt-in gate.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluatedVerdict, notCheckableVerdict, notEvaluatedVerdict } from "./conform-jev";
import { applyClauseTags, extractReferenceClauses } from "./conform-clauses";
import { conformResultToJson, readConformEnabled, renderConformMarkdown, withRecentDoc } from "./conform-report";

let dir = "";
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("AC9: readConformEnabled", () => {
  test("absent config reads false", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-gate-"));
    expect(await readConformEnabled(dir)).toBe(false);
  });

  test("review.jev.conform: true reads true", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-gate-"));
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { conform: true } } }));
    expect(await readConformEnabled(dir)).toBe(true);
  });

  test("review.jev.ci_triage: true does NOT also enable conform — separate keys", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-gate-"));
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ci_triage: true } } }));
    expect(await readConformEnabled(dir)).toBe(false);
  });

  test("malformed JSON reads false, never throws", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-gate-"));
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), "{not json");
    expect(await readConformEnabled(dir)).toBe(false);
  });
});

describe("AC6: rendering", () => {
  function clausesFrom(texts: readonly string[]): ReturnType<typeof applyClauseTags> {
    const doc = ["# H", "", ...texts.map((t) => `- ${t} [state:pr]`)].join("\n");
    return applyClauseTags(extractReferenceClauses(doc), new Map());
  }

  test("not-checkable clauses are always listed, never dropped", () => {
    const raw = extractReferenceClauses("# H\n\n- Manual step. [not-checkable: no artefact]");
    const tagged = applyClauseTags(raw, new Map())[0]!;
    const md = renderConformMarkdown({
      refPath: "docs/ref.md",
      target: { kind: "pr", label: "PR #1" },
      threshold: 0.5,
      verdicts: [notCheckableVerdict(tagged)],
    });
    expect(md).toContain("not checkable");
    expect(md).toContain("no artefact");
  });

  test("clauses whose kind has no state supplied are listed as not evaluated", () => {
    const [c] = clausesFrom(["A rule."]);
    const md = renderConformMarkdown({
      refPath: "docs/ref.md",
      target: { kind: "diff", label: "working diff" },
      threshold: 0.5,
      verdicts: [notEvaluatedVerdict(c!)],
    });
    expect(md).toContain("not evaluated");
  });

  test("prints id, kind, probability, and evidence for an evaluated clause", () => {
    const [c] = clausesFrom(["A rule."]);
    const verdict = evaluatedVerdict(c!, { factLines: ["fact one"] }, 0.83);
    const md = renderConformMarkdown({
      refPath: "docs/ref.md",
      target: { kind: "pr", label: "PR #1" },
      threshold: 0.5,
      verdicts: [verdict],
    });
    expect(md).toContain(c!.clause_id);
    expect(md).toContain("pr");
    expect(md).toContain("83%");
    expect(md).toContain("fact one");
  });

  test("--explain adds a labelled advisory explanation, distinct from a finding", () => {
    const [c] = clausesFrom(["A rule."]);
    const verdict = evaluatedVerdict(c!, { factLines: ["fact"] }, 0.1);
    const md = renderConformMarkdown({
      refPath: "docs/ref.md",
      target: { kind: "pr", label: "PR #1" },
      threshold: 0.5,
      verdicts: [verdict],
      explanations: { [c!.clause_id]: "This looks violated because of X." },
    });
    expect(md).toContain("ADVISORY");
    expect(md).toContain("This looks violated because of X.");
  });

  test("conformResultToJson round-trips the same facts as the markdown", () => {
    const [c] = clausesFrom(["A rule."]);
    const verdict = evaluatedVerdict(c!, { factLines: ["fact"] }, 0.83);
    const json = conformResultToJson({
      refPath: "docs/ref.md",
      target: { kind: "pr", label: "PR #1" },
      threshold: 0.5,
      verdicts: [verdict],
    }) as { clauses: readonly { clause_id: string; probability: number }[] };
    expect(json.clauses[0]?.clause_id).toBe(c!.clause_id);
    expect(json.clauses[0]?.probability).toBe(0.83);
  });
});

describe("AC8 support: withRecentDoc", () => {
  test("moves a re-picked doc to the front and dedupes", () => {
    const next = withRecentDoc(["a", "b", "c"], "b");
    expect(next).toEqual(["b", "a", "c"]);
  });

  test("caps at the max length", () => {
    const start = Array.from({ length: 8 }, (_, i) => `doc-${i}`);
    const next = withRecentDoc(start, "new-doc");
    expect(next).toHaveLength(8);
    expect(next[0]).toBe("new-doc");
  });
});
