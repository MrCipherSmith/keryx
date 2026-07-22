import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { loadGraph } from "./query";
import { uniqueTestRoot } from "../lib/test-tmp";

test("buildGraph ignores generated frontend outputs and resolves imported assets", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-build");
  await reset(root);
  await mkdir(path.join(root, "src", "feature"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await mkdir(path.join(root, "storybook-static", "assets"), { recursive: true });

  await writeFile(
    path.join(root, "src", "feature", "index.ts"),
    [
      importLine("'./style.css';"),
      importLine("icon from './icon.svg?react';"),
      importLine("raw from './template.hbs?raw';"),
      importLine("{ value } from './value';"),
      "export const result = `${value}-${icon}-${raw}`;",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "src", "feature", "value.ts"), "export const value = 'ok';\n");
  await writeFile(path.join(root, "src", "feature", "style.css"), ".x { color: red; }\n");
  await writeFile(path.join(root, "src", "feature", "icon.svg"), "<svg />\n");
  await writeFile(path.join(root, "src", "feature", "template.hbs"), "<div>{{value}}</div>\n");
  await writeFile(path.join(root, "public", "worker.js"), "export const generated = true;\n");
  await writeFile(path.join(root, "storybook-static", "assets", "bundle.js"), "export const generated = true;\n");

  const result = await buildGraph(root);
  const graph = await loadGraph(root);
  const summary = await readFile(result.summaryPath, "utf8");

  expect(graph.nodes.map((node) => node.path).sort()).toEqual([
    "src/feature/icon.svg",
    "src/feature/index.ts",
    "src/feature/style.css",
    "src/feature/template.hbs",
    "src/feature/value.ts",
  ]);
  expect(graph.nodes.filter((node) => node.kind === "file").length).toBe(2);
  expect(graph.nodes.filter((node) => node.kind === "asset").length).toBe(3);
  expect(graph.edges.filter((edge) => edge.kind === "imports").length).toBe(1);
  expect(graph.edges.filter((edge) => edge.kind === "asset").length).toBe(3);
  expect(graph.edges.filter((edge) => edge.kind === "unresolved").length).toBe(0);
  expect(summary).toContain("Skipped generated/static directories: 2");
  expect(summary).toContain("| feature | 2 |");
});

test("buildGraph resolves tsconfig path aliases and parser-scanned imports", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-gdgraph-aliases");
  await reset(root);
  await mkdir(path.join(root, "src", "components"), { recursive: true });
  await mkdir(path.join(root, "src", "utils"), { recursive: true });
  await mkdir(path.join(root, "src", "assets"), { recursive: true });

  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"],
          "~assets/*": ["src/assets/*"],
          "#config": ["src/config.ts"],
        },
      },
    }),
  );
  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      "import { Button } from '@/components/Button';",
      "export { value } from '@/utils';",
      "import logo from '~assets/logo.svg?raw';",
      "import config from '#config';",
      "const lazy = () => import('@/lazy');",
      "const cjs = require('@/cjs');",
      "const ignored = (name: string) => import(`@/dynamic/${name}`);",
      "export const result = { Button, logo, config, lazy, cjs, ignored };",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "src", "components", "Button.tsx"), "import React from 'react';\nexport const Button = () => null;\n");
  await writeFile(path.join(root, "src", "utils", "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "src", "config.ts"), "export default { ok: true };\n");
  await writeFile(path.join(root, "src", "lazy.ts"), "export const lazy = true;\n");
  await writeFile(path.join(root, "src", "cjs.ts"), "export const cjs = true;\n");
  await writeFile(path.join(root, "src", "assets", "logo.svg"), "<svg />\n");

  await buildGraph(root);
  const graph = await loadGraph(root);
  const edgesFromIndex = graph.edges.filter((edge) => edge.from === "src/index.ts");

  expect(edgesFromIndex.filter((edge) => edge.kind === "imports").map((edge) => edge.to).sort()).toEqual([
    "src/cjs.ts",
    "src/components/Button.tsx",
    "src/config.ts",
    "src/lazy.ts",
    "src/utils/index.ts",
  ]);
  expect(edgesFromIndex.filter((edge) => edge.kind === "asset").map((edge) => edge.to)).toEqual([
    "src/assets/logo.svg",
  ]);
  expect(graph.edges.filter((edge) => edge.kind === "unresolved")).toEqual([]);
  expect(graph.edges.some((edge) => edge.specifier.includes("dynamic"))).toBe(false);
});

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

function importLine(rest: string): string {
  return `im${"port"} ${rest}`;
}
