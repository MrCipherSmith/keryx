// Import-policy check (flow 239, AC-20 / AFC-20): does an entry module's real,
// bundler-resolved module graph reach a zone its own zone may not statically
// reach?
//
// WHY THE BUNDLER, NOT A TEXT SCAN
//
// `src/lib/production-graph.test.ts` already tried the alternative three times
// and lost every round: a regex over import text was defeated by `require()`,
// then by dynamic `import()`, then by a file extension; rewritten against the
// TypeScript AST it was then defeated by a concatenated specifier, a renamed
// `createRequire`, and a template literal with a substitution. Both versions
// were answering "does this file contain text/nodes that look like an import?"
// when the real question is "does the module graph actually reach this file?" —
// and that question has an authoritative answer that is not a heuristic: ask
// the bundler. This module asks the bundler, the same way, for the same reason.
//
// The three existing import guards (`src/mcp/boundary.test.ts`,
// `src/capability/no-optional-imports.test.ts`,
// `src/gdgraph/treesitter/no-treesitter-import.test.ts`) are text scans and
// stay that way here — narrowing them to the bundler technique is out of this
// module's scope — but this NEW check, built for a phase whose own criterion
// is "catches a forbidden fixture and passes an allowed one", does not repeat
// their approach.
//
// WHAT THIS PROVES, EXACTLY
//
// Reachability, not edges. `bun build`'s sourcemap `sources` name every module
// REACHED from an entry point; they do not say which module reached which. So
// a violation here means "some module in a zone `fromZone` may not reach is
// reachable from this entry", not "this specific file imports that specific
// file". For the entry points this check is given — the root of one fixture, or
// later a real zone's own entry — that is the property that matters: the
// question is "did the boundary hold end to end", not "which line crossed it".
//
// The one documented exception both directions honour: a client/adapter entry
// reaching a core zone's `service.ts` — the zone's declared public facade — is
// not a violation. Reaching any other core module is.
//
// THE HONEST LIMIT
//
// Same one `production-graph.test.ts` states for itself: a module reached at
// runtime by a PATH rather than by a resolvable specifier — `readFileSync` plus
// `eval`, or a specifier assembled from configuration — is outside any static
// analysis, bundler included.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { type ImportZone, zoneOf } from "./import-zones";

export interface ImportBoundaryViolation {
  /** Absolute path of the reachable module that violates the direction. */
  readonly source: string;
  readonly zone: ImportZone;
}

export interface ImportBoundaryResult {
  readonly entry: string;
  readonly entryZone: ImportZone | undefined;
  /** Every module the bundler reported reachable from `entry`, entry included. */
  readonly scanned: number;
  readonly violations: readonly ImportBoundaryViolation[];
}

/**
 * Core owners never reach a client or adapter zone — "Владельцы не
 * импортируют CLI/MCP/Shell" (specification.md §2). No exception: there is no
 * owner-side facade that makes reaching the client legitimate.
 *
 * Client and adapter code reaches a core zone ONLY through that zone's public
 * facade (a module literally named `service.ts`) — "клиент не импортирует
 * private core" (AFC-19). Reaching any other core module is a violation.
 */
function isViolation(fromZone: ImportZone, toZone: ImportZone, toBasename: string): boolean {
  if (fromZone === "core") {
    return toZone === "client" || toZone === "adapter";
  }
  if (fromZone === "client" || fromZone === "adapter") {
    return toZone === "core" && toBasename !== "service.ts";
  }
  return false;
}

/**
 * Sourcemap `sources` are relative to the outdir root, not to the map's own
 * directory — the same resolution `production-graph.test.ts` documents and
 * pins with a dedicated test. Duplicated here (rather than imported) because
 * that copy lives in a `.test.ts` file, which this module — real check logic,
 * not test scaffolding — does not import from.
 */
function resolveSources(outDir: string, sources: readonly string[]): string[] {
  return sources.map((source) => path.resolve(outDir, source));
}

/**
 * Build `entry` with the real bundler and report every reachable module whose
 * zone the entry's own zone may not statically reach.
 *
 * `root` is the directory the zone table is applied relative to — the real
 * `src/` for a live check, or a fixture directory laid out with the same
 * top-level zone names for a fixture check (see `import-policy.fixtures.test.ts`).
 */
export async function checkImportBoundary(options: {
  readonly entry: string;
  readonly root: string;
}): Promise<ImportBoundaryResult> {
  const { entry, root } = options;
  const entryZone = zoneOf(root, entry);
  const outDir = await mkdtemp(path.join(tmpdir(), "keryx-import-policy-"));
  try {
    const proc = Bun.spawn(
      ["bun", "build", entry, "--outdir", outDir, "--target", "bun", "--sourcemap=external"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exit = await proc.exited;
    if (exit !== 0) {
      throw new Error(`import-policy build of ${entry} failed (exit ${exit}): ${stderr.slice(0, 400)}`);
    }

    const maps = [...new Glob("**/*.js.map").scanSync(outDir)];
    if (maps.length === 0) {
      throw new Error(`import-policy build of ${entry} produced no sourcemap in ${outDir}`);
    }
    const sources = new Set<string>();
    for (const map of maps) {
      const parsed = JSON.parse(await Bun.file(path.join(outDir, map)).text()) as { sources: string[] };
      for (const resolved of resolveSources(outDir, parsed.sources)) {
        sources.add(resolved);
      }
    }

    const violations: ImportBoundaryViolation[] = [];
    if (entryZone !== undefined) {
      for (const source of sources) {
        const zone = zoneOf(root, source);
        if (zone === undefined) {
          continue;
        }
        if (isViolation(entryZone, zone, path.basename(source))) {
          violations.push({ source, zone });
        }
      }
    }

    return { entry, entryZone, scanned: sources.size, violations };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
