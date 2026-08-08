import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { moduleSpecifiers, parse, walk } from "../../../lib/config-dir.ast";
import {
  LANDLOCK_FS_ACCESS_BIT,
  LANDLOCK_FS_ACCESS_MIN_ABI,
  LANDLOCK_RESIDUAL_ACTIONS,
  buildLandlockRuleset,
  landlockFsMask,
} from "./landlock";
import type {
  LandlockInexpressible,
  LandlockInexpressibleCode,
  LandlockPathRule,
  LandlockRuleset,
} from "./landlock";
import { defaultSandboxProfile } from "./profile";
import type { SandboxProfile } from "./profile";

/** ABI 4 is what the ADR-0010 reference host (Ubuntu 24.04, 6.8) reports. */
const ABI_CURRENT = 4;

/** An expressible profile: workspace-write, network on, nothing read-denied. */
const expressible: SandboxProfile = {
  mode: "workspace-write",
  network: "on",
  writableRoots: ["/work/repo", "/tmp/session"],
  readDenyList: [],
  allowedDomains: [],
  required: true,
};

/** Every profile shape that can yield a ruleset — the AC3 guards run over all. */
const expressibleShapes: readonly SandboxProfile[] = [
  expressible,
  { ...expressible, writableRoots: [] },
  { ...expressible, writableRoots: ["/work/repo", "/work/repo"] },
  { ...expressible, mode: "read-only", writableRoots: [] },
  { ...expressible, mode: "read-only", writableRoots: ["/work/repo"] },
  { ...expressible, required: false },
  { ...expressible, proxy: { host: "127.0.0.1", port: 8080 } },
];

/** The failure codes of a translation, or `null` when it succeeded. */
function codes(profile: SandboxProfile, abi = ABI_CURRENT): LandlockInexpressibleCode[] | null {
  const result = buildLandlockRuleset(profile, abi);
  return result.ok ? null : result.failures.map((f) => f.code);
}

/** The failures of a translation; fails the test if it produced a ruleset. */
function failuresOf(profile: SandboxProfile, abi = ABI_CURRENT): readonly LandlockInexpressible[] {
  const result = buildLandlockRuleset(profile, abi);
  if (result.ok) {
    throw new Error("expected an inexpressible profile, but a ruleset was returned");
  }
  return result.failures;
}

/** The ruleset of a translation; fails the test if it was inexpressible. */
function rulesetOf(profile: SandboxProfile, abi = ABI_CURRENT): LandlockRuleset {
  const result = buildLandlockRuleset(profile, abi);
  if (!result.ok) {
    throw new Error(
      `expected an expressible profile, got: ${result.failures.map((f) => f.code).join(", ")}`,
    );
  }
  return result.ruleset;
}

// --- source-guard helpers, used by the AC1 purity test -----------------------
//
// Extracted so each predicate can be reasoned about — and mutated against — on
// its own. The single 155-line body they came from shared one findings array,
// so a failure could not say which of its four checks had fired.

/**
 * True when an identifier sits in a position the compiler erases.
 *
 * `readonly at: Date` and `function f(d: Date)` reach nothing at run time, and a
 * guard that cries wolf on them is one someone deletes. But `class X extends
 * expr` RUNS, and its `expr` is an `ExpressionWithTypeArguments` — the one node
 * `ts.isTypeNode` calls a type while it still carries a live expression. A
 * previous version skipped it, and `class B extends globalThis.Object` went
 * green. `implements`, and `interface X extends Y`, really are erased and stay
 * skipped.
 */
function isErasedTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (isClassExtendsExpression(current)) {
      return false;
    }
    if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current)) {
      return true;
    }
    if (ts.isSourceFile(current)) {
      return false;
    }
  }
  return false;
}

function isClassExtendsExpression(node: ts.Node): boolean {
  return (
    ts.isExpressionWithTypeArguments(node) &&
    node.parent !== undefined &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    node.parent.parent !== undefined &&
    ts.isClassLike(node.parent.parent)
  );
}

/**
 * True when an identifier is the NAME of whatever declares it, rather than a
 * read of a value by that name.
 *
 * One shape rather than a list of node kinds. The list version missed object
 * literal methods, class members and accessors, enum members, class declaration
 * names, namespace imports and labels — eight shapes of ordinary code reported
 * as impurity, which is how a guard gets switched off. `{ process }` shorthand
 * is deliberately NOT a name: it reads the value.
 */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined || ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if ((parent as { name?: ts.Node }).name === node) {
    return true;
  }
  return (
    ts.isNamespaceImport(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  );
}

/** Does a binding — plain, destructured or nested — bind `name`? */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) => ts.isBindingElement(element) && bindsName(element.name, name),
  );
}

/**
 * True when a declaration emits nothing, so it cannot shadow anything at run
 * time.
 *
 * `declare const process: NodeJS.Process` is the ordinary way to reach an
 * ambient global while satisfying the type checker, and treating it as a binding
 * let `process.platform` through with `tsc` clean and the suite green. This is
 * the mirror of the `ExpressionWithTypeArguments` case: there a type node
 * carried a live expression, here a live-looking declaration carries no binding.
 */
function isErasedDeclaration(statement: ts.Statement): boolean {
  // The `declare` modifier itself, or an enclosing `declare module`/`namespace`,
  // whose members are ambient without carrying the modifier of their own.
  for (let node: ts.Node | undefined = statement; node !== undefined; node = node.parent) {
    if (ts.isSourceFile(node)) {
      return false;
    }
    const declared =
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true;
    if (declared) {
      return true;
    }
  }
  return false;
}

/**
 * Does an import declaration bind `name` at run time — default, namespace or
 * named? A type-only import binds nothing, whether the whole clause is
 * `import type` or the single specifier is `{ type X as process }`.
 */
function importBinds(statement: ts.ImportDeclaration, name: string): boolean {
  const clause = statement.importClause;
  if (clause === undefined || clause.isTypeOnly) {
    return false;
  }
  if (clause.name?.text === name) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return false;
  }
  return ts.isNamespaceImport(bindings)
    ? bindings.name.text === name
    : bindings.elements.some((element) => !element.isTypeOnly && element.name.text === name);
}

/** The statements a scope holds directly, for the scope kinds that hold any. */
function scopeStatements(scope: ts.Node): readonly ts.Statement[] {
  if (
    ts.isSourceFile(scope) ||
    ts.isBlock(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  ) {
    return scope.statements;
  }
  return [];
}

/** Does a `for`/`for-of`/`for-in` initialiser or a `catch` clause bind `name`? */
function scopeBinderDeclares(scope: ts.Node, name: string): boolean {
  const list =
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
      ? scope.initializer
      : undefined;
  if (list?.declarations.some((d) => bindsName(d.name, name)) === true) {
    return true;
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    return bindsName(scope.variableDeclaration.name, name);
  }
  return false;
}

/** Does this one scope — not its ancestors — bind `name` at run time? */
function scopeDeclares(scope: ts.Node, name: string): boolean {
  for (const statement of scopeStatements(scope)) {
    if (isErasedDeclaration(statement)) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.declarations.some((d) => bindsName(d.name, name))) {
        return true;
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return true;
    } else if (ts.isImportDeclaration(statement) && importBinds(statement, name)) {
      // An import binding shadows the global for the whole module, and what may
      // be imported is already an allowlist of two pure modules.
      return true;
    }
  }
  if (scopeBinderDeclares(scope, name)) {
    return true;
  }
  if (!ts.isFunctionLike(scope)) {
    return false;
  }
  // A function expression's own name is in scope inside its body.
  const selfName = ts.isFunctionExpression(scope) && scope.name?.text === name;
  return selfName || scope.parameters.some((p) => bindsName(p.name, name));
}

/**
 * True when a run-time declaration of `node`'s name is in scope AT `node`.
 *
 * Per position, not per file: a file-wide set was scope-blind, and one
 * `function f(process: string)` anywhere disarmed the check for a module-scope
 * `process.platform` on the next line — the exact impurity AC1 names.
 *
 * Binders it resolves: source-file, block, module-block and case-clause
 * statements; `for`/`for-in`/`for-of` initialisers; `catch` clauses; function
 * parameters; and a function expression's own name. Not resolved, and therefore
 * a possible false positive rather than a hole: `var` hoisting out of a nested
 * block, and a `case` clause without braces sharing its `CaseBlock` scope.
 */
function isShadowedAt(node: ts.Identifier): boolean {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (scopeDeclares(scope, node.text)) {
      return true;
    }
  }
  return false;
}

/** Rules that grant a writable hierarchy, i.e. everything but the device carve-out. */
function rootRules(ruleset: LandlockRuleset) {
  return ruleset.pathRules.filter((r) => r.onMissing === "fail");
}

// ---------------------------------------------------------------------------
// AC1 — deterministic, offline, no syscall
// ---------------------------------------------------------------------------

/**
 * Every source module this flow ships, with what each may load.
 *
 * The guard covers the pair, not one file. It was written for `landlock.ts`
 * alone, and `landlock-abi.ts` — the module its own test calls "most likely to
 * acquire a mechanism", now that `bun:ffi` is the confirmed route — had only a
 * specifier allowlist. A default reader calling `globalThis.Bun.spawnSync` on a
 * compiled helper, which is verbatim what AC5 forbids, changes no export and
 * names no specifier: it passed everything.
 */
const LANDLOCK_MODULES = [
  { file: "landlock.ts", allowed: ["./profile", "node:path"] },
  { file: "landlock-abi.ts", allowed: [] as string[] },
];

describe("AC1: buildLandlockRuleset is a pure translation", () => {
  test("the guard covers every source module in the flow", async () => {
    // The closure that makes the list above a class rather than two examples:
    // a third module cannot be added without either listing it here or turning
    // this red. Applying a fix where the finding pointed instead of everywhere
    // the class lives is the failure this repository keeps recording.
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const present = (await readdir(directory))
      .filter((f) => f.startsWith("landlock") && f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort();
    expect(present).toEqual(LANDLOCK_MODULES.map((m) => m.file).sort());
  });

  test.each(LANDLOCK_MODULES)("$file loads nothing impure and reaches for no impure global", async ({
    file,
    allowed,
  }) => {
    // AC1's "no syscall, no FFI, no spawn, no filesystem read, no
    // process.platform branch" — and AC5's "assumes no mechanism" for the ABI
    // seam — are unobservable from outputs: a filesystem read is perfectly
    // deterministic within a run, so only a source guard can hold either.
    //
    // This is the guard's fourth form. Twice it was written over text and twice
    // respelling beat it; the third asked the parser and was beaten again — by a
    // specifier built with `+` (which produces NO entry, so an allowlist is
    // satisfied rather than violated), by `import.meta.require`, by
    // `Function("return process.platform")()` because only `eval` was named, and
    // by `Math["random"]` because that one arm matched a property access while
    // the rest of the guard matched identifiers.
    //
    // WHAT IS CLOSED, measured rather than asserted:
    //   · every load position must carry a STRING-LITERAL specifier, and that
    //     literal must be one of two. A computed specifier is now a failure in
    //     itself, so "no entry" can no longer pass.
    //   · `import.meta` in any form, which removes `import.meta.require`.
    //   · `createRequire` under another name, since importing `node:module` is
    //     already forbidden by the allowlist.
    //   · `eval` and `Function` by name.
    //   · `Math` by identifier with a member allowlist, so `Math["random"]`,
    //     `const { random } = Math` and `const M = Math` are one check — the
    //     principle the guard already applied to `process`.
    //
    // KNOWN GAPS, kept because this file's ancestor (`config-dir.ast.ts`) is the
    // repository's record that structure has spellings too:
    //   · a global reached through a name not in the set below — there is no
    //     enumeration of "every impure global", only of the ones worth naming.
    //     `Reflect`, `structuredClone` and `queueMicrotask` are examples.
    //   · a global reached through no name at all: `({}).constructor.constructor`
    //     is the `Function` constructor, and naming `Function` does not see it.
    //   · a shadow. An identifier is skipped when a RUN-TIME declaration of that
    //     name is in scope at it, so a module-scope `const process = …` disarms
    //     the name for the file. Its initialiser is still checked, so laundering
    //     a real global through one has to pass every other check first.
    //     `declare const` and `import type` bind nothing and are not shadows —
    //     they were, and `declare const process` walked through tsc-clean and
    //     suite-green.
    //   · four binders the scope walk does not resolve, all in the
    //     false-positive direction, none of them a hole: `var` hoisted out of a
    //     nested block, an unbraced `case` clause, a class EXPRESSION's own
    //     name, and `import x = require(…)`. Named in full because an
    //     exhaustive-sounding list that is missing entries is the artifact this
    //     repository keeps writing constraints about.
    //   · anything an allowed specifier might itself do. `./profile` is in-repo
    //     and spawn-free by spec §2; `node:path` is stdlib.
    //   · what the BUNDLER ships. This reads a file from disk; the oracle for
    //     the shipped graph is `src/lib/production-graph.test.ts`, which
    //     resolves specifiers instead of matching them.
    const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
    const sourceFile = parse(path, await readFile(path, "utf8"));

    const reached: string[] = [];

    // An allowlist, so it fails closed on a dependency added later rather than
    // on a name someone thought to forbid.
    //
    // Type-only loads are counted too, deliberately. They are erased before
    // anything runs, so they are not a purity question — but this list is also
    // the record of what the module may depend on at all, and `./profile` is on
    // it precisely because it is imported (for `SandboxProfile`, type-only). A
    // closed list costs one line to update when a dependency is genuinely added
    // and catches one that was not meant to be. `landlock-abi.ts` loads nothing,
    // so its list is empty and exact.
    expect([...new Set(moduleSpecifiers(sourceFile))].sort()).toEqual([...allowed].sort());

    // `moduleSpecifiers` reports literals. A specifier that is not a literal is
    // therefore invisible to the assertion above — so it is a failure here.
    for (const node of walk(sourceFile)) {
      const isDynamicImport =
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const [specifier] = node.arguments;
        if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
          reached.push(`load with a non-literal specifier: ${node.getText(sourceFile)}`);
        }
      }
      // `new.target` is a MetaProperty too, and reporting it as `import.meta`
      // named a construct the module does not contain.
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        reached.push("import.meta");
      }
      // `type T = import("node:fs").Stats` is a load position `moduleSpecifiers`
      // does not walk. It has no run-time effect, but the allowlist is also the
      // record of what this module may depend on, so it belongs in it.
      if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        const specifier =
          ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)
            ? argument.literal.text
            : undefined;
        // Same allowlist as the assertion above, not a second copy of it: two
        // independent lists drift, and the one nobody edits rejects a
        // dependency the other has already accepted.
        if (specifier === undefined || !allowed.includes(specifier)) {
          reached.push(`import type node: ${node.getText(sourceFile)}`);
        }
      }
    }

    // A global has no specifier to allowlist, so these are named. Matching
    // identifiers rather than text means `process`, `process.platform`,
    // `process["platform"]`, `const { x } = process` and `${process.platform}`
    // are one check, and the word appearing inside operator-facing prose is not
    // a match at all — which is what kept turning the text version red.
    const forbiddenGlobals = new Set([
      "process",
      "Bun",
      "globalThis",
      "Date",
      "performance",
      "eval",
      "Function",
      "require",
      "fetch",
      "XMLHttpRequest",
      "WebAssembly",
      "Math",
    ]);
    /** `Math` members this module legitimately uses; everything else is a reach. */
    const pureMathMembers = new Set(["max"]);

    for (const node of walk(sourceFile)) {
      if (!ts.isIdentifier(node) || !forbiddenGlobals.has(node.text)) {
        continue;
      }
      const parent = node.parent;
      if (isDeclarationName(node) || isErasedTypePosition(node) || isShadowedAt(node)) {
        continue;
      }

      // `Math.max` is pure and used. Any other way of reaching `Math` — a
      // different member, an element access, a destructure, a bare alias — is
      // not, and all of them look identical here because the check is on the
      // identifier rather than on one access shape.
      if (node.text === "Math") {
        const usedPurely =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          pureMathMembers.has(parent.name.text);
        if (usedPurely) {
          continue;
        }
      }
      reached.push(node.text);
    }
    expect(reached).toEqual([]);
  });

  test("identical inputs produce deeply equal output", () => {
    expect(buildLandlockRuleset(expressible, ABI_CURRENT)).toEqual(
      buildLandlockRuleset(expressible, ABI_CURRENT),
    );
  });

  test("the same profile is translated identically on repeated calls, including failures", () => {
    const offline = { ...expressible, network: "off" as const };
    expect(buildLandlockRuleset(offline, ABI_CURRENT)).toEqual(
      buildLandlockRuleset(offline, ABI_CURRENT),
    );
  });

  test("the ABI is an argument, never read from the host", () => {
    // Two different ABIs, same profile, different verdicts — proving the kernel
    // value comes from the caller and the tests need no Landlock to run.
    expect(buildLandlockRuleset(expressible, 4).ok).toBe(true);
    expect(buildLandlockRuleset(expressible, 1).ok).toBe(false);
  });

  test("it does not mutate the profile it was given", () => {
    const profile: SandboxProfile = { ...expressible, writableRoots: ["/work/repo", "/work/repo"] };
    const snapshot = structuredClone(profile);
    buildLandlockRuleset(profile, ABI_CURRENT);
    expect(profile).toEqual(snapshot);
  });

  test("fields the translation must ignore do not change its output", () => {
    // `required` is a fail-closed directive for the adapter and `proxy` belongs
    // to the restricted-network path; neither has a Landlock representation.
    const base = rulesetOf(expressible);
    expect(rulesetOf({ ...expressible, required: false })).toEqual(base);
    expect(rulesetOf({ ...expressible, proxy: { host: "127.0.0.1", port: 8080 } })).toEqual(base);
  });

  test("workspace roots become path-beneath rules, deduplicated, in profile order", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/work/repo", "/tmp/s", "/work/repo"] });
    expect(rootRules(ruleset).map((r) => r.path)).toEqual(["/work/repo", "/tmp/s"]);
  });

  test("a trailing slash is normalised away, so the rule path is the path enforced", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/work/repo/", "/work/repo"] });
    expect(rootRules(ruleset).map((r) => r.path)).toEqual(["/work/repo"]);
  });

  test("read-only handles the same write rights but grants no hierarchy", () => {
    const ruleset = rulesetOf({ ...expressible, mode: "read-only", writableRoots: [] });
    expect(rootRules(ruleset)).toEqual([]);
    expect(ruleset.handledFs).toContain("write_file");
  });

  test("a read-only profile carrying writable roots does not grant them", () => {
    // `writableRoots` is documented as empty for read-only. Honouring it would
    // silently widen a read-only claim into workspace-write.
    const ruleset = rulesetOf({ ...expressible, mode: "read-only", writableRoots: ["/work/repo"] });
    expect(rootRules(ruleset)).toEqual([]);
  });

  test("workspace-write with no roots yields a boundary as strict as read-only", () => {
    expect(rulesetOf({ ...expressible, writableRoots: [] })).toEqual(
      rulesetOf({ ...expressible, mode: "read-only", writableRoots: [] }),
    );
  });

  test("no read-ish right is handled, which is how the broad read default is expressed", () => {
    const ruleset = rulesetOf(expressible);
    expect(ruleset.handledFs).not.toContain("read_file");
    expect(ruleset.handledFs).not.toContain("read_dir");
    expect(ruleset.handledFs).not.toContain("execute");
  });

  test("truncate and refer are handled, so the write boundary has no truncate hole", () => {
    const ruleset = rulesetOf(expressible);
    expect(ruleset.handledFs).toContain("truncate");
    expect(ruleset.handledFs).toContain("refer");
  });

  test("the handled set is exactly the twelve write rights", () => {
    // Pinned as a literal, like the two UAPI tables, because this IS the
    // boundary: a right absent from `handled_access_fs` is not narrowed, it is
    // completely unrestricted. Membership assertions left four of them free —
    // dropping `remove_file`, `remove_dir`, `make_reg` or `make_sym` left the
    // whole suite green while `unlink`, `rmdir`, `creat` and `symlink` went
    // unbounded anywhere on the filesystem, with the ruleset still reporting
    // itself complete.
    for (const profile of expressibleShapes) {
      expect([...rulesetOf(profile).handledFs]).toEqual([
        "write_file",
        "remove_dir",
        "remove_file",
        "make_char",
        "make_dir",
        "make_reg",
        "make_sock",
        "make_fifo",
        "make_block",
        "make_sym",
        "refer",
        "truncate",
      ]);
    }
  });

  test("handledFs is never empty — an empty mask is rejected by landlock_create_ruleset", () => {
    for (const profile of expressibleShapes) {
      expect(rulesetOf(profile).handledFs.length).toBeGreaterThan(0);
    }
  });

  test("nothing a ruleset exposes is mutable, so a consumer cannot widen a boundary", () => {
    // `readonly` is erased at run time and the barrel publishes to JS callers
    // with no type checker. Enumerated over every shape rather than named
    // member by member: a per-site freeze that leaves a sibling mutable is how
    // these reviews reach round seven.
    for (const profile of expressibleShapes) {
      const ruleset = rulesetOf(profile);
      for (const value of [ruleset, ruleset.handledFs, ruleset.pathRules, ruleset.handledNet, ruleset.netRules]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      for (const rule of ruleset.pathRules) {
        expect(Object.isFrozen(rule)).toBe(true);
        expect(Object.isFrozen(rule.allow)).toBe(true);
      }
    }
    expect(Object.isFrozen(LANDLOCK_FS_ACCESS_BIT)).toBe(true);
    expect(Object.isFrozen(LANDLOCK_FS_ACCESS_MIN_ABI)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nested rules — the shape the step-2 spike proved is mandatory
// ---------------------------------------------------------------------------

describe("a narrower rule can nest inside a broader hierarchy", () => {
  test("a writable root beneath another writable root is kept, not folded away", () => {
    // Rights accumulate downwards, so the only way to give a subtree more is a
    // deeper rule. A builder that merged or dropped nested paths would force the
    // applier to widen the ancestor instead, which is how the spike turned
    // "make /dev/shm writable" into "may unlink device nodes".
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/work", "/work/cache"] });
    expect(rootRules(ruleset).map((r) => r.path)).toEqual(["/work", "/work/cache"]);
  });

  test("a device rule survives beneath an ancestor root that already covers it", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/"] });
    const paths = ruleset.pathRules.map((r) => r.path);
    expect(paths).toContain("/");
    expect(paths).toContain("/dev/null");
    // …and it keeps its own, narrower rights rather than inheriting the root's.
    const device = ruleset.pathRules.find((r) => r.path === "/dev/null");
    expect(device?.allow).toEqual(["write_file", "truncate"]);
    expect(device?.allow.length).toBeLessThan(ruleset.handledFs.length);
  });

  test("nested rules are never merged, sorted or de-duplicated by prefix", () => {
    const ruleset = rulesetOf({ ...expressible, writableRoots: ["/a/b/c", "/a", "/a/b"] });
    // Profile order is preserved exactly — no prefix sort, no ancestor folding.
    expect(rootRules(ruleset).map((r) => r.path)).toEqual(["/a/b/c", "/a", "/a/b"]);
  });

  test("rule order carries no precedence, so it cannot encode a narrowing", () => {
    // Landlock accumulates: whatever order these are added in, the grant is the
    // union. So reordering the input must change the rule ORDER and nothing
    // else — same paths, same rights, same dispositions.
    //
    // Comparing two sets of the same two path strings would have been true by
    // construction; this compares whole rules, `allow` included, which is where
    // a narrowing would actually live.
    const byPath = (rules: readonly LandlockPathRule[]) =>
      [...rules].sort((a, b) => a.path.localeCompare(b.path));
    const forward = rulesetOf({ ...expressible, writableRoots: ["/a", "/a/b"] });
    const reverse = rulesetOf({ ...expressible, writableRoots: ["/a/b", "/a"] });

    expect(byPath(forward.pathRules)).toEqual(byPath(reverse.pathRules));
    // …and the order really did differ, or the assertion above proved nothing.
    expect(rootRules(forward).map((r) => r.path)).not.toEqual(
      rootRules(reverse).map((r) => r.path),
    );
  });
});

describe("stdio devices stay writable, as in seatbelt.ts and bwrap.ts", () => {
  test.each(["/dev/null", "/dev/zero", "/dev/tty"])("%s is writable in every mode", (device) => {
    for (const profile of expressibleShapes) {
      const rule = rulesetOf(profile).pathRules.find((r) => r.path === device);
      expect(rule?.allow).toEqual(["write_file", "truncate"]);
    }
  });

  test("the carve-out is exactly three devices, and nothing else is granted back", () => {
    // Exclusivity, not membership, and keyed on the disposition rather than on
    // the path prefix: `/dev/sda` added to the list was `write_file` +
    // `truncate` on a raw block device and left the suite green, because every
    // assertion about the carve-out either named a path or tested
    // `startsWith("/dev/")`.
    for (const profile of expressibleShapes) {
      const carveOut = rulesetOf(profile).pathRules.filter((r) => r.onMissing === "skip");
      expect(carveOut.map((r) => r.path)).toEqual(["/dev/null", "/dev/zero", "/dev/tty"]);
    }
  });

  test("a missing device is skipped, a missing writable root is fatal", () => {
    // Dropping a device rule can only over-restrict; dropping a workspace root
    // silently leaves the command with nowhere to write, so it must fail closed.
    const ruleset = rulesetOf(expressible);
    for (const rule of ruleset.pathRules) {
      expect(rule.onMissing).toBe(rule.path.startsWith("/dev/") ? "skip" : "fail");
    }
  });

  test("the carve-out never grants ioctl_dev or a read-ish right", () => {
    for (const rule of rulesetOf(expressible).pathRules) {
      expect(rule.allow).not.toContain("ioctl_dev");
      expect(rule.allow).not.toContain("read_file");
    }
  });

  test("/dev/stdout is deliberately absent — it is a symlink into /proc/self/fd", () => {
    // A rule there would resolve to whatever the descriptor points at and grant
    // write access to it. Inherited stdio needs no rule: Landlock gates `open`.
    const paths = rulesetOf(expressible).pathRules.map((r) => r.path);
    expect(paths).not.toContain("/dev/stdout");
    expect(paths).not.toContain("/dev/stderr");
    expect(paths).not.toContain("/dev/stdin");
  });
});

// ---------------------------------------------------------------------------
// AC2 — inexpressible profiles fail explicitly, never partially
// ---------------------------------------------------------------------------

describe("AC2: an inexpressible profile fails, and never yields a ruleset", () => {
  test('network "off" is refused — Landlock covers TCP only', () => {
    expect(codes({ ...expressible, network: "off" })).toEqual(["network-off-requires-seccomp"]);
  });

  test('network "restricted" is refused — no domain allowlist in Landlock', () => {
    expect(codes({ ...expressible, network: "restricted", allowedDomains: ["example.com"] })).toEqual([
      "network-restricted-requires-proxy-layer",
    ]);
  });

  test("an allowlist on an otherwise-open profile is still treated as restricted", () => {
    expect(codes({ ...expressible, network: "on", allowedDomains: ["example.com"] })).toEqual([
      "network-restricted-requires-proxy-layer",
    ]);
  });

  test("network-off with a stale allowlist is diagnosed as network-off, the stricter posture", () => {
    // Both codes refuse, but they route to different deferred layers: seccomp
    // plus bubblewrap versus the container. The stricter fact must win.
    expect(codes({ ...expressible, network: "off", allowedDomains: ["example.com"] })).toEqual([
      "network-off-requires-seccomp",
    ]);
  });

  test("a non-empty read-deny list is refused — Landlock has no deny rules", () => {
    expect(codes({ ...expressible, readDenyList: ["/home/u/.ssh"] })).toEqual([
      "read-deny-list-requires-mount-view",
    ]);
  });

  test("danger-full-access is refused as a single terminal reason", () => {
    const profile: SandboxProfile = {
      mode: "danger-full-access",
      network: "on",
      writableRoots: [],
      readDenyList: [],
      allowedDomains: [],
      required: false,
    };
    expect(codes(profile, 0)).toEqual(["danger-full-access-is-not-contained"]);
  });

  test("a relative writable root is refused", () => {
    expect(codes({ ...expressible, writableRoots: ["work/repo"] })).toEqual(["path-not-absolute"]);
  });

  test("an empty writable root is refused", () => {
    expect(codes({ ...expressible, writableRoots: [""] })).toEqual(["path-not-absolute"]);
  });

  test("a writable root containing a NUL byte is refused", () => {
    expect(codes({ ...expressible, writableRoots: ["/work/re\0po"] })).toEqual(["path-contains-nul"]);
  });

  test.each(["/work/repo/../..", "/work/./repo", "/..", "/work//repo", "//", "/work/repo//"])(
    "the non-canonical root %s is refused rather than resolved",
    (root) => {
      // Resolving it would grant a hierarchy other than the one reported, and
      // collapsing it silently would report a path the caller never supplied.
      expect(codes({ ...expressible, writableRoots: [root] })).toEqual(["path-not-canonical"]);
    },
  );

  test.each(["/", "/work/..foo", "/work/.hidden", "/work/a..b"])(
    "the legitimate root %s is accepted",
    (root) => {
      // `path-not-canonical` matches whole segments, so a name that merely
      // starts with dots is not a `.` or `..` segment.
      expect(rootRules(rulesetOf({ ...expressible, writableRoots: [root] })).map((r) => r.path)).toEqual([root]);
    },
  );

  test("a failure quotes the root the caller supplied, not a normalised rewrite", () => {
    // Normalisation runs after validation for exactly this reason: an operator
    // reading `writable root ""` cannot map it back to what they configured.
    const [failure] = failuresOf({ ...expressible, writableRoots: ["work/repo/"] });
    expect(failure?.detail).toContain('"work/repo/"');
  });

  test("a duplicated invalid root is reported once", () => {
    expect(codes({ ...expressible, writableRoots: ["rel", "rel"] })).toEqual(["path-not-absolute"]);
  });

  test("ABI 0 is refused as Landlock being unavailable", () => {
    expect(codes(expressible, 0)).toEqual(["landlock-unavailable"]);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "the malformed ABI %p is a reader failure, not a claim about the kernel",
    (abi) => {
      const [failure] = failuresOf(expressible, abi);
      expect(failure?.code).toBe("abi-unreadable");
      expect(failure?.detail).toContain("says nothing about the kernel");
      // The message must name the value the reader returned. `JSON.stringify`
      // renders NaN and Infinity as `null`, which named a value nobody returned
      // — in the one message whose purpose is to be true about the reader.
      expect(failure?.detail).toContain(String(abi));
    },
  );

  test.each([1, 2])("ABI %i cannot carry the write boundary and is refused", (abi) => {
    expect(codes(expressible, abi)).toEqual(["abi-too-low"]);
  });

  test("ABI 3 is the floor at which the write boundary becomes expressible", () => {
    expect(buildLandlockRuleset(expressible, 3).ok).toBe(true);
    expect(rulesetOf(expressible, 3).minimumAbi).toBe(3);
  });

  test("the ABI failure names the kernel ABI and the missing rights, not the platform", () => {
    const [failure] = failuresOf(expressible, 1);
    expect(failure?.detail).toContain("ABI 1");
    expect(failure?.detail).toContain("truncate");
    expect(failure?.detail.toLowerCase()).not.toContain("linux");
  });

  test("the ABI failure does not claim refer is left unrestricted — the kernel denies it", () => {
    // With `refer` absent or unhandled, cross-directory rename and link are
    // denied everywhere. Reporting them as unrestricted would be a keryx claim
    // about the kernel that contradicts the kernel, on the exact host class
    // (Ubuntu 22.04, ABI 1) the PRD singles out.
    const [failure] = failuresOf(expressible, 1);
    expect(failure?.detail).toContain("without refer, cross-directory rename and link");
    expect(failure?.detail).toContain("stricter than the profile asks for");
    expect(failure?.detail).toContain("without truncate");
  });

  test("each missing right is named once, beside what its absence actually does", () => {
    // At ABI 2 only `truncate` is missing, so `refer` must not be mentioned and
    // nothing may be listed twice.
    const [failure] = failuresOf(expressible, 2);
    expect(failure?.detail).toContain("without truncate");
    expect(failure?.detail).not.toContain("refer");
    expect(failure?.detail.match(/truncate/g)).toHaveLength(1);
  });

  test("every failure carries a code, a field and a non-empty detail", () => {
    const failures = failuresOf(
      { ...expressible, network: "off", readDenyList: ["/home/u/.ssh"], writableRoots: ["rel"] },
      1,
    );
    expect(failures.length).toBeGreaterThan(1);
    for (const failure of failures) {
      expect(failure.code.length).toBeGreaterThan(0);
      expect(failure.field.length).toBeGreaterThan(0);
      expect(failure.detail.length).toBeGreaterThan(0);
    }
  });

  test("every reason is reported, not just the first, with the field it is about", () => {
    const profile: SandboxProfile = {
      ...expressible,
      network: "off",
      readDenyList: ["/home/u/.ssh"],
      writableRoots: ["rel"],
    };
    expect(failuresOf(profile, 1).map((f) => [f.code, f.field])).toEqual([
      ["network-off-requires-seccomp", "network"],
      ["read-deny-list-requires-mount-view", "readDenyList"],
      ["path-not-absolute", "writableRoots"],
      ["abi-too-low", "abi"],
    ]);
  });

  test("a failed translation carries no ruleset at all", () => {
    const result = buildLandlockRuleset({ ...expressible, network: "off" }, ABI_CURRENT);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("ruleset");
  });

  test("the default policy-derived profile is inexpressible once a home directory is known", () => {
    // Recorded because it decides how often the bubblewrap fallback is taken:
    // `defaultReadDenyList(home)` is non-empty, and network-off compounds it.
    expect(codes(defaultSandboxProfile("/work/repo", "/tmp/session", "/home/u"))).toEqual([
      "network-off-requires-seccomp",
      "read-deny-list-requires-mount-view",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a returned ruleset covers everything Landlock can reach
// ---------------------------------------------------------------------------

describe("AC3: a returned ruleset is complete by construction", () => {
  test("LandlockRuleset has no field in which a partial boundary could be recorded", () => {
    // The guard against a `notEnforced` / `bestEffort` / `partial` escape hatch
    // being added later: an approximated boundary would be reported as a real
    // one. It runs over every shape that yields a ruleset and at every ABI that
    // can return one, so an optional field populated on some other branch is
    // caught too — a single-fixture assertion is not a claim about the type.
    for (const abi of [3, 4, 5, 6]) {
      for (const profile of expressibleShapes) {
        expect(Object.keys(rulesetOf(profile, abi)).sort()).toEqual([
          "handledFs",
          "handledNet",
          "minimumAbi",
          "netRules",
          "pathRules",
        ]);
      }
    }
  });

  test("the type itself is pinned to those five fields", () => {
    // Runtime keys of one value can never prove a claim about a type. This does:
    // adding or removing a field on LandlockRuleset fails `tsc --noEmit`, which
    // the `check` script already runs.
    type Fields = "handledFs" | "handledNet" | "minimumAbi" | "netRules" | "pathRules";
    const exhaustive: Record<Fields, true> & Record<keyof LandlockRuleset, true> = {
      handledFs: true,
      handledNet: true,
      minimumAbi: true,
      netRules: true,
      pathRules: true,
    };
    expect(Object.keys(exhaustive).length).toBe(5);
  });

  test("every rule's allow set is a non-empty subset of the handled set", () => {
    for (const profile of expressibleShapes) {
      const ruleset = rulesetOf(profile);
      for (const rule of ruleset.pathRules) {
        expect(rule.allow.length).toBeGreaterThan(0);
        for (const access of rule.allow) {
          expect(ruleset.handledFs).toContain(access);
        }
      }
    }
  });

  test("minimumAbi is 3, and it is the maximum first-ABI over the handled rights", () => {
    const ruleset = rulesetOf(expressible);
    expect(ruleset.minimumAbi).toBe(3); // truncate is the binding right
    for (const right of ruleset.handledFs) {
      expect(LANDLOCK_FS_ACCESS_MIN_ABI[right]).toBeLessThanOrEqual(ruleset.minimumAbi);
    }
    expect(
      ruleset.handledFs.some((r) => LANDLOCK_FS_ACCESS_MIN_ABI[r] === ruleset.minimumAbi),
    ).toBe(true);
  });

  test("a ruleset is never returned below its own minimumAbi", () => {
    for (const abi of [0, 1, 2, 3, 4, 5, 6]) {
      const result = buildLandlockRuleset(expressible, abi);
      if (result.ok) {
        expect(abi).toBeGreaterThanOrEqual(result.ruleset.minimumAbi);
      }
    }
  });

  test("what a ruleset does not restrict is named in a value, not only in a comment", () => {
    // Pinned as a full literal like the two UAPI tables, because this is what a
    // reporting layer will state. Asserting only that `handledFs` excludes these
    // would be a tautology: none is a `LandlockFsAccess` value, so no
    // implementation change could make it fail.
    expect(
      LANDLOCK_RESIDUAL_ACTIONS.map((a) => [
        a.action,
        a.restrictableFromAbi,
        a.refusedByBubblewrap,
      ]),
    ).toEqual([
      ["chmod", null, true],
      ["chown", null, true],
      ["setxattr", null, true],
      ["utime", null, true],
      ["ioctl on a regular file or directory", null, true],
      ["ioctl on a character or block device", 5, false],
      ["fcntl", null, false],
      ["flock", null, false],
    ]);
    expect(Object.isFrozen(LANDLOCK_RESIDUAL_ACTIONS)).toBe(true);
    for (const entry of LANDLOCK_RESIDUAL_ACTIONS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  test("ioctl is split, because one entry cannot be true of both halves", () => {
    // LANDLOCK_ACCESS_FS_IOCTL_DEV covers an opened character or block device
    // and nothing else. Recording a single `ioctl` as restrictable from ABI 5
    // over-claims for regular files; recording it as never restrictable
    // under-claims for devices on a 6.10 kernel. Round 2 fixed the second by
    // introducing the first, which is why both halves are pinned here.
    const ioctls = LANDLOCK_RESIDUAL_ACTIONS.filter((a) => a.action.startsWith("ioctl"));
    expect(ioctls).toHaveLength(2);
    expect(ioctls.map((a) => a.restrictableFromAbi).sort()).toEqual([5, null]);
    // The device half has to agree with the table it is a deferral from.
    const device = ioctls.find((a) => a.action.includes("device"));
    expect(LANDLOCK_FS_ACCESS_MIN_ABI.ioctl_dev).toBe(device?.restrictableFromAbi ?? -1);
    // A bare "ioctl" entry would be the ambiguity this split exists to remove.
    expect(LANDLOCK_RESIDUAL_ACTIONS.map((a) => a.action)).not.toContain("ioctl");
  });

  test("only the entries bubblewrap actually refuses claim a layer-2 advantage", () => {
    // `fcntl` and `flock` are kernel state, not filesystem content: they succeed
    // on a read-only bind too. Claiming EROFS for them would overstate layer 2
    // and make the asymmetry argument rest on two entries that do not support it.
    const refused = LANDLOCK_RESIDUAL_ACTIONS.filter((a) => a.refusedByBubblewrap);
    expect(refused.map((a) => a.action)).toEqual([
      "chmod",
      "chown",
      "setxattr",
      "utime",
      "ioctl on a regular file or directory",
    ]);
    for (const action of ["fcntl", "flock"]) {
      expect(LANDLOCK_RESIDUAL_ACTIONS.find((a) => a.action === action)?.refusedByBubblewrap).toBe(
        false,
      );
    }
  });

  test("no profile shape ever handles the deferred device-ioctl right", () => {
    // The residue's profile-independence needs no assertion: it is a module-level
    // `export const`, so the type system already forbids a per-profile value. An
    // earlier version compared the binding to itself, which no legal
    // implementation could fail. What is worth checking is the ruleset side.
    for (const profile of expressibleShapes) {
      expect(rulesetOf(profile).handledFs).not.toContain("ioctl_dev");
    }
  });

  test("a writable root is granted the whole handled set, not a narrower slice", () => {
    // Round 3's guarantee is about what a nested rule GRANTS; the tests it
    // shipped checked only paths and order. A root granted less than `handledFs`
    // is inert beneath an ancestor and over-restrictive without one, and nothing
    // observed it.
    for (const profile of expressibleShapes) {
      const ruleset = rulesetOf(profile);
      for (const rule of rootRules(ruleset)) {
        expect(rule.allow).toEqual(ruleset.handledFs);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — Landlock is never credited with network containment
// ---------------------------------------------------------------------------

describe("AC4: no profile produces a network rule", () => {
  test.each(["on", "off", "restricted"] as const)(
    'network "%s" never yields handledNet or netRules',
    (network) => {
      const result = buildLandlockRuleset({ ...expressible, network }, ABI_CURRENT);
      if (!result.ok) {
        // No ruleset at all is the stronger form of "no network rule", but the
        // reason has to be the network one — otherwise this case proves nothing.
        expect(result.failures.map((f) => f.code)).toContain(
          network === "off" ? "network-off-requires-seccomp" : "network-restricted-requires-proxy-layer",
        );
        return;
      }
      expect(result.ruleset.handledNet).toEqual([]);
      expect(result.ruleset.netRules).toEqual([]);
    },
  );

  test("no profile shape at any usable ABI carries a network rule", () => {
    // Enumerated like AC3's guard rather than run on one fixture: a network
    // field populated on some other shape is exactly what a per-fixture
    // assertion misses, and this is the guard against the second false green.
    for (const abi of [3, 4, 5, 6]) {
      for (const profile of expressibleShapes) {
        const ruleset = rulesetOf(profile, abi);
        expect(ruleset.handledNet).toEqual([]);
        expect(ruleset.netRules).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Kernel constant tables
// ---------------------------------------------------------------------------

describe("access-right tables match the kernel UAPI", () => {
  test("bit positions are the uapi order", () => {
    expect(LANDLOCK_FS_ACCESS_BIT).toEqual({
      execute: 0,
      write_file: 1,
      read_file: 2,
      read_dir: 3,
      remove_dir: 4,
      remove_file: 5,
      make_char: 6,
      make_dir: 7,
      make_reg: 8,
      make_sock: 9,
      make_fifo: 10,
      make_block: 11,
      make_sym: 12,
      refer: 13,
      truncate: 14,
      ioctl_dev: 15,
    });
  });

  test("first-ABI values are the uapi ones", () => {
    // Pinned as a full literal, like the bit table: these are kernel facts, and
    // the module's whole ABI-floor argument rests on them being exact.
    expect(LANDLOCK_FS_ACCESS_MIN_ABI).toEqual({
      execute: 1,
      write_file: 1,
      read_file: 1,
      read_dir: 1,
      remove_dir: 1,
      remove_file: 1,
      make_char: 1,
      make_dir: 1,
      make_reg: 1,
      make_sock: 1,
      make_fifo: 1,
      make_block: 1,
      make_sym: 1,
      refer: 2,
      truncate: 3,
      ioctl_dev: 5,
    });
  });

  test("the two tables describe the same set of rights", () => {
    expect(Object.keys(LANDLOCK_FS_ACCESS_MIN_ABI).sort()).toEqual(
      Object.keys(LANDLOCK_FS_ACCESS_BIT).sort(),
    );
  });

  test("landlockFsMask folds names into the u64 mask", () => {
    expect(landlockFsMask([])).toBe(0n);
    expect(landlockFsMask(["execute"])).toBe(1n);
    expect(landlockFsMask(["write_file", "truncate"])).toBe(0b100000000000010n);
    // Idempotent: a repeated right sets the same bit once.
    expect(landlockFsMask(["truncate", "truncate"])).toBe(landlockFsMask(["truncate"]));
  });
});
