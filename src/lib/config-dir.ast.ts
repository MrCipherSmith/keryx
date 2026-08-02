// Structural source guards, over the TypeScript AST rather than over text.
//
// WHY THIS FILE EXISTS
//
// Four source-level guards in this tree were built as regular expressions over
// source text. Each was defeated, and each was then widened to match the
// spelling that defeated it, and each was defeated again by the next spelling.
// Three rounds of review, four guards, and every widening bought exactly one
// more form:
//
//   the scanner-importer guard   knew `from "…"`; missed `require("…")`, then
//                                dynamic `import("…")`, then — after both were
//                                added — a specifier with a FILE EXTENSION,
//                                which is the idiom of the very file the guard
//                                lives in.
//   the rank-table guard         knew bare identifier keys; missed quoted keys,
//                                then multi-digit values, then an ordered array
//                                with `indexOf`, then computed keys, a `Map`,
//                                an if-chain, and a ternary chain.
//   the profile-literal guard    knew `requiredControls: {`; missed a named
//                                reference, and after being widened for exactly
//                                that, still missed a CALL — which was the case
//                                the widening was written for.
//   the weakening-seam guard     knew `name:`; missed ES6 shorthand, and after
//                                being widened for it, still missed a property
//                                assignment.
//
// A reviewer proved the last round of these by planting real production modules
// in a sandbox copy and watching the whole suite stay green. A guard that a file
// extension defeats is worse than no guard, because it reads as coverage.
//
// The recorded lesson (`.metaproject/memory/constraints/code-blanks-string-literals.md`)
// says a self-check must plant the spelling PRODUCTION uses, not one the guard
// already knows. That lesson was written and violated in the same commit: all
// four rewritten self-checks planted only shapes the new regex already matched.
//
// The lesson underneath it is the one this file acts on. Text has spellings;
// structure does not. `{ untrusted: 2 }`, `{ "untrusted": 2 }` and
// `{ ["untrusted"]: 2 }` are three strings and one PropertyAssignment whose name
// resolves to `untrusted`. Asking the parser removes the entire class of
// evasion-by-respelling, and it removes it for spellings nobody has thought of
// yet — which is the only kind that matters, because the ones we have thought of
// are the ones already in the regex.
//
// The cost is honest and small: parsing ~300 files takes well under a second,
// and these guards run in the test suite, not on a hot path.
//
// WHAT THIS DOES NOT DO
//
// No type checking and no module resolution — each file is parsed alone. A
// guard here can see that a specifier string ends in `config-dir.scan`; it
// cannot see that some other path resolves to the same file through a symlink or
// a `paths` mapping. Aliasing through an intermediate re-export is likewise
// invisible. Those limits are the same ones the regexes had, and they are stated
// rather than left to be rediscovered.

import ts from "typescript";

/** Parse one file's text. `true` sets parent pointers, which the walkers need. */
export function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every node in the tree, depth-first. */
export function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) {
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
    if (ts.isStringLiteralLike(node)) {
      found.push(node.text);
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
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
      }
      if (mapPairs >= 2 || bareWords >= 2) {
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

  // 5. `x === word` guarding a numeric result, twice or more anywhere in the
  //    file. Counted across the whole file rather than per-statement, because an
  //    if-chain and a ternary chain are the same ordering with different
  //    punctuation and neither has a single containing node worth anchoring to.
  let comparisons = 0;
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
    if (ts.isConditionalExpression(parent) && (isNumber(parent.whenTrue) || isNumber(parent.whenFalse))) {
      comparisons += 1;
    } else if (ts.isIfStatement(parent)) {
      const branch = parent.thenStatement;
      const returnsNumber = ts.isReturnStatement(branch)
        ? isNumber(branch.expression)
        : ts.isBlock(branch) &&
          branch.statements.some((s) => ts.isReturnStatement(s) && isNumber(s.expression));
      if (returnsNumber) {
        comparisons += 1;
      }
    }
  }
  return comparisons >= 2;
}

/** How a property was supplied at a call site or in an object. */
export type SupplyForm = "property" | "shorthand" | "spread-unknown" | "assignment";

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
  for (const node of walk(sourceFile)) {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && propertyKey(property.name) === name) {
          found.push("property");
        } else if (
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === name
        ) {
          found.push("shorthand");
        }
      }
      continue;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      const named =
        (ts.isPropertyAccessExpression(target) && target.name.text === name) ||
        (ts.isElementAccessExpression(target) &&
          ts.isStringLiteralLike(target.argumentExpression) &&
          target.argumentExpression.text === name);
      if (named) {
        found.push("assignment");
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
  for (const node of walk(sourceFile)) {
    if (!ts.isObjectLiteralExpression(node)) {
      continue;
    }
    const supplied = new Set<string>();
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyKey(property.name);
        if (key !== undefined) {
          supplied.add(key);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        supplied.add(property.name.text);
      }
    }
    if (required.every((field) => supplied.has(field))) {
      return true;
    }
  }
  return false;
}
