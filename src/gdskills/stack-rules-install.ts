// Which stack packs' rules `keryx init` and `keryx update` install, and where
// from (ADR-0001 D1, P4). The language and framework layers are the stack
// packs; since P4 they carry rows that used to ship in `rules/core/`, so a
// project whose stack a pack matches must receive that pack's rules from the
// same commands that install the core layer — not only from an explicit
// `keryx skills install`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectStack } from "../stack/detect";

/** Where a pack's rules install, under `.metaproject/rules/`. */
export const STACK_RULES_LAYER_DIR = "stacks";

export type BundledStackPack = {
  id: string;
  /** Stack-detection tags that select this pack; any one present is enough. */
  detectionMarkers: readonly string[];
  /** Packs this one builds on (`mobx` → `react` → `ts-js-node`); installed with it. */
  extends: readonly string[];
};

/** The bundled `stacks/` directory, from the source tree or the published package. */
export function bundledStacksSourcePath(): string {
  const directPath = fileURLToPath(new URL("./bundled/stacks", import.meta.url));
  if (existsSync(directPath)) return directPath;
  const packagedSourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "gdskills", "bundled", "stacks");
  return existsSync(packagedSourcePath) ? packagedSourcePath : directPath;
}

/** A pack's bundled rules directory: `<stacksRoot>/<pack>/rules`. */
export function bundledPackRulesPath(stacksRoot: string, pack: string): string {
  return path.join(stacksRoot, pack, "rules");
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Every pack under `stacksRoot` that ships a `rules/` directory, sorted by id. A pack.json that does not parse is skipped. */
export function readBundledStackPacks(stacksRoot: string): BundledStackPack[] {
  let names: string[];
  try {
    names = readdirSync(stacksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const packs: BundledStackPack[] = [];
  for (const name of names.sort()) {
    if (!existsSync(bundledPackRulesPath(stacksRoot, name))) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path.join(stacksRoot, name, "pack.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    packs.push({ id: name, detectionMarkers: stringList(parsed["detectionMarkers"]), extends: stringList(parsed["extends"]) });
  }
  return packs;
}

/**
 * The packs a detected stack selects: every pack with a detection marker whose
 * tag is `true`, plus everything those packs extend, transitively. Sorted.
 *
 * `detectStack` already folds an uncertain signal into `true` for every tag
 * its family covers, so a project whose manifest cannot be read gets that
 * family's packs rather than losing rules it used to get from core.
 */
export function selectStackPacks(packs: readonly BundledStackPack[], tags: Readonly<Record<string, boolean>>): string[] {
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  const selected = new Set<string>();
  const add = (id: string): void => {
    const pack = byId.get(id);
    if (pack === undefined || selected.has(id)) return;
    selected.add(id);
    for (const parent of pack.extends) add(parent);
  };
  for (const pack of packs) {
    if (pack.detectionMarkers.some((marker) => tags[marker] === true)) add(pack.id);
  }
  return [...selected].sort();
}

/**
 * What is wrong with the bundled `stacks/` tree, one line each: the directory
 * cannot be listed, or a pack that ships `rules/` has a `pack.json` that does
 * not parse. Such a pack can never be selected, so `keryx update` says so
 * instead of silently selecting nothing (review LS-3). Empty when all is well.
 */
export function bundledStackPackProblems(stacksRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(stacksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unknown error";
    return [`the bundled stack packs at ${stacksRoot} could not be read (${code}); no pack rules were installed — reinstall keryx, then run \`keryx update\``];
  }
  const problems: string[] = [];
  for (const name of names.sort()) {
    if (!existsSync(bundledPackRulesPath(stacksRoot, name))) continue;
    try {
      JSON.parse(readFileSync(path.join(stacksRoot, name, "pack.json"), "utf8"));
    } catch {
      problems.push(`the bundled ${name} stack pack has no readable pack.json, so it cannot be selected; its rules were not installed — reinstall keryx, then run \`keryx update\``);
    }
  }
  return problems;
}

/** The bundled install manifest, from the source tree or the published package. */
function bundledInstallManifestPath(): string {
  return path.join(path.dirname(bundledStacksSourcePath()), "install-manifest.json");
}

/**
 * The manifest component that installs a pack's rules: the one whose modules
 * carry `<pack>-rules` (`framework:react`, `capability:mobx`, `tool:storybook`,
 * …), or the pack id when the manifest does not say.
 */
export function stackPackComponent(pack: string, manifestPath: string = bundledInstallManifestPath()): string {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { components?: Record<string, { modules?: unknown }> };
    const found = Object.entries(manifest.components ?? {})
      .find(([, entry]) => Array.isArray(entry.modules) && entry.modules.includes(`${pack}-rules`));
    if (found !== undefined) return found[0];
  } catch {
    // An unreadable manifest still leaves a usable hint: the pack id.
  }
  return pack;
}

/** The command that installs one pack's rules into `.metaproject/rules/stacks/<pack>/` when detection did not select it. */
export function stackPackInstallCommand(pack: string, manifestPath?: string): string {
  return `keryx skills install --profile core --target keryx-shell --with ${stackPackComponent(pack, manifestPath)}`;
}

/** Run stack detection on `projectRoot` and select the bundled packs it matches. */
export async function detectStackPacks(projectRoot: string, stacksRoot: string = bundledStacksSourcePath()): Promise<string[]> {
  const detection = await detectStack(projectRoot);
  return selectStackPacks(readBundledStackPacks(stacksRoot), detection.tags);
}
