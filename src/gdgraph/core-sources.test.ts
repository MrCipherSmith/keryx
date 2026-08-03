// The copied gdgraph core must be import-closed.
//
// `init` and `update` copy a few `src/gdgraph/*.ts` files into
// `.metaproject/core/gdgraph/` so a project can run the graph builder without
// the full toolkit. The list was hand-maintained, in two places, and nothing
// checked it against what those files actually import.
//
// So when `query.ts` gained `import { resolveGraphTarget } from "./target"`,
// neither copy learned about it, and `keryx gdgraph build` — the very first
// "Next step" that `init` prints — died on every fresh install with
// `Cannot find module './target'`. The suite stayed green throughout, because
// nothing ever ran the copied tree.
//
// The domain of "which files does the copied core need" is not a list. It is
// the transitive closure of RUNTIME imports from the entry points, and written
// as a list it goes stale on the next `import`.
//
// The first version of this test matched imports with a regular expression and
// immediately proved the repository's own lesson about pattern guards: it
// matched the string `from "./m"` inside a COMMENT in `build.ts` and demanded a
// file called `m.ts`. So it uses `Bun.Transpiler.scanImports` instead — the same
// parser-backed scan gdgraph itself uses. That also gets the semantics right:
// the transpiler drops type-only imports, and a type-only import genuinely does
// not need its file present at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GDGRAPH_CORE_SOURCES } from "./core-sources";

const GDGRAPH_DIR = import.meta.dir;
const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * Local imports of one module that must resolve for it to LOAD.
 *
 * Two exclusions, both deliberate rather than convenient:
 *
 *   * type-only imports never reach runtime — the transpiler drops them, and
 *     `scanImports` does not report them;
 *   * a `dynamic-import` is a deliberate lazy edge. `build.ts` reaches `enrich`
 *     that way precisely so it can run in an environment that lacks it —
 *     `enrich.ts:9` names "the copied `.metaproject/core/gdgraph`" as that
 *     environment. Requiring it would copy the whole optional-capability tree
 *     into every scaffolded project and invert the design.
 *
 * So the closure is over `import-statement` only. That is the set whose absence
 * is a crash at load, which is the failure this test exists to prevent.
 */
function runtimeImportsOf(basename: string): string[] {
  const source = readFileSync(path.join(GDGRAPH_DIR, basename), "utf8");
  return transpiler
    .scanImports(source)
    .filter((entry) => entry.kind === "import-statement" && entry.path.startsWith("./"))
    .map((entry) => `${entry.path.slice(2).replace(/\.(ts|js)$/, "")}.ts`);
}

/** Every module reachable from `entries` through runtime local imports. */
function importClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of runtimeImportsOf(current)) queue.push(next);
  }
  return seen;
}

describe("the copied gdgraph core is import-closed", () => {
  // `cli.ts` is rendered rather than copied, and it drives these two.
  const ENTRY_POINTS = ["build.ts", "query.ts"] as const;

  test("every module the entry points reach at runtime is copied", () => {
    const needed = importClosure(ENTRY_POINTS);
    const copied = new Set(GDGRAPH_CORE_SOURCES);
    const missing = [...needed].filter((f) => !copied.has(f)).sort();
    // A failure here means a fresh `keryx init` followed by `keryx gdgraph
    // build` dies on a missing module. Add the file to GDGRAPH_CORE_SOURCES.
    expect(missing).toEqual([]);
  });

  test("every file in the copy list exists", () => {
    for (const file of GDGRAPH_CORE_SOURCES) {
      expect(() => readFileSync(path.join(GDGRAPH_DIR, file), "utf8")).not.toThrow();
    }
  });

  test("the closure is non-trivial, so a passing test is not vacuous", () => {
    // If `scanImports` ever silently returned nothing, the first assertion
    // would pass against an empty set. Pin the floor, and pin the specific file
    // whose absence caused the outage.
    const needed = importClosure(ENTRY_POINTS);
    expect(needed.size).toBeGreaterThanOrEqual(3);
    expect(needed.has("build.ts")).toBe(true);
    expect(needed.has("query.ts")).toBe(true);
    expect(needed.has("target.ts")).toBe(true);
  });
});
