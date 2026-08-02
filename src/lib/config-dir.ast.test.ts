// The AST guard primitives, tested against every spelling that defeated a regex.
//
// This is the numerator for four guards at once. Each case below is a real
// evasion found by review — most of them found AFTER the regex had been widened
// for the previous one.
//
// The header here used to say the list was "closed by construction rather than
// by enumeration". It is not. A node-shape matcher enumerates node shapes, and
// the round after that sentence shipped, twelve ordinary spellings defeated all
// four guards. `Object.assign`, a spread, `Object.fromEntries`,
// `Object.defineProperty`, a static class field and a chained `Map.set()` are
// six structures for a handful of semantic acts.
//
// `INVISIBLE` marks a form the REGEX could not see. The gaps in the current
// implementation are at the bottom of this file, as tests that assert they are
// still gaps — which is the only kind of self-check that cannot decay into a
// restatement of the implementation's own branch list.

import { describe, expect, test } from "bun:test";
import {
  constructsWith,
  declaresRanking,
  loadsModule,
  moduleSpecifiers,
  parse,
  propertyKey,
  suppliesProperty,
} from "./config-dir.ast";

const POLICY_WORDS = [
  "read-only",
  "trusted-local",
  "untrusted",
  "deny",
  "ask",
  "allow",
  "not-required",
  "required-fail-closed",
] as const;

function ranks(source: string): boolean {
  return declaresRanking(parse("probe.ts", source), POLICY_WORDS);
}

describe("moduleSpecifiers / loadsModule — every loading position and spelling", () => {
  test("the four positions a module can be loaded from", () => {
    const source = `
      import { code } from "./config-dir.scan";
      export { other } from "../lib/other";
      const a = require("./required-thing");
      const b = await import("./dynamic-thing");
      import "./side-effect-only";
    `;
    expect(moduleSpecifiers(parse("p.ts", source)).sort()).toEqual([
      "../lib/other",
      "./config-dir.scan",
      "./dynamic-thing",
      "./required-thing",
      "./side-effect-only",
    ]);
  });

  test("an extension does not hide the module — the spelling that defeated the regex", () => {
    // The regex required the closing quote immediately after the basename, so
    // ANY extension was invisible. A reviewer planted `src/lib/scanner-user.ts`
    // with exactly this import and the whole suite stayed green — test
    // scaffolding wired into a production module. And `.ts` is not exotic here:
    // `config-dir.readers.test.ts` writes `await import("…/shell-config.ts")` in
    // four places. It is the file's own idiom.
    for (const specifier of [
      "./config-dir.scan",
      "./config-dir.scan.ts", // INVISIBLE to the regex
      "./config-dir.scan.js", // INVISIBLE
      "../lib/config-dir.scan.ts", // INVISIBLE
      "../../lib/config-dir.scan",
    ]) {
      const source = `import { code } from "${specifier}";`;
      expect({ specifier, loads: loadsModule(parse("p.ts", source), "config-dir.scan") }).toEqual({
        specifier,
        loads: true,
      });
    }
  });

  test("every loading position finds it, not just `from`", () => {
    for (const [form, source] of [
      ["static", 'import { code } from "./config-dir.scan";'],
      ["re-export", 'export { code } from "./config-dir.scan";'],
      ["side-effect", 'import "./config-dir.scan";'], // INVISIBLE to the regex
      ["require", 'const m = require("./config-dir.scan.js");'],
      ["dynamic", 'const m = await import("../lib/config-dir.scan.ts");'],
      ["template", "const m = await import(`./config-dir.scan`);"], // INVISIBLE
      ["import-equals", 'import m = require("./config-dir.scan");'],
    ] as const) {
      expect({ form, loads: loadsModule(parse("p.ts", source), "config-dir.scan") }).toEqual({
        form,
        loads: true,
      });
    }
  });

  test("it does NOT fire on a mention, a comment, or a different module", () => {
    // The other half. A guard that reported everything would pass every
    // assertion above.
    for (const [form, source] of [
      ["comment", "// see ./config-dir.scan for what the scan can do"],
      ["string", 'const help = "read ./config-dir.scan";'],
      ["similar", 'import { x } from "./config-dir";'],
      ["prefix-only", 'import { x } from "./config-dir.scanner";'],
      ["substring", 'import { x } from "./not-config-dir.scan-helper";'],
    ] as const) {
      expect({ form, loads: loadsModule(parse("p.ts", source), "config-dir.scan") }).toEqual({
        form,
        loads: false,
      });
    }
  });
});

describe("declaresRanking — an ordering, in any of its shapes", () => {
  test("the object-literal forms, including the key spellings the regex could not see", () => {
    for (const [form, source] of [
      ["bare", "const R = { untrusted: 2, allow: 1 };"],
      ["quoted", 'const R = { "read-only": 0, "trusted-local": 1 };'], // INVISIBLE to `code()`
      ["computed", 'const R = { ["read-only"]: 0, ["untrusted"]: 2 };'], // INVISIBLE
      ["multi-digit", "const R = { untrusted: 10, allow: 20 };"],
      ["negative", "const R = { deny: -1, allow: 1 };"],
      ["mixed", 'const R = { deny: 0, "ask": 1, ["allow"]: 2 };'],
    ] as const) {
      expect({ form, ranks: ranks(source) }).toEqual({ form, ranks: true });
    }
  });

  test("the forms that write no object at all", () => {
    for (const [form, source] of [
      ["map", 'const R = new Map([["deny", 0], ["ask", 1], ["allow", 2]]);'], // INVISIBLE
      // An array is an ordering only when a POSITION is read out of it.
      ["array-indexOf", 'const ORDER = ["read-only", "trusted-local", "untrusted"];\nORDER.indexOf(v);'],
      ["array-index", 'const ORDER = ["read-only", "untrusted"];\nconst r = ORDER[i];'],
      ["switch", 'function r(v){ switch(v){ case "deny": return 0; case "allow": return 2; } }'],
      [
        "if-chain",
        'function r(v){ if (v === "read-only") return 0; if (v === "trusted-local") return 1; return 2; }',
      ], // INVISIBLE — still green after the last widening
      [
        "ternary",
        'const r = (v) => v === "deny" ? 0 : v === "ask" ? 1 : 2;',
      ], // INVISIBLE
    ] as const) {
      expect({ form, ranks: ranks(source) }).toEqual({ form, ranks: true });
    }
  });

  test("one pair is not an ordering", () => {
    // Two or more, always. A single `{ deny: 0 }` is a flag, and a guard that
    // fired on it would be noise and would be switched off — which is the way
    // guards actually die.
    for (const [form, source] of [
      ["one-pair", "const R = { deny: 0 };"],
      ["one-case", 'function r(v){ switch(v){ case "deny": return 0; } }'],
      ["one-comparison", 'function r(v){ if (v === "deny") return 0; return 1; }'],
      ["one-word-array", 'const ORDER = ["untrusted"];'],
    ] as const) {
      expect({ form, ranks: ranks(source) }).toEqual({ form, ranks: false });
    }
  });

  test("it does not fire on prose, on non-vocabulary, or on a non-numeric map", () => {
    for (const [form, source] of [
      ["comment", "// the ordering is read-only < trusted-local < untrusted"],
      ["other-words", "const R = { alpha: 0, beta: 1, gamma: 2 };"],
      ["non-numeric", 'const R = { deny: "no", allow: "yes" };'],
      ["type-only", "interface R { deny: number; allow: number }"],
      ["array-of-other", 'const X = ["alpha", "beta"];'],
      // A membership SET, not an ordering. Reporting this was a false positive
      // on ordinary code, and a guard that fires on a validation list gets
      // switched off by whoever trips on it first.
      ["membership-set", 'const OUTCOMES = ["deny", "ask", "allow"] as const;\nOUTCOMES.includes(v);'],
    ] as const) {
      expect({ form, ranks: ranks(source) }).toEqual({ form, ranks: false });
    }
  });
});

describe("suppliesProperty — supplying a value, not declaring a field", () => {
  test("every way a value is passed", () => {
    for (const [form, source] of [
      ["inline", "createSubmitTurn({ profile, containmentAvailable: () => true });"],
      ["shorthand", "createSubmitTurn({ profile, containmentAvailable });"],
      ["quoted", 'createSubmitTurn({ "containmentAvailable": probe });'], // INVISIBLE
      ["computed", 'createSubmitTurn({ ["containmentAvailable"]: probe });'], // INVISIBLE
      ["assignment", "opts.containmentAvailable = () => true;"], // INVISIBLE
      ["index-assignment", 'opts["containmentAvailable"] = () => true;'], // INVISIBLE
    ] as const) {
      const supplied = suppliesProperty(parse("p.ts", source), "containmentAvailable");
      expect({ form, supplied: supplied.length > 0 }).toEqual({ form, supplied: true });
    }
  });

  test("a DECLARATION is not a supply, and neither is a read", () => {
    // The distinction the regex carried with a `?` and carries here with a node
    // kind. A destructuring read is an ObjectBindingPattern, which is simply not
    // an ObjectLiteralExpression — the two cannot be confused.
    for (const [form, source] of [
      ["optional-field", "interface D { containmentAvailable?: () => boolean }"],
      ["required-field", "interface D { containmentAvailable: () => boolean }"],
      ["type-alias", "type D = { containmentAvailable: () => boolean };"],
      ["destructure", "const { containmentAvailable } = seams;"],
      ["destructure-default", "const { containmentAvailable = probe } = seams;"],
      ["read", "if (deps.containmentAvailable !== undefined) run();"],
      ["comment", "// containmentAvailable: the seam, named in a comment"],
    ] as const) {
      const supplied = suppliesProperty(parse("p.ts", source), "containmentAvailable");
      expect({ form, supplied: supplied.length > 0 }).toEqual({ form, supplied: false });
    }
  });

  test("the form is reported, so a guard can exempt one and not another", () => {
    expect(suppliesProperty(parse("p.ts", "f({ seam: x });"), "seam")).toEqual(["property"]);
    expect(suppliesProperty(parse("p.ts", "f({ seam });"), "seam")).toEqual(["shorthand"]);
    expect(suppliesProperty(parse("p.ts", "o.seam = x;"), "seam")).toEqual(["assignment"]);
  });
});

describe("constructsWith — building a value, not declaring its type", () => {
  test("the value's shape does not matter, including a call", () => {
    for (const [form, source] of [
      ["inline", 'const p = { trustMode: "x", requiredControls: { isolation: "y" } };'],
      ["named", 'const p = { trustMode: "x", requiredControls: controls };'],
      ["call", 'const p = { trustMode: "x", requiredControls: buildControls() };'], // INVISIBLE
      ["quoted-keys", 'const p = { "trustMode": "x", "requiredControls": c };'], // INVISIBLE
      ["spaced", 'const p = { trustMode : "x", requiredControls : c };'], // INVISIBLE
      ["shorthand", "const p = { trustMode, requiredControls };"],
    ] as const) {
      expect({
        form,
        constructs: constructsWith(parse("p.ts", source), ["trustMode", "requiredControls"]),
      }).toEqual({ form, constructs: true });
    }
  });

  test("a type declaration is not a construction, and a partial object is not either", () => {
    for (const [form, source] of [
      ["interface", "interface P { trustMode: string; requiredControls: RC }"],
      ["type-alias", "type P = { trustMode: string; requiredControls: RC };"],
      ["only-one", 'const p = { trustMode: "x" };'],
      ["only-other", "const p = { requiredControls: c };"],
    ] as const) {
      expect({
        form,
        constructs: constructsWith(parse("p.ts", source), ["trustMode", "requiredControls"]),
      }).toEqual({ form, constructs: false });
    }
  });
});

describe("propertyKey", () => {
  test("a computed key that is not a literal is unknowable, and says so", () => {
    // It must answer `undefined` rather than guess. A guard that guessed here
    // would report a file for a property it cannot prove is there.
    const literal = parse("p.ts", 'const o = { [dynamicName]: 1, plain: 3, "quoted": 4 };');
    // Driven through the public surface rather than by reaching for a node.
    expect(suppliesProperty(literal, "plain")).toEqual(["property"]);
    expect(suppliesProperty(literal, "quoted")).toEqual(["property"]);
    // `[dynamicName]` is not knowable without running the program, so the key
    // is not claimed to be anything — including not claimed to be the
    // identifier's own text, which is the guess a careless version would make.
    expect(suppliesProperty(literal, "dynamicName")).toEqual([]);
    expect(propertyKey(undefined)).toBeUndefined();
  });
});

describe("what these predicates DO NOT catch", () => {
  // This set and the KNOWN GAPS list at the top of `config-dir.ast.ts` must be
  // the SAME set. A review found they were not: the counts coincided at seven
  // and the memberships did not — the prose named a builder function (which is
  // caught) and prebuilt options (untested), and omitted `createRequire`
  // (tested). A gap list whose evidence is a different list is a gap list with
  // no evidence.
  // The inversion the recorded lesson asks for, and the thing three rounds of
  // self-checks got wrong: these plant shapes the CURRENT implementation is
  // known not to handle, rather than replaying its own branch list.
  //
  // They assert `false`. That is deliberate and it is not a test of nothing —
  // it is the gap list at the top of `config-dir.ast.ts` made executable. If one
  // of these starts returning `true`, someone closed a gap and this file should
  // say so; if one silently stays `false` while the header claims otherwise, the
  // header is lying again.

  test("a specifier that is not a string literal is invisible", () => {
    for (const [form, source] of [
      ["concatenated", 'const M = "./config-dir" + ".scan"; await import(M);'],
      ["template-with-substitution", "const P='scan'; await import(`./config-dir.${P}`);"],
      ["createRequire-renamed", 'const load = createRequire(import.meta.url); load("./config-dir.scan");'],
    ] as const) {
      expect({ form, seen: loadsModule(parse("p.ts", source), "config-dir.scan") }).toEqual({
        form,
        seen: false,
      });
    }
    // The closure for the question that matters — does it SHIP — is
    // `production-graph.test.ts`, which asks the bundler and does not care how
    // the specifier was spelled.
  });

  test("import.meta.require is invisible — the header declares it, so it is tested", () => {
    const source = 'const m = import.meta.require("./config-dir.scan");';
    expect(loadsModule(parse("p.ts", source), "config-dir.scan")).toBe(false);
  });

  test("a class instance is not seen as a construction", () => {
    // The builder function that used to sit beside this entry is CAUGHT; only
    // the class form is a gap, and this is what makes that distinction hold.
    const asClass = "class P { trustMode = t; requiredControls = c; }";
    expect(constructsWith(parse("p.ts", asClass), ["trustMode", "requiredControls"])).toBe(false);
    // The control, and the correction: a builder IS caught.
    const builder = "function build(){ return { trustMode: t, requiredControls: c }; }";
    expect(constructsWith(parse("p.ts", builder), ["trustMode", "requiredControls"])).toBe(true);
  });

  test("a prebuilt options object passed by name is invisible", () => {
    const source = "const opts = base(); opts.containmentAvailable = f; createSubmitTurn(opts);";
    // The assignment IS seen; what is not is the same seam set in another file
    // and passed here as a whole object.
    expect(suppliesProperty(parse("p.ts", source), "containmentAvailable")).toEqual(["assignment"]);
    const opaque = "createSubmitTurn(prebuiltSeams);";
    expect(suppliesProperty(parse("p.ts", opaque), "containmentAvailable")).toEqual([]);
  });

  test("a ranking split across functions is invisible — the gap this round created", () => {
    // Scoping the comparison counter to one function silenced a false positive
    // on two unrelated helpers. This is what it cost, and it went undeclared
    // until a review found it.
    const split =
      'function a(v: string){ if (v === "read-only") return 0; return 9; }\n' +
      'function b(v: string){ if (v === "untrusted") return 2; return 9; }';
    expect(ranks(split)).toBe(false);
    // The same two comparisons inside ONE function are still caught.
    const together =
      'function r(v: string){ if (v === "read-only") return 0; if (v === "untrusted") return 2; return 1; }';
    expect(ranks(together)).toBe(true);
  });

  test("a ranking whose numbers are not literals, or whose schema is arbitrary, is invisible", () => {
    for (const [form, source] of [
      ["named-constants", "const LOW=0,HIGH=2; const R = { deny: LOW, allow: HIGH };"],
      ["row-table", 'const O = [{mode:"read-only",rank:0},{mode:"untrusted",rank:2}]; O.find(r=>r.mode===m)?.rank;'],
      ["static-class-fields", 'class O { static readonly "not-required" = 0; static readonly "required-fail-closed" = 1; }'],
      ["chained-map-set", 'const M = new Map<string,number>().set("read-only",0).set("untrusted",2);'],
    ] as const) {
      expect({ form, seen: ranks(source) }).toEqual({ form, seen: false });
    }
  });
});

describe("every predicate change this round made, pinned", () => {
  // A review found the round's own overstated commit: eight behaviour changes
  // shipped — three false-positive fixes and five closed gaps — and SEVEN of the
  // eight could be deleted with all 138 guard tests green. The prose described
  // each one; nothing exercised them.
  //
  // That is the shape this whole exercise is about, applied by the commit whose
  // subject was "an honest gap list". A fix with no test is a claim, and the
  // round spent its own argument on claims.

  test("FP: the comparison counter is scoped to one function", () => {
    // Two unrelated helpers, one comparison each. File-wide counting reported
    // them as an ordering chain.
    const split =
      'export function exitCodeFor(o: string): number { if (o === "deny") { return 1; } return 0; }\n' +
      'export function columnWidth(k: string): number { if (k === "allow") { return 8; } return 4; }';
    expect(ranks(split)).toBe(false);
    // ...and a real chain inside ONE function is still caught, so the scoping
    // did not simply switch the branch off.
    const together =
      'function r(v: string): number { if (v === "deny") { return 0; } if (v === "allow") { return 2; } return 1; }';
    expect(ranks(together)).toBe(true);
  });

  test("FP: a projection is not a construction, and a real build still is", () => {
    const projection =
      "export function evidence(p: PolicyProfile) { return { trustMode: p.trustMode, requiredControls: p.requiredControls }; }";
    expect(constructsWith(parse("p.ts", projection), ["trustMode", "requiredControls"])).toBe(false);
    // The control: same two keys, values NOT all read off one object.
    const built = 'const p = { trustMode: "untrusted", requiredControls: buildControls() };';
    expect(constructsWith(parse("p.ts", built), ["trustMode", "requiredControls"])).toBe(true);
    // And a projection off two different objects is a construction again.
    const mixed = "const p = { trustMode: a.trustMode, requiredControls: b.requiredControls };";
    expect(constructsWith(parse("p.ts", mixed), ["trustMode", "requiredControls"])).toBe(true);
  });

  test("gap: a spread carries keys this file cannot enumerate", () => {
    // Deliberate over-reach in the reporting direction, and the case where the
    // AST version was WEAKER than the regex it replaced.
    expect(constructsWith(parse("p.ts", 'const p = { ...base, trustMode: "untrusted" };'), ["trustMode", "requiredControls"])).toBe(true);
    expect(constructsWith(parse("p.ts", "const p = { ...base, requiredControls: c };"), ["trustMode", "requiredControls"])).toBe(true);
    // A spread carrying NEITHER required name is not a profile construction.
    expect(constructsWith(parse("p.ts", "const p = { ...base, other: 1 };"), ["trustMode", "requiredControls"])).toBe(false);
  });

  test("gap: Object.assign unions its argument literals", () => {
    const split = 'const p = Object.assign({ trustMode: "untrusted" }, { requiredControls: c });';
    expect(constructsWith(parse("p.ts", split), ["trustMode", "requiredControls"])).toBe(true);
    // Only one half present is not a construction.
    const half = 'const p = Object.assign({ trustMode: "untrusted" }, { other: 1 });';
    expect(constructsWith(parse("p.ts", half), ["trustMode", "requiredControls"])).toBe(false);
  });

  test("gap: Object.defineProperty supplies a seam", () => {
    const supplied = 'Object.defineProperty(o, "containmentAvailable", { value: () => true });';
    expect(suppliesProperty(parse("p.ts", supplied), "containmentAvailable")).toEqual(["assignment"]);
    // A different property name is not this seam.
    const other = 'Object.defineProperty(o, "somethingElse", { value: 1 });';
    expect(suppliesProperty(parse("p.ts", other), "containmentAvailable")).toEqual([]);
  });

  test("gap: Object.fromEntries supplies a seam", () => {
    const supplied = 'Object.fromEntries([["localBaseline", lower]]);';
    expect(suppliesProperty(parse("p.ts", supplied), "localBaseline")).toEqual(["property"]);
    const other = 'Object.fromEntries([["unrelated", x]]);';
    expect(suppliesProperty(parse("p.ts", other), "localBaseline")).toEqual([]);
  });

  test("gap: a computed key named by a local const supplies a seam", () => {
    const viaConst = 'const SEAM = "containmentAvailable";\nconst o = { [SEAM]: () => true };';
    expect(suppliesProperty(parse("p.ts", viaConst), "containmentAvailable")).toEqual(["property"]);
    // A const holding a DIFFERENT name is not this seam — the one-hop lookup
    // must resolve the value, not merely notice that a const exists.
    const wrongConst = 'const SEAM = "somethingElse";\nconst o = { [SEAM]: () => true };';
    expect(suppliesProperty(parse("p.ts", wrongConst), "containmentAvailable")).toEqual([]);
  });
});
