import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildGraph } from "./build";
import { loadGraph } from "./query";

test("buildGraph ignores generated frontend outputs and resolves imported assets", async () => {
  const root = path.join(tmpdir(), "gd-metapro-gdgraph-build");
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

async function reset(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

function importLine(rest: string): string {
  return `im${"port"} ${rest}`;
}
