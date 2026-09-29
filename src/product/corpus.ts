// Read the flow and requirements corpus of one project into an IntentIndex.
// Read-only: it opens files under `.metaproject/flows/` and `docs/requirements/`
// and writes nothing. The result is deterministic — ordered, and free of any
// clock — so a second run over an unchanged tree is byte-identical.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractDocpackIntent, extractFlowIntent, hasInstrument } from "./extract";
import type { Intent, IntentCounts, IntentIndex } from "./types";

const PRIMARY_DOCS = ["prd.md", "PRD.md", "trd.md", "TRD.md", "README.md"];
const FLOW_SOURCE_FILES = ["flow.json", "description.md", "acceptance-criteria.md", "journal.md"];
const FLOW_PREFIX = ".metaproject/flows/";

export function flowsDir(cwd: string): string {
  return path.join(cwd, ".metaproject", "flows");
}

export function requirementsDir(cwd: string): string {
  return path.join(cwd, "docs", "requirements");
}

/** A file that is not there is `null`; any other failure to read it propagates. */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** A source that exists but cannot be read. The text is fixed: it never carries a runtime's own error message. */
class UnreadableSource extends Error {
  constructor(repoFile: string) {
    super(`${repoFile}: cannot be read`);
  }
}

async function readSource(file: string, repoFile: string): Promise<string | null> {
  try {
    return await readOptional(file);
  } catch {
    throw new UnreadableSource(repoFile);
  }
}

async function subdirectories(dir: string, accept: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && accept(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every flow package directory, by name. Files beside them (`README.md`, `id-map.json`) are not flows. */
export function listFlowPackages(cwd: string): Promise<string[]> {
  return subdirectories(flowsDir(cwd), (name) => /^\d+-/.test(name));
}

function requirementPackages(cwd: string): Promise<string[]> {
  return subdirectories(requirementsDir(cwd), (entry) => !entry.startsWith("_") && !entry.startsWith("."));
}

function digestOf(content: Buffer | null | "unreadable"): string {
  if (content === null) return "absent";
  if (content === "unreadable") return "unreadable";
  return createHash("sha256").update(content).digest("hex");
}

async function readBytes(file: string): Promise<Buffer | null | "unreadable"> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
}

/**
 * sha256 over every file the index reads, by repo-relative path and content, and
 * over the package names, so adding, removing or renaming a package changes it.
 * A flow contributes `flow.json`, `description.md`, `acceptance-criteria.md` and
 * `journal.md`; a requirements package the primary document it uses plus
 * `specification.md`. Content, not modification time: a restored or replaced
 * file with an older mtime still changes it, and a `touch` does not.
 */
export async function corpusFingerprint(cwd: string): Promise<string> {
  const lines: string[] = [];
  for (const name of await listFlowPackages(cwd)) {
    lines.push(`package\0flow\0${name}`);
    for (const file of FLOW_SOURCE_FILES) {
      const content = await readBytes(path.join(flowsDir(cwd), name, file));
      lines.push(`file\0${FLOW_PREFIX}${name}/${file}\0${digestOf(content)}`);
    }
  }
  for (const name of await requirementPackages(cwd)) {
    lines.push(`package\0docpack\0${name}`);
    const dir = path.join(requirementsDir(cwd), name);
    for (const candidate of PRIMARY_DOCS) {
      const content = await readBytes(path.join(dir, candidate));
      if (content === null) continue;
      lines.push(`file\0docs/requirements/${name}/${candidate}\0${digestOf(content)}`);
      break;
    }
    const specification = await readBytes(path.join(dir, "specification.md"));
    lines.push(`file\0docs/requirements/${name}/specification.md\0${digestOf(specification)}`);
  }
  return createHash("sha256").update([...lines].sort().join("\n")).digest("hex");
}

function idOrder(intent: Intent): number {
  const numeric = Number.parseInt(intent.id, 10);
  return Number.isNaN(numeric) ? Number.MAX_SAFE_INTEGER : numeric;
}

function compareIntents(a: Intent, b: Intent): number {
  if (a.source !== b.source) return a.source === "flow" ? -1 : 1;
  const byId = idOrder(a) - idOrder(b);
  if (byId !== 0) return byId;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function countsOf(intents: readonly Intent[]): IntentCounts {
  const closed = intents.filter((intent) => intent.status === "closed");
  const observed = closed.filter((intent) => intent.outcome.observed).length;
  const noCriterion = closed.filter((intent) => !intent.outcome.observed && !hasInstrument(intent.outcome.criterion)).length;
  return {
    intents: intents.length,
    flows: intents.filter((intent) => intent.source === "flow").length,
    docpacks: intents.filter((intent) => intent.source === "docpack").length,
    closed: closed.length,
    noCriterion,
    notObserved: closed.length - observed - noCriterion,
    observed,
  };
}

export async function buildIntentIndex(cwd: string): Promise<IntentIndex> {
  // Fingerprinted before any source is read: an edit made during the build then
  // reads as stale on the next `product open`, the safe direction.
  const fingerprint = await corpusFingerprint(cwd);
  const intents: Intent[] = [];
  const failures: string[] = [];

  for (const name of await listFlowPackages(cwd)) {
    const dir = path.join(flowsDir(cwd), name);
    const repoPath = `${FLOW_PREFIX}${name}`;
    try {
      const flowJson = await readSource(path.join(dir, "flow.json"), `${repoPath}/flow.json`);
      if (flowJson === null) {
        failures.push(`${repoPath}: no flow.json`);
        continue;
      }
      intents.push(
        extractFlowIntent(
          {
            flowJson,
            description: await readSource(path.join(dir, "description.md"), `${repoPath}/description.md`),
            criteria: await readSource(path.join(dir, "acceptance-criteria.md"), `${repoPath}/acceptance-criteria.md`),
            journal: await readSource(path.join(dir, "journal.md"), `${repoPath}/journal.md`),
          },
          repoPath,
        ),
      );
    } catch (error) {
      failures.push(error instanceof UnreadableSource ? error.message : `${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const name of await requirementPackages(cwd)) {
    const dir = path.join(requirementsDir(cwd), name);
    const repoPath = `docs/requirements/${name}`;
    try {
      let primary: string | null = null;
      for (const candidate of PRIMARY_DOCS) {
        primary = await readSource(path.join(dir, candidate), `${repoPath}/${candidate}`);
        if (primary !== null) break;
      }
      const specification = await readSource(path.join(dir, "specification.md"), `${repoPath}/specification.md`);
      intents.push(extractDocpackIntent({ name, primary, specification }, repoPath));
    } catch (error) {
      failures.push(error instanceof UnreadableSource ? error.message : `${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  intents.sort(compareIntents);
  return {
    schemaVersion: 1,
    fingerprint,
    intents,
    unusable: intents.filter((intent) => intent.statement === null).length,
    failures: [...failures].sort(),
    counts: countsOf(intents),
  };
}
