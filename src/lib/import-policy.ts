// Import-boundary check (flow 239, AC-20 / AFC-20): does a module import
// across a zone boundary its own zone may not cross?
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MEASURES, AND WHY IT CHANGED
// ─────────────────────────────────────────────────────────────────────────────
//
// It measures the DIRECT IMPORT GRAPH: one edge per import statement, with the
// specifier resolved to a real file. Not reachability.
//
// The first version of this module measured reachability instead — it built an
// entry with `bun build` and read the sourcemap's `sources`, the same technique
// `src/lib/production-graph.test.ts` and `src/sac/core-graph.test.ts` use. That
// choice was made for a good reason (a textual import scan had been defeated
// three times by respelling) and it was wrong anyway, for two reasons that a
// review reproduced:
//
//   1. IT ANSWERED A DIFFERENT QUESTION THAN THE POLICY ASKS. The policy is
//      about imports — "клиент не импортирует private core". A sourcemap's
//      `sources` is a transitive closure: reaching a facade also reaches
//      everything BEHIND that facade, so the facade exemption (which exempts
//      one basename, `service.ts`) could never apply to the facade's own
//      dependencies. The check was therefore structurally unable to pass on any
//      real entry. Measured before this rewrite:
//
//        mcp/server.ts        zone=adapter scanned=387 violations=141
//        commands/agent.ts    zone=adapter scanned= 73 violations=49
//        sac/service.ts       zone=core    scanned= 67 violations=5
//
//      The shipped "allowed" fixture passed only because its facade was a leaf
//      (`export const serve = "core-facade";`, no imports of its own). No real
//      facade is a leaf, so the fixture proved a property the real tree cannot
//      have.
//
//   2. TREE-SHAKING DELETED THE EVIDENCE. A bundle contains what SURVIVES, not
//      what was written. Three fixtures whose core entry literally contains
//      `import { CLIENT } from "../harness/leaf"` all reported violations=0
//      under the old check: the binding imported but never used, the binding
//      used only inside `if (false)`, and the import routed through a
//      re-export barrel. A plainly written forbidden import passed.
//
// So the textual approach was defeated by RESPELLING and the build approach by
// TREE-SHAKING, and — this is the load-bearing part — the shapes they miss are
// different, not nested. The resolution is not to pick the less-bad one. It is
// to use a real parser (which respelling cannot fool the way a regex can) over
// direct edges (which tree-shaking cannot erase, because an edge is recorded
// before anything is optimised away), and then to keep the bundler as a
// SECOND, DIFFERENT signal aimed at the first one's actual blind spot.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PARSER, AND WHAT IT SEES — MEASURED, NOT ASSUMED
// ─────────────────────────────────────────────────────────────────────────────
//
// Edges come from `Bun.Transpiler.scanImports`, Bun's own parser — the same
// parser that resolves the code for real, not a regex and not a second AST
// implementation that can drift from it. Every shape below was measured
// against it while writing this module, and is pinned by
// `import-policy.test.ts` so the list stays true:
//
//   SEEN    import statement, unused binding, binding used only under
//           `if (false)`, re-export barrel hop, `export { x } from`,
//           `export * from`, side-effect-only `import "…"`,
//           `import { type A, B }` (the value half keeps the edge alive),
//           dynamic `import()` with a literal specifier, `require()` with a
//           literal specifier.
//
//   UNSEEN  `import type { A } from "…"` — erased by TypeScript before the
//           parser reports anything, so a type-only edge is invisible to this
//           check AND to the bundler. See THE HONEST LIMITS below.
//
//   UNSEEN  a computed specifier: `"../har" + "ness/leaf"`, a template literal
//           with a substitution, a renamed `createRequire`. Outside static
//           analysis, bundler included.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE BUNDLER IS STILL FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// `reachableModules()` remains, and `resolutionGaps()` uses it — but as a
// COVERAGE CROSS-CHECK on this module's own resolver, never as a violation
// verdict. The question it answers is: "did the real bundler reach a module
// that my direct scan never named?" A module in that gap was reached by a
// specifier `resolveSpecifier()` could not follow — a computed specifier, an
// extension or index-file convention this resolver does not implement, a path
// alias someone adds to `tsconfig.json` later. That is precisely where a static
// scan silently under-reports, and it is worth a different tool's opinion.
//
// This inverts the old relationship honestly: the bundler is no longer asked
// the policy question it cannot answer, and is instead asked the one question
// where its independence is the whole point.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HONEST LIMITS
// ─────────────────────────────────────────────────────────────────────────────
//
// The previous version of this comment named exactly one limit: "a module
// reached at runtime by a PATH rather than by a resolvable specifier". That
// limit is real and still applies, but it was not the one that actually bit.
// The limits that bite, stated in the order they matter:
//
//   1. TYPE-ONLY IMPORTS ARE INVISIBLE. `import type { X } from "../harness/x"`
//      is erased at compile time. It creates no runtime edge, so neither this
//      parser nor the bundler reports it. Whether a type-only reference across
//      a zone boundary is a policy violation at all is a genuine question —
//      it couples the two zones at compile time and not at runtime — and this
//      module does not answer it: it reports what it can see and says here,
//      plainly, that this is not it. A guard that needs type-level coupling
//      enforced needs the TypeScript compiler API, not this module.
//
//   2. COMPUTED SPECIFIERS ARE INVISIBLE, to every static tool. `resolutionGaps()`
//      narrows this rather than closing it: a computed specifier the BUNDLER
//      can nonetheless follow shows up as a gap; one neither can follow does
//      not.
//
//   3. RESOLUTION IS RELATIVE-SPECIFIER ONLY. `resolveSpecifier()` follows
//      `./` and `../` with the extension and index-file candidates this
//      repository actually uses, and deliberately does not implement bare
//      specifiers (a bare specifier leaves `src/` and so leaves the policy's
//      scope) or `tsconfig` path aliases (this repository declares none —
//      `moduleResolution: "Bundler"` with no `paths`). Both facts are pinned:
//      an unfollowed RELATIVE specifier is reported as an
//      `unresolved-relative-specifier` finding rather than dropped, and
//      `resolutionGaps()` catches an alias arriving later.

import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { type ImportZone, zoneOf } from "./import-zones";

// ── Model ────────────────────────────────────────────────────────────────────

/** One resolved import edge: `from` contains an import that resolves to `to`. */
export interface ImportEdge {
  readonly from: string;
  readonly to: string;
  /** The specifier as written, e.g. `"../harness/leaf"`. */
  readonly specifier: string;
  /** `Bun.Transpiler`'s kind: `import-statement`, `dynamic-import`, `require-call`. */
  readonly kind: string;
  readonly fromZone: ImportZone | undefined;
  readonly toZone: ImportZone | undefined;
}

export type ImportFindingKind =
  /**
   * A core owner importing a client or adapter module. "Владельцы не
   * импортируют CLI/MCP/Shell" (`specification.md` §2). NO exception exists in
   * either direction of the spec: there is no owner-side facade that makes
   * reaching the client legitimate.
   */
  | "owner-imports-client"
  /**
   * A client or adapter importing a core module that is not that owner's
   * public `service.ts` facade — "клиент не импортирует private core"
   * (AFC-19).
   *
   * Read `INTRA_REPO_FACADE_RULE_IS_ADVISORY` before treating this as a defect.
   */
  | "client-imports-core-internal"
  /**
   * A file whose top-level segment `ZONE_TABLE` does not name. Raised as a
   * FINDING and never skipped: "I do not know what zone this is" must not be
   * reported the same way as "there is nothing wrong here".
   */
  | "unclassified-zone"
  /** A relative specifier this module's resolver could not follow to a file. */
  | "unresolved-relative-specifier";

export interface ImportFinding {
  readonly kind: ImportFindingKind;
  /** The file that contains the import, or the unclassified file itself. */
  readonly from: string;
  /** The resolved target, when there is one. */
  readonly to?: string;
  readonly specifier?: string;
  readonly fromZone?: ImportZone | undefined;
  readonly toZone?: ImportZone | undefined;
}

export interface ImportPolicyReport {
  readonly root: string;
  /** Files actually parsed. Zero is an error condition, not a pass — see below. */
  readonly scanned: number;
  readonly edges: readonly ImportEdge[];
  readonly findings: readonly ImportFinding[];
}

/**
 * WHY `client-imports-core-internal` IS REPORTED BUT NOT ENFORCED AT ZERO
 * INSIDE THIS REPOSITORY.
 *
 * Measured on the real tree, by direct edges: `src/commands` 168,
 * `src/harness` 26, `src/session` 8, `src/tui` 4, `src/mcp` 3, `src/cli.ts` 1 —
 * 210 in total. (A snapshot: other lanes are landing files in this tree
 * continuously, and the count moved from 208 to 210 during the hour this was
 * written. `import-policy.live.test.ts` ratchets it rather than pinning it, for
 * exactly that reason.) Those are not 210 defects, and "fix the call sites" is
 * the wrong response. Three measured facts establish why.
 *
 * FIRST — THE RULE IS UNSATISFIABLE FOR A THIRD OF THE CORE ZONES. Of the 15
 * core directories in `ZONE_TABLE`, five have no `service.ts` at all:
 * `src/ctx`, `src/gdskills`, `src/metrics`, `src/review`, `src/capability`.
 * `src/commands` imports `src/ctx/orient.ts` and `src/ctx/runtimes.ts` because
 * there is no other door — and `src/core.ts` states this in its own header:
 * "src/ctx/ has no service.ts yet and so has no door here". A rule whose only
 * permitted route does not exist cannot be obeyed, and a check that fails on
 * disobeying it is measuring the rule's gap, not the code's.
 *
 * SECOND — THE FACADE RULE IS THE PUBLISHED-PACKAGE RULE, AND IT IS ALREADY
 * ENFORCED, MORE STRICTLY. `package.json`'s exports map is
 * `{".": "./dist/core.js", "./package.json": "./package.json"}`. An external
 * consumer cannot deep-import ANY internal module — not `wiki/collect.ts` and
 * not `wiki/service.ts` either. The facade discipline the rule describes is a
 * property of the PUBLISHED SURFACE, it is enforced by that exports map plus
 * `src/core-package.test.ts` (which uses reachability, correctly, because for
 * a packaging question reachability genuinely IS the question), and
 * `src/commands` is not an external consumer of the package — it is inside it.
 * Applying the published-package rule to intra-repository edges was a category
 * error, and the 210 findings are that error's shadow, not defects.
 *
 * THIRD — THE OTHER DIRECTION IS ALREADY NEARLY CLEAN, WHICH SHOWS THE
 * DIFFERENCE IS REAL AND NOT AN EXCUSE. `owner-imports-client` — the rule the
 * spec states with no exception — has 22 direct edges (21 distinct pairs)
 * across 6 files, not 210, and 12 of those are an exception two other guards
 * already document by name. If both rules were equally miscalibrated, both
 * counts would be large. They are not.
 *
 * So this module keeps MEASURING the facade rule (an owner that DOES have a
 * facade gaining a new bypass is worth seeing, and the count must never be
 * allowed to grow silently) and stops FAILING on it, while
 * `owner-imports-client` is enforced against a named, shrinking allowlist. The
 * enforcement split lives in `import-policy.live.test.ts`, not here: this
 * module measures, the guard decides tolerance.
 */
export const INTRA_REPO_FACADE_RULE_IS_ADVISORY = true;

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Candidate suffixes, in the order a bundler tries them. `""` first so an
 * explicit `../x.ts` wins over a sibling directory's `../x/index.ts`.
 */
const RESOLUTION_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.tsx"] as const;

/** Is `candidate` inside `root`? Compared on path segments, not on a prefix. */
function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a RELATIVE specifier written in `fromFile` to an absolute file path.
 *
 * Returns `undefined` for a bare specifier (deliberately out of scope: it
 * leaves `src/`) and for a relative specifier that matches no file (reported as
 * an `unresolved-relative-specifier` finding rather than dropped).
 */
export function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const suffix of RESOLUTION_CANDIDATES) {
    const candidate = base + suffix;
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * One transpiler per loader, chosen by extension.
 *
 * The `tsx` loader must NOT be used for `.ts`: it reads `async <T>(x: T) => …`
 * as a JSX element and throws. That is not a hypothetical — it threw on
 * `src/tui/` the first time this scan was pointed at the real tree. Getting
 * this wrong is loud rather than silent, which is the only reason it was caught
 * by running the scan instead of by reasoning about it.
 */
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
} as const;

/**
 * Parse `code` from `file`, naming the file if the parse fails.
 *
 * A file the scan cannot parse is a file the scan cannot make a claim about, so
 * this throws rather than skipping: an unparseable module silently contributing
 * zero edges would be the same "silence reads as a pass" defect this rewrite
 * exists to remove, one level down.
 */
function scanImports(file: string, code: string): { readonly path: string; readonly kind: string }[] {
  const transpiler = file.endsWith(".tsx") ? TRANSPILERS.tsx : TRANSPILERS.ts;
  try {
    return transpiler.scanImports(code);
  } catch (cause) {
    throw new Error(`import-policy could not parse ${file}: ${String(cause)}`, { cause });
  }
}

/**
 * Blank a leading `#!` line, preserving the line itself so every reported
 * position downstream still matches the file on disk.
 */
export function stripShebang(code: string): string {
  return code.startsWith("#!") ? code.replace(/^#![^\n]*/, "//") : code;
}

/** Every non-test TypeScript module under `root`, absolute, sorted. */
export function listSourceFiles(root: string): string[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync(root)]
    .filter((rel) => !/\.(test|smoke|bench)\.tsx?$/.test(rel) && !rel.endsWith(".d.ts"))
    .map((rel) => path.join(root, rel))
    .sort();
}

// ── The check ────────────────────────────────────────────────────────────────

/**
 * A core owner never imports a client or adapter module — no exception.
 *
 * A client or adapter imports a core module only through that owner's public
 * facade (a module literally named `service.ts`). Measured, not failed, inside
 * this repository — see `INTRA_REPO_FACADE_RULE_IS_ADVISORY`.
 */
function findingFor(edge: ImportEdge): ImportFindingKind | undefined {
  const { fromZone, toZone } = edge;
  if (fromZone === undefined || toZone === undefined) {
    // Surfaced separately, per file, by `checkImportPolicy` — never silently
    // treated as "no violation here".
    return undefined;
  }
  if (fromZone === "core" && (toZone === "client" || toZone === "adapter")) {
    return "owner-imports-client";
  }
  if ((fromZone === "client" || fromZone === "adapter") && toZone === "core") {
    return path.basename(edge.to) === "service.ts" ? undefined : "client-imports-core-internal";
  }
  return undefined;
}

/**
 * Parse `files`, resolve their imports, and report every edge plus every
 * finding.
 *
 * Throws when `files` is empty. An empty scan is the failure mode this whole
 * programme keeps rediscovering: a guard pointed at nothing reports nothing
 * wrong, and "no findings" from zero files is indistinguishable from "no
 * findings" from a clean tree. `import-policy.test.ts` points this function at
 * an empty directory and asserts it throws.
 */
export async function checkImportPolicy(options: {
  readonly root: string;
  readonly files?: readonly string[];
}): Promise<ImportPolicyReport> {
  const { root } = options;
  const files = options.files ?? listSourceFiles(root);
  if (files.length === 0) {
    throw new Error(
      `import-policy: nothing to scan under ${root}. A scan of zero files cannot produce a finding, so its silence would be indistinguishable from a clean result.`,
    );
  }

  const edges: ImportEdge[] = [];
  const findings: ImportFinding[] = [];

  for (const file of files) {
    const fromZone = zoneOf(root, file);
    if (fromZone === undefined) {
      findings.push({ kind: "unclassified-zone", from: file, fromZone: undefined });
    }
    // `Bun.Transpiler` rejects a shebang outright ("Unexpected #!/usr/bin/env
    // bun"), and `src/cli.ts` — the CLI entry, an adapter and therefore one of
    // the most policy-relevant files in the tree — has one. Blanking the line
    // rather than removing it keeps every subsequent line number intact.
    const code = stripShebang(await Bun.file(file).text());
    for (const imported of scanImports(file, code)) {
      const specifier = imported.path;
      const to = resolveSpecifier(file, specifier);
      if (to === undefined) {
        if (specifier.startsWith(".")) {
          findings.push({ kind: "unresolved-relative-specifier", from: file, specifier, fromZone });
        }
        continue;
      }
      if (!isUnder(root, to)) {
        // A relative specifier that climbs OUT of the root — in this repository,
        // six modules importing `../../package.json` for the version string.
        // Out of the policy's scope for the same reason a bare specifier is: the
        // policy governs direction BETWEEN zones, and a file with no zone
        // because it is not in the tree at all is not a zone this can be wrong
        // about. Excluded deliberately and pinned by a test, rather than left to
        // surface as six permanent `unclassified-zone` findings that would train
        // a reader to ignore that finding kind — which is the failure mode a
        // guard nobody trusts always starts with.
        continue;
      }
      const toZone = zoneOf(root, to);
      const edge: ImportEdge = { from: file, to, specifier, kind: imported.kind, fromZone, toZone };
      edges.push(edge);
      if (toZone === undefined) {
        findings.push({ kind: "unclassified-zone", from: file, to, specifier, fromZone, toZone: undefined });
      }
      const kind = findingFor(edge);
      if (kind !== undefined) {
        findings.push({ kind, from: file, to, specifier, fromZone, toZone });
      }
    }
  }

  return { root, scanned: files.length, edges, findings };
}

// ── The bundler, as a coverage cross-check ───────────────────────────────────

/**
 * Sourcemap `sources` are relative to the outdir root, not to the map's own
 * directory — the same resolution `production-graph.test.ts` documents and pins
 * with a dedicated test. Duplicated here (rather than imported) because that
 * copy lives in a `.test.ts` file, which this module — real check logic, not
 * test scaffolding — does not import from.
 */
function resolveSources(outDir: string, sources: readonly string[]): string[] {
  return sources.map((source) => path.resolve(outDir, source));
}

/**
 * Every module the real bundler reaches from `entry`, entry included.
 *
 * This is REACHABILITY, and its name says so. It is not a policy verdict and
 * must not be used as one: reaching a facade also reaches everything behind
 * that facade, which is exactly why the previous version of this module could
 * not pass on real source. Its one job here is to give `resolutionGaps()` a
 * second, independent opinion about which files are in the graph at all.
 */
export async function reachableModules(options: {
  readonly entry: string;
  readonly root: string;
}): Promise<string[]> {
  const { entry, root } = options;
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
    const modules = new Set<string>();
    for (const map of maps) {
      const parsed = JSON.parse(await Bun.file(path.join(outDir, map)).text()) as { sources: string[] };
      for (const resolved of resolveSources(outDir, parsed.sources)) {
        modules.add(resolved);
      }
    }
    return [...modules].sort();
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/**
 * Modules the bundler reached from `entry` that the direct scan's edges never
 * named — this module's resolver blind spot, made visible by a different tool.
 *
 * A non-empty result does NOT mean a policy violation. It means the direct
 * graph is incomplete there, and the reason is worth knowing: a computed
 * specifier, a resolution convention `resolveSpecifier()` does not implement,
 * or a `tsconfig` path alias added after this was written.
 *
 * Only modules under `root` are considered — a reached `node_modules` file is
 * outside the policy's scope, not a gap in it.
 */
export async function resolutionGaps(options: {
  readonly entry: string;
  readonly root: string;
  readonly edges: readonly ImportEdge[];
}): Promise<string[]> {
  const { entry, root, edges } = options;
  const named = new Set<string>([entry]);
  for (const edge of edges) {
    named.add(edge.from);
    named.add(edge.to);
  }
  const reached = await reachableModules({ entry, root });
  return reached.filter((module) => module.startsWith(root) && !named.has(module)).sort();
}
