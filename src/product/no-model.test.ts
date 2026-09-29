// Flow 362, AC10: nothing in `src/product/` calls a model. A static audit of
// every non-test source file: what it imports is a closed list of the standard
// library, one file helper, the criteria parser and its own siblings, and no
// line constructs a provider client, opens a network connection, starts a
// process or dispatches a subagent.

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PRODUCT_DIR = import.meta.dir;

const ALLOWED_IMPORTS = new Set(["node:fs/promises", "node:path", "../lib/fs", "../flow/ac-kinds"]);

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["a provider client", /\b(?:createProvider|resolveProvider|providerClient|new\s+(?:Anthropic|OpenAI|GoogleGenerativeAI))\b/],
  ["a model SDK", /@anthropic-ai|openai|@google\/generative-ai/i],
  ["a network call", /\bfetch\s*\(|\bnew\s+WebSocket\b|node:https?\b|node:net\b/],
  ["a child process", /child_process|\bBun\.spawn|\bspawnSync?\b|\bexecSync?\b/],
  ["a subagent dispatch", /\bsubagent|\bdelegate\s*\(|\bdispatch\w*\s*\(|\brunAgent\b|\bspawnAgent\b/i],
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "fixtures" || entry.name === "node_modules") continue;
      out.push(...(await sourceFiles(full)));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) found.push(match[1] ?? "");
  return found;
}

function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

describe("the product module calls no model", () => {
  test("the audit sees the module's source files", async () => {
    const files = (await sourceFiles(PRODUCT_DIR)).map((file) => path.basename(file)).sort();
    expect(files).toEqual(["corpus.ts", "extract.ts", "open.ts", "service.ts", "store.ts", "types.ts"]);
  });

  test("every import is standard library, a reviewed helper, or a sibling", async () => {
    for (const file of await sourceFiles(PRODUCT_DIR)) {
      for (const specifier of importSpecifiers(await readFile(file, "utf8"))) {
        const sibling = /^\.\/[a-z-]+$/.test(specifier);
        expect(sibling || ALLOWED_IMPORTS.has(specifier), `${path.basename(file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  test("no line constructs a provider client, opens a connection, starts a process or dispatches a subagent", async () => {
    for (const file of await sourceFiles(PRODUCT_DIR)) {
      const lines = codeLines(await readFile(file, "utf8"));
      for (const [what, pattern] of FORBIDDEN) {
        const hit = lines.find((line) => pattern.test(line));
        expect(hit, `${path.basename(file)} contains ${what}: ${hit ?? ""}`).toBeUndefined();
      }
    }
  });

  test("the command adapter reaches the module only through its facade", async () => {
    const adapter = await readFile(path.join(PRODUCT_DIR, "..", "commands", "product.ts"), "utf8");
    expect(importSpecifiers(adapter)).toEqual(["../product/service"]);
  });
});
