// Every keryx start loads the local shells. The remote-control protocol pulls in ~4.6 MB of generated ajv validators,
// so no static runtime import path from those entry points may reach it (a lazy `import()` is fine).
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { resolveSpecifier, stripShebang } from "./import-policy";

const SRC = path.resolve(import.meta.dir, "..");
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
const heavy = (file: string) => file === path.join(SRC, "remote-control", "protocol.ts") || file.startsWith(path.join(SRC, "remote-control", "generated") + path.sep);

function staticRuntimeEdges(file: string): string[] {
  const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
  return transpiler.scanImports(stripShebang(readFileSync(file, "utf8"))).filter((entry) => entry.kind === "import-statement")
    .map((entry) => resolveSpecifier(file, entry.path)).filter((target): target is string => target !== undefined && /\.tsx?$/.test(target));
}

/** Breadth-first over static imports; returns the chain to the first heavy module, and how many files were walked. */
function pathToHeavy(entry: string): { chain: string[] | undefined; visited: number } {
  const start = path.join(SRC, entry); const parent = new Map<string, string | undefined>([[start, undefined]]); const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (heavy(file)) { const chain: string[] = []; for (let at: string | undefined = file; at !== undefined; at = parent.get(at)) chain.unshift(path.relative(SRC, at)); return { chain, visited: parent.size }; }
    for (const next of staticRuntimeEdges(file)) if (!parent.has(next)) { parent.set(next, file); queue.push(next); }
  }
  return { chain: undefined, visited: parent.size };
}

test("the local entry points have no static runtime path to the generated remote-control validators", () => {
  for (const entry of ["cli.ts", "commands/shell.ts", "tui/tui-shell.ts"]) {
    const { chain, visited } = pathToHeavy(entry);
    expect({ entry, chain: chain?.join(" -> ") }).toEqual({ entry, chain: undefined });
    expect(visited).toBeGreaterThan(100);
  }
});

test("the walk does find a static path where one exists", () => {
  expect(pathToHeavy("session/commands/plan.ts").chain).toEqual(["session/commands/plan.ts", "remote-control/protocol.ts"]);
});
