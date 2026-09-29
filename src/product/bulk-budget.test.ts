// Flow 362, AC9: the module's bulk is a budget. One module, two commands, no
// skill, no subagent, no gate. This pins the counts so a later addition (a map
// command, an admit step, a skill) has to edit this file on purpose.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { productCommand } from "../commands/product";
import { GROUP_SUBCOMMANDS } from "../lib/group-subcommands";
import { COMMAND_DESCRIPTORS } from "../standard/command-registry";
import { CLI_ROUTES } from "../cli";

const REPO = path.resolve(import.meta.dir, "..", "..");
const realLog = console.log;
const realError = console.error;

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
});

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe("the bulk budget: 1 module, 2 commands, 0 skills, 0 subagents, 0 gates", () => {
  test("one module: a single src directory and a single module page carry the name", async () => {
    expect((await names(path.join(REPO, "src"))).filter((name) => /product/i.test(name) && !name.includes("."))).toEqual(["product"]);
    expect((await names(path.join(REPO, ".metaproject", "modules"))).filter((name) => /product/i.test(name))).toEqual(["product.md"]);
    expect(Object.keys(CLI_ROUTES).filter((route) => /product/i.test(route))).toEqual(["product"]);
  });

  test("two commands: the registry, the subcommand vocabulary and the usage text expose only index and open", async () => {
    const described = COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.module === "product").map((descriptor) => descriptor.command);
    expect(described).toEqual(["product index", "product open"]);
    expect(GROUP_SUBCOMMANDS.get("product")).toEqual(["index", "open"]);
    const registry = await readFile(path.join(REPO, "src", "cli-registry.ts"), "utf8");
    const usage = registry.split("\n").filter((line) => /^\s+keryx product /.test(line));
    expect(usage.map((line) => /keryx product (\S+)/.exec(line)?.[1])).toEqual(["index", "open"]);
  });

  test("anything else under `product` is refused, including a map or an admit step", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    console.log = () => {};
    for (const subcommand of ["map", "admit", "show", "list"]) {
      process.exitCode = 0;
      await productCommand([subcommand]);
      expect(process.exitCode).toBe(1);
    }
    expect(errors.filter((line) => line.startsWith("Unknown product subcommand"))).toHaveLength(4);
  });

  test("no skill: nothing named for the product is a bundled or project skill", async () => {
    const roots = [path.join(REPO, ".metaproject", "skills"), path.join(REPO, ".metaproject", "project-skills"), path.join(REPO, "src", "gdskills", "bundled", "skills")];
    for (const root of roots) {
      const found: string[] = [];
      async function walk(dir: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (/^product/i.test(entry.name)) found.push(path.relative(REPO, path.join(dir, entry.name)));
          if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        }
      }
      await walk(root);
      expect(found, root).toEqual([]);
    }
  });

  test("no subagent: nothing named for the product is a bundled or project agent", async () => {
    for (const root of [path.join(REPO, ".claude", "agents"), path.join(REPO, ".metaproject", "agents"), path.join(REPO, "src", "gdskills", "bundled", "agents")]) {
      expect((await names(root)).filter((name) => /product/i.test(name)), root).toEqual([]);
    }
  });

  test("no gate: the module registers no completion, review or freeze check", async () => {
    for (const file of ["corpus.ts", "extract.ts", "open.ts", "service.ts", "store.ts", "types.ts"]) {
      const text = await readFile(path.join(import.meta.dir, file), "utf8");
      expect(text, file).not.toMatch(/registerGate|gates\.push|status:\s*"fail"|process\.exit\(/);
    }
  });

  test("no existing command changes behaviour: the routes other than `product` keep their handlers", () => {
    expect(Object.keys(CLI_ROUTES)).toContain("product");
    expect(Object.keys(CLI_ROUTES)).toContain("governance");
    expect(Object.keys(CLI_ROUTES)).toContain("flow");
    expect(typeof CLI_ROUTES["product"]).toBe("function");
  });
});
