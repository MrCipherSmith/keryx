// Structural source guards, over the TypeScript AST rather than over text.
//
// READ THIS FIRST: THESE ARE HEURISTICS, NOT CLOSURES
//
// An earlier version of this header said that asking the parser "removes the
// entire class of evasion-by-respelling … for spellings nobody has thought of
// yet", and that "text has spellings; structure does not". Both sentences are
// false, and a review proved it by planting ten working production modules that
// do the forbidden things and watching the suite stay green.
//
// Structure has spellings too. `Object.assign`, a spread, `Object.fromEntries`,
// `Object.defineProperty`, a static class field and a chained `Map.set()` are
// six structures for a handful of semantic acts, and a matcher has to know each
// one. Matching the AST is genuinely better than matching text — a declaration
// cannot be confused with a construction, and a destructuring read cannot be
// confused with a supply, because those are different node kinds rather than
// similar characters — but it is still an enumeration, and the previous claim
// was one step stronger than the evidence.
//
// KNOWN GAPS, kept current
//
// Each of these is a real offender these predicates do not report. They are
// listed so the next reviewer does not have to rediscover them, and so nothing
// here reads as coverage it does not have.
//
//   moduleSpecifiers / loadsModule
//     · a specifier that is not a string literal: `"./config-dir" + ".scan"`,
//       a template WITH a substitution, a value read from configuration
//     · `createRequire(...)` bound to a name other than `require`, and
//       `import.meta.require`
//     For the question that matters most — does the module SHIP — there is a
//     real closure, and it is `production-graph.test.ts`, which asks the
//     bundler. This predicate answers the weaker question (does a source file
//     name it) and catches an import that is currently tree-shaken.
//
//   declaresRanking
//     · a row table: `[{ mode: "read-only", rank: 0 }, …]` — the schema is
//       arbitrary, so there is nothing to match on
//     · values that are named constants rather than numeric literals; that
//       needs constant folding, which this file deliberately does not do
//     · static class fields, and `new Map().set(a, 0).set(b, 1)`
//
//   constructsWith
//     · a builder function returning the object; a class instance
//
//   suppliesProperty
//     · a whole prebuilt options object passed by name, where the seam was set
//       somewhere this predicate never sees
//
// Also, by construction: no type checking and no module resolution. Each file is
// parsed alone, so an alias through an intermediate re-export is invisible, and
// so is a path that resolves to the same file through a symlink or a `paths`
// mapping.
//
// WHAT THIS IS FOR, THEN
//
// Defence in depth against the accidental case — someone adds a second ranking
// table or a fourth profile without knowing the rule — not against someone
// working around the guard. For `config-dir.scan.ts` and `config-dir.ast.ts`
// reaching production there IS a real closure and it lives elsewhere; for the
// other three properties there is no oracle, and pretending otherwise is what
// this header did.
//
// A NOTE ON FALSE POSITIVES
//
// Three shapes of ordinary code used to be reported: two unrelated helpers each
// holding one `if (x === "deny") return 1` (the comparison counter was
// file-wide), a validation set `["deny","ask","allow"]` with `.includes`, and a
// projection `{ trustMode: p.trustMode, requiredControls: p.requiredControls }`.
// All three are quiet now. This matters more than the misses: a guard that
// fires on a validation set gets deleted by the next person who trips on it, and
// then it protects nothing at all.
//
// HISTORY, because it is the argument for the caution above
//
// Four guards, built as regexes, defeated in three consecutive rounds — each
// widened for the spelling that beat it, each beaten by the next. Then rewritten
// onto the AST and sold as closed; defeated again in the fourth round by twelve
// ordinary spellings. The recorded lesson
// (`.metaproject/memory/constraints/code-blanks-string-literals.md`) says a
// self-check must plant the spelling PRODUCTION uses, not one the guard already
// knows — and three rounds running, the self-checks planted the implementation's
// own branch list instead.
//
// COST
//
// `walk` uses `getChildren()`, which materialises token and `SyntaxList` nodes:
// measured at 374ms over 351 files against 35ms for `ts.forEachChild`, for
// identical results, because no predicate here inspects a token. It stays for
// now because these run in the test suite and not on a hot path, and the
// difference is stated rather than left to be measured by the next reviewer.

import ts from "typescript";

/** Parse one file's text. `true` sets parent pointers, which the walkers need. */
export function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Every node in the tree, depth-first.
 *
 * `forEachChild`, not `getChildren()`. The latter materialises token and
 * `SyntaxList` nodes — measured at 623,841 nodes in 374ms over 351 files
 * against 332,499 in 35ms — and no predicate in this file inspects a token, so
 * the extra nodes were ten times the cost for identical results.
 */
export function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  for (const child of children) {
    yield* walk(child);
  }
}

/**
 * The text of a property name, however it is written.
 *
 * `x`, `"x"`, `'x'` and `["x"]` all answer `x`. A computed key that is not a
 * string literal — `[someVar]` — answers `undefined`, because its value is not
 * knowable without evaluating the program, and a guard must not guess.
 */
export function propertyKey(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Every module specifier the file LOADS, in any position.
 *
 * `import … from`, bare `import "…"`, `export … from`, `require("…")`, and
 * dynamic `import("…")`. Template literals with no substitutions count — they
 * are string literals with different punctuation, and one defeated the previous
 * guard.
 */
export function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node === undefined) {
      return;
    }
    // `isStringLiteralLike` is `StringLiteral | NoSubstitutionTemplateLiteral`,
    // so a separate arm for the template form was unreachable — and the test
    // that appeared to cover it was passing through this branch all along.
    if (ts.isStringLiteralLike(node)) {
      found.push(node.text);
    }
  };
  for (const node of walk(sourceFile)) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        literal(node.arguments[0]);
      }
    }
  }
  return found;
}

/**
 * Does the file load a module whose specifier names `moduleBasename`?
 *
 * Compared on the specifier's last path segment with any extension removed, so
 * `./config-dir.scan`, `../lib/config-dir.scan.ts` and `./config-dir.scan.js`
 * all answer the same. The extension form is what defeated the regex, and it is
 * this repository's own idiom for dynamic imports.
 */
export function loadsModule(sourceFile: ts.SourceFile, moduleBasename: string): boolean {
  return moduleSpecifiers(sourceFile).some((specifier) => {
    const last = specifier.split("/").at(-1) ?? "";
    return last === moduleBasename || last.startsWith(`${moduleBasename}.`);
  });
}

/**
 * Does the file declare a permissiveness ORDERING over `vocabulary`?
 *
 * An ordering is the thing being forbidden, not any particular way of writing
 * one. Five structural forms, and the point of doing it here is that this list
 * is about shapes a program can have rather than about strings a file can
 * contain:
 *
 *   1. an object literal mapping two or more vocabulary words to numbers —
 *      whatever the keys look like (`a: 0`, `"a": 0`, `["a"]: 0`);
 *   2. `new Map([[word, n], …])` with two or more such pairs;
 *   3. an array of two or more vocabulary words, which is an ordering by index
 *      even with no number written anywhere;
 *   4. a `switch` returning a numeric literal from two or more vocabulary cases;
 *   5. a chain of two or more `x === word` comparisons each returning a number,
 *      as an if-chain or as nested ternaries.
 *
 * Two or more, always: one `{ deny: 0 }` is a flag, not an ordering, and a guard
 * that fires on it would be noise and would be turned off.
 */
/**
 * Does anything read an INDEX out of this array?
 *
 * `arr.indexOf(x)`, `arr.findIndex(...)`, `arr[i]`, or the array being assigned
 * to a name that is later indexed. Only the first two and a direct index are
 * detected; an array passed to a helper that indexes it is not, and that is
 * stated rather than claimed away.
 */
function readsAPosition(array: ts.ArrayLiteralExpression): boolean {
  const holder = array.parent;
  const name =
    holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
      ? holder.name.text
      : undefined;
  const root = array.getSourceFile();
  for (const node of walk(root)) {
    if (ts.isPropertyAccessExpression(node)) {
      const method = node.name.text;
      if (method !== "indexOf" && method !== "findIndex") {
        continue;
      }
      if (node.expression === array) {
        return true;
      }
      if (name !== undefined && ts.isIdentifier(node.expression) && node.expression.text === name) {
        return true;
      }
    }
    if (ts.isElementAccessExpression(node) && name !== undefined) {
      if (ts.isIdentifier(node.expression) && node.expression.text === name) {
        return true;
      }
    }
  }
  return false;
}

export function declaresRanking(sourceFile: ts.SourceFile, vocabulary: readonly string[]): boolean {
  const words = new Set(vocabulary);
  const isWord = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isStringLiteralLike(node) && words.has(node.text);
  const isNumber = (node: ts.Node | undefined): boolean =>
    node !== undefined &&
    (ts.isNumericLiteral(node) ||
      (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)));

  for (const node of walk(sourceFile)) {
    // 1. an object literal of word -> number
    if (ts.isObjectLiteralExpression(node)) {
      let pairs = 0;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const key = propertyKey(property.name);
        if (key !== undefined && words.has(key) && isNumber(property.initializer)) {
          pairs += 1;
        }
      }
      if (pairs >= 2) {
        return true;
      }
    }

    // 2. new Map([[word, n], ...])   3. [word, word, ...]
    if (ts.isArrayLiteralExpression(node)) {
      let mapPairs = 0;
      let bareWords = 0;
      for (const element of node.elements) {
        if (ts.isArrayLiteralExpression(element) && isWord(element.elements[0]) && isNumber(element.elements[1])) {
          mapPairs += 1;
        }
        if (isWord(element)) {
          bareWords += 1;
        }
        // NOTE: counted, but see the `indexOf` requirement below. A bare array
        // of the vocabulary is just as often a membership set.
      }
      if (mapPairs >= 2) {
        return true;
      }
      // An ordered array is an ordering only if something reads a POSITION out
      // of it. `["deny","ask","allow"]` with `.includes(v)` is a validation set,
      // and reporting it was a false positive on ordinary code. `indexOf` /
      // `findIndex` / a numeric index is what turns the same array into a rank.
      if (bareWords >= 2 && readsAPosition(node)) {
        return true;
      }
    }

    // 4. switch (x) { case word: return n; }
    if (ts.isSwitchStatement(node)) {
      let cases = 0;
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause) || !isWord(clause.expression)) {
          continue;
        }
        const returnsNumber = clause.statements.some(
          (statement) => ts.isReturnStatement(statement) && isNumber(statement.expression),
        );
        if (returnsNumber) {
          cases += 1;
        }
      }
      if (cases >= 2) {
        return true;
      }
    }
  }

  // 5. `x === word ? n : …` or `if (x === word) return n`, twice or more WITHIN
  //    ONE FUNCTION.
  //
  //    Counted per enclosing function, not per file. The file-wide version
  //    reported two unrelated helpers — `exitCodeFor` returning 1 for "deny" and
  //    `columnWidth` returning 8 for "allow" — as a single ordering chain. That
  //    is a false positive on ordinary code, and a false positive is worse than
  //    a miss: a guard that cries wolf gets switched off, and then it protects
  //    nothing. The comment defending the file-wide choice said an if-chain and
  //    a ternary chain "have no single containing node worth anchoring to". The
  //    enclosing function is that node.
  let comparisons = 0;
  let anchor: ts.Node | undefined;
  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    let current: ts.Node | undefined = node;
    while (current !== undefined) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return undefined;
  };

  for (const node of walk(sourceFile)) {
    if (!ts.isBinaryExpression(node)) {
      continue;
    }
    const op = node.operatorToken.kind;
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken) {
      continue;
    }
    if (!isWord(node.left) && !isWord(node.right)) {
      continue;
    }
    // The comparison must decide a number: `? n :`, or `if (…) return n`.
    const parent = node.parent;
    if (parent === undefined) {
      continue;
    }
    let decidesANumber = false;
    if (ts.isConditionalExpression(parent) && (isNumber(parent.whenTrue) || isNumber(parent.whenFalse))) {
      decidesANumber = true;
    } else if (ts.isIfStatement(parent)) {
      const branch = parent.thenStatement;
      decidesANumber = ts.isReturnStatement(branch)
        ? isNumber(branch.expression)
        : ts.isBlock(branch) &&
          branch.statements.some((s) => ts.isReturnStatement(s) && isNumber(s.expression));
    }
    if (!decidesANumber) {
      continue;
    }
    const owner = enclosingFunction(node);
    if (owner !== anchor) {
      anchor = owner;
      comparisons = 0;
    }
    comparisons += 1;
    if (comparisons >= 2) {
      return true;
    }
  }
  return false;
}

/** How a property was supplied at a call site or in an object. */
/**
 * How a property was supplied. Every member is produced by `suppliesProperty`.
 *
 * There used to be a `"spread-unknown"` here that nothing ever returned: the
 * spread hole was seen, written into the type, and left open. A type member with
 * no producer is a comment that typechecks, and it read as coverage.
 */
export type SupplyForm = "property" | "shorthand" | "assignment";

/**
 * Every place the file SUPPLIES a value for `name`, in any spelling.
 *
 * A declaration is not a supply: `containmentAvailable?: () => boolean` in an
 * interface, and a type annotation, are both excluded because neither passes a
 * value. That distinction was carried by a `?` in the regex version and is
 * carried by the node kind here.
 *
 *   property     `{ name: value }`, `{ "name": value }`, `{ ["name"]: value }`
 *   shorthand    `{ name }`
 *   assignment   `o.name = value`, `o["name"] = value`
 *
 * Destructuring — `const { name } = opts` — is a READ and is not reported: an
 * ObjectBindingPattern is a different node from an ObjectLiteralExpression, so
 * the two cannot be confused here the way they were under a regex.
 */
export function suppliesProperty(sourceFile: ts.SourceFile, name: string): SupplyForm[] {
  const found: SupplyForm[] = [];
  /** Is this expression the string `name`, directly or through a `const`? */
  const namesTheSeam = (node: ts.Node | undefined): boolean => {
    if (node === undefined) {
      return false;
    }
    if (ts.isStringLiteralLike(node)) {
      return node.text === name;
    }
    if (!ts.isIdentifier(node)) {
      return false;
    }
    // One hop through a `const SEAM = "containmentAvailable"` in the same file.
    // Not general constant folding — a value assembled at runtime is out of
    // reach and is listed in the gaps at the top of this file.
    for (const candidate of walk(node.getSourceFile())) {
      if (
        ts.isVariableDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === node.text &&
        candidate.initializer !== undefined &&
        ts.isStringLiteralLike(candidate.initializer)
      ) {
        return candidate.initializer.text === name;
      }
    }
    return false;
  };

  for (const node of walk(sourceFile)) {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (propertyKey(property.name) === name) {
            found.push("property");
          } else if (
            ts.isComputedPropertyName(property.name) &&
            namesTheSeam(property.name.expression)
          ) {
            // `{ [SEAM]: f }` where SEAM is a const holding the name.
            found.push("property");
          }
        } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
          found.push("shorthand");
        }
      }
      continue;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      const named =
        (ts.isPropertyAccessExpression(target) && target.name.text === name) ||
        (ts.isElementAccessExpression(target) && namesTheSeam(target.argumentExpression));
      if (named) {
        found.push("assignment");
      }
      continue;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      // `Object.defineProperty(o, "seam", {...})` — the name is an ARGUMENT, so
      // no property key anywhere in the tree carries it.
      if (method === "defineProperty" && namesTheSeam(node.arguments[1])) {
        found.push("assignment");
        continue;
      }
      // `Object.fromEntries([["seam", f]])` — likewise, and it also slips past a
      // text search because the name only ever appears inside a string.
      if (method === "fromEntries") {
        for (const argument of node.arguments) {
          if (!ts.isArrayLiteralExpression(argument)) {
            continue;
          }
          for (const pair of argument.elements) {
            if (ts.isArrayLiteralExpression(pair) && namesTheSeam(pair.elements[0])) {
              found.push("property");
            }
          }
        }
      }
    }
  }
  return found;
}

/**
 * Object literals that CONSTRUCT a value carrying every one of `required`.
 *
 * "Constructs" rather than "mentions": an interface member and a type
 * annotation are not ObjectLiteralExpressions, so the declaration that the
 * regex version had to exclude by inspecting punctuation is excluded here by
 * being a different kind of node.
 *
 * A property counts however it is supplied and whatever its value is — an
 * inline object, a bare identifier, or a CALL. The call form is the one the
 * regex missed after being widened specifically to catch values built
 * elsewhere and passed by name.
 */
export function constructsWith(sourceFile: ts.SourceFile, required: readonly string[]): boolean {
  /** Keys this literal supplies directly. Spread contributes nothing knowable. */
  const ownKeys = (literal: ts.ObjectLiteralExpression): Set<string> => {
    const keys = new Set<string>();
    for (const property of literal.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyKey(property.name);
        if (key !== undefined) {
          keys.add(key);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        keys.add(property.name.text);
      }
    }
    return keys;
  };

  /**
   * Is every value in this literal read off ONE other object?
   *
   * `{ fingerprint: p.fingerprint, trustMode: p.trustMode, requiredControls:
   * p.requiredControls }` projects an existing profile into an evidence record.
   * It carries both required names and constructs nothing, and reporting it was
   * a false positive on ordinary code — the kind that gets a guard switched off.
   */
  const isProjection = (literal: ts.ObjectLiteralExpression): boolean => {
    let source: string | undefined;
    let values = 0;
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return false;
      }
      const value = property.initializer;
      if (!ts.isPropertyAccessExpression(value) || !ts.isIdentifier(value.expression)) {
        return false;
      }
      const from = value.expression.text;
      if (source !== undefined && from !== source) {
        return false;
      }
      source = from;
      values += 1;
    }
    return values > 0;
  };

  for (const node of walk(sourceFile)) {
    if (!ts.isObjectLiteralExpression(node)) {
      continue;
    }
    if (isProjection(node)) {
      continue;
    }
    const supplied = ownKeys(node);

    // A SPREAD carries keys this file cannot enumerate, so `{...base, trustMode}`
    // is treated as carrying whatever it needs. That is deliberate over-reach in
    // the safe direction: the guard exists to stop a second profile appearing,
    // and cloning one with a spread is the most natural way to write it. It was
    // invisible before, which made the AST version WEAKER than the regex it
    // replaced for exactly this shape.
    const spreads = node.properties.some((property) => ts.isSpreadAssignment(property));
    if (spreads && required.some((field) => supplied.has(field))) {
      return true;
    }

    if (required.every((field) => supplied.has(field))) {
      return true;
    }

    // `Object.assign({…}, {…})` — the halves are separate literals, so neither
    // carries both names on its own. Union them at the call.
    const call = node.parent;
    if (
      call !== undefined &&
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "assign"
    ) {
      const union = new Set<string>();
      for (const argument of call.arguments) {
        if (ts.isObjectLiteralExpression(argument)) {
          for (const key of ownKeys(argument)) {
            union.add(key);
          }
        }
      }
      if (required.every((field) => union.has(field))) {
        return true;
      }
    }
  }
  return false;
}
