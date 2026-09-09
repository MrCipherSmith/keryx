// Before/after inventory for the pre-run preparation state (AC7 / AC-M07,
// metrics-and-validation.md §"M06/M07" ¶4):
//
//   "Inventory до/после фиксирует graph readable schema/snapshot, control query
//    с известным expected shape, build revision/freshness/capability; пустая
//    директория `data/gdgraph` не проходит. Wiki inventory различает accepted
//    substantive/scaffold/reference/draft и retrievable section coverage.
//    SAC/orient включение фиксируется, не выводится из числа файлов.
//    Неполная подготовка → INCOMPLETE, не нулевой recall."
//
// The defect this module exists to close is the one the phase-6 inventory named
// directly: today an unbuilt graph produces an *empty answer*, not a refusal. A
// measurement taken against an empty graph is not a low score, it is not a
// measurement at all — and every layer downstream of it renders it as a number.
// So the graph inventory's job is to turn "there is nothing here" into a status
// a caller cannot read as data.
//
// Two design rules run through the whole file, both learned from guards in this
// repository that passed while pointed at nothing:
//
//  1. Absence is never success. `collectGraphInventory` on a missing directory
//     is `empty`, not `ready`; `checkOperatorMemory` with no candidate paths is
//     `unverified`, not `absent`. A check with nothing to look at has not run.
//  2. A rate with no denominator is not zero. Wiki section coverage goes
//     through `deriveRate`, so a wiki with no sections yields an `UnmeasuredRate`
//     whose `rate` is `null` — arithmetic on it is a compile error rather than a
//     confident 0%.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { deriveRate, type RateWithCI } from "./benchmark";
import type { Reliability } from "./types";

// ---------------------------------------------------------------------------
// Graph inventory
// ---------------------------------------------------------------------------

/**
 * `ready` is the only status a run may proceed from, and it is deliberately the
 * hardest to reach: every artifact must be present, parseable and shaped.
 *
 * - `empty`      — nothing to measure against (the norm's "пустая директория ... не проходит").
 * - `corrupt`    — artifacts exist but are unparseable, partial, or undateable.
 * - `unreadable` — the filesystem refused; distinct from `empty` because "I could
 *                  not look" must never collapse into "I looked and found nothing".
 */
export type GraphInventoryStatus = "ready" | "empty" | "corrupt" | "unreadable";

/** A path that a correctly built graph MUST carry as a node. */
export type ControlQueryProbe = {
  readonly nodePath: string;
};

/**
 * The norm's "control query с известным expected shape". Presence of files is not
 * evidence that the graph *answers*; this runs one query whose correct answer is
 * known in advance and checks the record's shape, not merely its existence.
 */
export type ControlQueryResult = {
  readonly probe: string;
  readonly found: boolean;
  readonly shapeOk: boolean;
  readonly problem: string | null;
};

export type GraphInventory = {
  readonly status: GraphInventoryStatus;
  readonly dir: string;
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly schemaVersion: number | null;
  /** Build revision — which commit this graph actually describes. */
  readonly buildCommit: string | null;
  /** Build freshness — when it was built. `null` means the build cannot be dated. */
  readonly builtAt: string | null;
  readonly controlQuery: ControlQueryResult | null;
  readonly problems: readonly string[];
};

const NODE_REQUIRED_FIELDS = ["id", "kind", "path"] as const;

/**
 * Inspect a `data/gdgraph` directory and report what a run would actually be
 * measuring against. Pure read; never builds, never repairs.
 */
export function collectGraphInventory(gdgraphDir: string, probe: ControlQueryProbe): GraphInventory {
  const base: Omit<GraphInventory, "status" | "problems"> = {
    dir: gdgraphDir,
    nodeCount: null,
    edgeCount: null,
    schemaVersion: null,
    buildCommit: null,
    builtAt: null,
    controlQuery: null,
  };

  if (!existsSync(gdgraphDir)) {
    return { ...base, status: "empty", problems: [`graph directory does not exist: ${gdgraphDir}`] };
  }

  let isDir: boolean;
  try {
    isDir = statSync(gdgraphDir).isDirectory();
  } catch (error) {
    return { ...base, status: "unreadable", problems: [`graph directory is unreadable: ${describeError(error)}`] };
  }
  if (!isDir) {
    return { ...base, status: "unreadable", problems: [`graph path is not a directory: ${gdgraphDir}`] };
  }

  const storageDir = path.join(gdgraphDir, "storage");
  const nodesPath = path.join(storageDir, "nodes.jsonl");
  if (!existsSync(nodesPath)) {
    return { ...base, status: "empty", problems: [`no node store at ${nodesPath}`] };
  }

  let nodesRaw: string;
  try {
    nodesRaw = readFileSync(nodesPath, "utf8");
  } catch (error) {
    return { ...base, status: "unreadable", problems: [`node store is unreadable: ${describeError(error)}`] };
  }

  const nodeLines = nodesRaw.split("\n").filter((line) => line.trim().length > 0);
  if (nodeLines.length === 0) {
    return { ...base, status: "empty", problems: [`node store is empty: ${nodesPath}`] };
  }

  const problems: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const [index, line] of nodeLines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      problems.push(`nodes.jsonl line ${index + 1} is not valid JSON`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      problems.push(`nodes.jsonl line ${index + 1} is not a record`);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const missing = NODE_REQUIRED_FIELDS.filter((field) => typeof record[field] !== "string");
    if (missing.length > 0) {
      problems.push(`nodes.jsonl line ${index + 1} is missing ${missing.join(", ")}`);
      continue;
    }
    nodes.push(record);
  }

  const edgesPath = path.join(storageDir, "edges.jsonl");
  let edgeCount: number | null = null;
  if (!existsSync(edgesPath)) {
    problems.push(`no edge store at ${edgesPath}: the build is partial`);
  } else {
    try {
      edgeCount = readFileSync(edgesPath, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
    } catch (error) {
      problems.push(`edge store is unreadable: ${describeError(error)}`);
    }
  }

  const manifest = readJsonRecord(path.join(storageDir, "build-manifest.json"));
  if (!manifest.ok) problems.push(`build manifest: ${manifest.problem}`);
  const schemaVersion = manifest.ok && typeof manifest.value.version === "number" ? manifest.value.version : null;
  if (manifest.ok && schemaVersion === null) problems.push("build manifest carries no schema version");

  const provenance = readJsonRecord(path.join(gdgraphDir, ".provenance.json"));
  if (!provenance.ok) problems.push(`build provenance: ${provenance.problem}`);
  const buildCommit = provenance.ok && typeof provenance.value.commit === "string" ? provenance.value.commit : null;
  const builtAt = provenance.ok && typeof provenance.value.builtAt === "string" ? provenance.value.builtAt : null;
  if (provenance.ok && buildCommit === null) problems.push("build provenance carries no build revision");
  if (provenance.ok && builtAt === null) problems.push("build provenance carries no build timestamp");

  const controlQuery = runControlQuery(nodes, probe);

  const status: GraphInventoryStatus = problems.length > 0 ? "corrupt" : "ready";
  return {
    dir: gdgraphDir,
    status,
    nodeCount: nodes.length,
    edgeCount,
    schemaVersion,
    buildCommit,
    builtAt,
    controlQuery,
    problems,
  };
}

function runControlQuery(nodes: readonly Record<string, unknown>[], probe: ControlQueryProbe): ControlQueryResult {
  const hit = nodes.find((node) => node["path"] === probe.nodePath);
  if (!hit) {
    return {
      probe: probe.nodePath,
      found: false,
      shapeOk: false,
      problem: `control query returned no node for ${probe.nodePath}`,
    };
  }
  const missing = NODE_REQUIRED_FIELDS.filter((field) => typeof hit[field] !== "string");
  return {
    probe: probe.nodePath,
    found: true,
    shapeOk: missing.length === 0,
    problem: missing.length === 0 ? null : `control query answer is missing ${missing.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Wiki inventory
// ---------------------------------------------------------------------------

/**
 * The norm requires these four to be *distinguished*, because a wiki of
 * scaffold and reference stubs looks, by file count, exactly like a wiki of
 * substantive accepted pages — and only the latter can carry a measurement.
 */
export type WikiPageClass = "substantive" | "scaffold" | "reference" | "draft";

export type WikiPageRecord = {
  readonly id: string;
  readonly pageClass: WikiPageClass;
  readonly accepted: boolean;
  readonly sections: readonly string[];
  /** Sections a retrieval call can actually return. Must be a subset of `sections`. */
  readonly retrievableSections: readonly string[];
};

export type WikiInventory = {
  readonly pages: readonly WikiPageRecord[];
  readonly acceptedSubstantive: number;
  readonly byClass: Readonly<Record<WikiPageClass, number>>;
  /**
   * Retrievable sections over total sections. A `RateWithCI`, so a wiki with no
   * sections is structurally unmeasurable rather than 0% coverage.
   */
  readonly sectionCoverage: RateWithCI;
  readonly problems: readonly string[];
};

const WIKI_CLASSES: readonly WikiPageClass[] = ["substantive", "scaffold", "reference", "draft"];

export function summarizeWikiInventory(
  pages: readonly WikiPageRecord[],
  reliability: Reliability = "exact",
): WikiInventory {
  const byClass: Record<WikiPageClass, number> = { substantive: 0, scaffold: 0, reference: 0, draft: 0 };
  const problems: string[] = [];
  let sections = 0;
  let retrievable = 0;

  for (const page of pages) {
    if (!WIKI_CLASSES.includes(page.pageClass)) {
      problems.push(`page ${page.id} carries an unknown class`);
      continue;
    }
    byClass[page.pageClass] += 1;
    sections += page.sections.length;
    const known = new Set(page.sections);
    const stray = page.retrievableSections.filter((section) => !known.has(section));
    if (stray.length > 0) problems.push(`page ${page.id} claims retrievable sections it does not have: ${stray.join(", ")}`);
    retrievable += page.retrievableSections.filter((section) => known.has(section)).length;
  }

  return {
    pages,
    acceptedSubstantive: pages.filter((page) => page.accepted && page.pageClass === "substantive").length,
    byClass,
    sectionCoverage: deriveRate(retrievable, sections, reliability),
    problems,
  };
}

// ---------------------------------------------------------------------------
// Capability inclusion, recorded rather than inferred
// ---------------------------------------------------------------------------

/**
 * "SAC/orient включение фиксируется, не выводится из числа файлов." `unrecorded`
 * is a real, blocking third state: nobody wrote down whether the arm included
 * these capabilities, and inferring it from what happens to be on disk is the
 * exact mistake the norm forbids.
 */
export type CapabilityFlag = "included" | "excluded" | "unrecorded";

export type CapabilityInclusion = {
  readonly sac: CapabilityFlag;
  readonly orient: CapabilityFlag;
};

// ---------------------------------------------------------------------------
// Operator memory
// ---------------------------------------------------------------------------

/**
 * "отсутствие памяти оператора" — an arm that can read notes a previous operator
 * left behind is not measuring the system, it is measuring the notes.
 *
 * `unverified` when there is nothing to look for: a check handed an empty list of
 * candidate paths reports every root clean, which is precisely the shape of guard
 * this repository has already shipped three of.
 */
export type OperatorMemoryReport = {
  readonly status: "absent" | "present" | "unverified";
  readonly paths: readonly string[];
};

export function checkOperatorMemory(
  agentRoot: string,
  candidateRelPaths: readonly string[],
): OperatorMemoryReport {
  if (candidateRelPaths.length === 0) {
    return { status: "unverified", paths: [] };
  }
  if (!existsSync(agentRoot)) {
    return { status: "unverified", paths: [] };
  }
  const found = candidateRelPaths.filter((rel) => existsSync(path.join(agentRoot, rel)));
  return { status: found.length > 0 ? "present" : "absent", paths: found };
}

// ---------------------------------------------------------------------------
// Before/after comparison
// ---------------------------------------------------------------------------

export type InventoryDrift = {
  readonly stable: boolean;
  readonly changes: readonly string[];
};

/**
 * The "до/после" half. A graph that was rebuilt, grew, shrank, or changed
 * revision *during* a run invalidates every pair measured across that boundary,
 * because the two arms no longer saw the same system.
 */
export function compareGraphInventories(before: GraphInventory, after: GraphInventory): InventoryDrift {
  const changes: string[] = [];
  const note = (field: string, a: unknown, b: unknown): void => {
    if (a !== b) changes.push(`${field}: ${String(a)} -> ${String(b)}`);
  };
  note("status", before.status, after.status);
  note("nodeCount", before.nodeCount, after.nodeCount);
  note("edgeCount", before.edgeCount, after.edgeCount);
  note("schemaVersion", before.schemaVersion, after.schemaVersion);
  note("buildCommit", before.buildCommit, after.buildCommit);
  note("builtAt", before.builtAt, after.builtAt);
  return { stable: changes.length === 0, changes };
}

// ---------------------------------------------------------------------------

type JsonRecordRead =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly problem: string };

function readJsonRecord(filePath: string): JsonRecordRead {
  if (!existsSync(filePath)) return { ok: false, problem: `missing at ${filePath}` };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, problem: `unreadable: ${describeError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: `not valid JSON at ${filePath}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: `not a JSON object at ${filePath}` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
