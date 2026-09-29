// Read the flow and requirements corpus of one project into an IntentIndex.
// Read-only: it opens files under `.metaproject/flows/` and `docs/requirements/`
// and writes nothing. The result is deterministic — ordered, and free of any
// clock — so a second run over an unchanged tree is byte-identical.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractDocpackIntent, extractFlowIntent, hasInstrument } from "./extract";
import type { Intent, IntentCounts, IntentIndex } from "./types";

const PRIMARY_DOCS = ["prd.md", "PRD.md", "trd.md", "TRD.md", "README.md"];

export function flowsDir(cwd: string): string {
  return path.join(cwd, ".metaproject", "flows");
}

export function requirementsDir(cwd: string): string {
  return path.join(cwd, "docs", "requirements");
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
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
  const intents: Intent[] = [];
  const failures: string[] = [];

  for (const name of await listFlowPackages(cwd)) {
    const dir = path.join(flowsDir(cwd), name);
    const repoPath = `.metaproject/flows/${name}`;
    const flowJson = await readOptional(path.join(dir, "flow.json"));
    if (flowJson === null) {
      failures.push(`${repoPath}: no flow.json`);
      continue;
    }
    try {
      const intent = extractFlowIntent(
        {
          flowJson,
          description: await readOptional(path.join(dir, "description.md")),
          criteria: await readOptional(path.join(dir, "acceptance-criteria.md")),
          journal: await readOptional(path.join(dir, "journal.md")),
        },
        repoPath,
      );
      intents.push(intent);
    } catch (error) {
      failures.push(`${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const name of await subdirectories(requirementsDir(cwd), (entry) => !entry.startsWith("_") && !entry.startsWith("."))) {
    const dir = path.join(requirementsDir(cwd), name);
    let primary: string | null = null;
    for (const candidate of PRIMARY_DOCS) {
      primary = await readOptional(path.join(dir, candidate));
      if (primary !== null) break;
    }
    intents.push(
      extractDocpackIntent(
        { name, primary, specification: await readOptional(path.join(dir, "specification.md")) },
        `docs/requirements/${name}`,
      ),
    );
  }

  intents.sort(compareIntents);
  return {
    schemaVersion: 1,
    intents,
    unusable: intents.filter((intent) => intent.statement === null).length,
    failures: [...failures].sort(),
    counts: countsOf(intents),
  };
}
