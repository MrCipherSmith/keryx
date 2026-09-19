import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// AC12 / D-11: the bus never writes Flow state. Source audit of every
// production file in `src/bus/` and of `src/commands/bus.ts`:
//
// - no import resolves into `src/flow/` (where every flow-state writer lives:
//   `service.ts`, `store.ts`, `allocation.ts`, ...);
// - no source text names `.metaproject` or a `flows` directory, so no path
//   under `.metaproject/flows` can be built here.
//
// The bus's own store is the git common directory (or the data dir), never
// the working tree's `.metaproject/`.

const SRC = path.join(import.meta.dir, "..");

function auditedFiles(): string[] {
  const busFiles = readdirSync(path.join(SRC, "bus"))
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => path.join(SRC, "bus", name));
  return [...busFiles, path.join(SRC, "commands", "bus.ts")];
}

function importSpecifiers(source: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return transpiler.scanImports(source).map((entry) => entry.path);
}

test("the audit covers the bus modules and the CLI", () => {
  const names = auditedFiles().map((file) => path.relative(SRC, file));
  expect(names).toEqual(expect.arrayContaining(["bus/log.ts", "bus/send.ts", "bus/prune.ts", "commands/bus.ts"]));
  expect(names.length).toBeGreaterThanOrEqual(10);
});

test("nothing in src/bus or src/commands/bus.ts imports from src/flow", () => {
  const offenders: string[] = [];
  for (const file of auditedFiles()) {
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved === path.join(SRC, "flow") || resolved.startsWith(path.join(SRC, "flow") + path.sep)) {
        offenders.push(`${path.relative(SRC, file)} -> ${specifier}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("nothing in src/bus or src/commands/bus.ts names .metaproject or a flows directory", () => {
  const offenders: string[] = [];
  for (const file of auditedFiles()) {
    const source = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)) // comments may explain the rule
      .join("\n");
    if (/\.metaproject|["'`/]flows\b/.test(source)) offenders.push(path.relative(SRC, file));
  }
  expect(offenders).toEqual([]);
});

test("the audit would catch a flow import (mutation check)", () => {
  const specifiers = importSpecifiers('import { flowsRoot } from "../flow/store";\nexport const x = flowsRoot;');
  expect(specifiers).toEqual(["../flow/store"]);
});
