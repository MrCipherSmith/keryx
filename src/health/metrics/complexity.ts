// Dependency-free cyclomatic complexity approximation for TS/JS.
//
// This is token-based, not full-AST: source is stripped of comments and string
// literals, then function bodies are located by brace matching (handling TS
// return-type annotations, generics, arrows, and methods) and decision points
// are counted per function. Nested function bodies are counted separately and
// masked from the enclosing function. Full AST precision is a later refinement
// (see spec section 20).

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "do",
  "return",
  "await",
  "yield",
  "typeof",
  "in",
  "of",
  "new",
  "else",
]);

export type FileComplexity = { functions: number[]; max: number };

type FunctionBodyRange = {
  start: number;
  end: number;
};

export function computeComplexity(source: string): FileComplexity {
  const code = stripStringsAndComments(source);
  const ranges = extractFunctionBodyRanges(code);
  if (ranges.length === 0) {
    return { functions: [], max: 0 };
  }
  const functions = ranges.map((range) => 1 + countDecisions(maskNestedFunctionBodies(code, range, ranges)));
  return { functions, max: Math.max(...functions) };
}

function countDecisions(text: string): number {
  let count = 0;
  count += matches(text, /\bif\b/g);
  count += matches(text, /\bfor\b/g);
  count += matches(text, /\bwhile\b/g);
  count += matches(text, /\bcase\b/g);
  count += matches(text, /\bcatch\b/g);
  count += matches(text, /&&/g);
  count += matches(text, /\|\|/g);
  count += matches(text, /\?\?/g);
  // Ternary `?`: exclude optional chaining (`?.`), the `?:` token, and the
  // second `?` of a `??` nullish operator (already counted above).
  count += matches(text, /(?<!\?)\?(?![.?:])/g);
  return count;
}

function matches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function isWs(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function isIdChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function extractFunctionBodyRanges(code: string): FunctionBodyRange[] {
  const ranges: FunctionBodyRange[] = [];
  collectFunctionBodyRanges(code, 0, code.length, ranges);
  return ranges.sort((a, b) => a.start - b.start);
}

function collectFunctionBodyRanges(
  code: string,
  start: number,
  end: number,
  ranges: FunctionBodyRange[],
): void {
  let i = start;

  while (i < end) {
    // Arrow with a block body: `=> {`
    if (code[i] === "=" && code[i + 1] === ">") {
      let j = i + 2;
      while (j < end && isWs(code[j])) j += 1;
      if (code[j] === "{") {
        const bodyEnd = matchBrace(code, j);
        ranges.push({ start: j + 1, end: bodyEnd });
        collectFunctionBodyRanges(code, j + 1, bodyEnd, ranges);
        i = bodyEnd + 1;
        continue;
      }
      i += 2;
      continue;
    }

    if (code[i] === "(") {
      const close = matchParen(code, i);
      if (close > i && isDefinitionName(code, i)) {
        const bodyStart = findBodyBrace(code, close + 1);
        if (bodyStart >= 0) {
          const bodyEnd = matchBrace(code, bodyStart);
          ranges.push({ start: bodyStart + 1, end: bodyEnd });
          collectFunctionBodyRanges(code, bodyStart + 1, bodyEnd, ranges);
          i = bodyEnd + 1;
          continue;
        }
      }
    }

    i += 1;
  }
}

function maskNestedFunctionBodies(
  code: string,
  range: FunctionBodyRange,
  ranges: FunctionBodyRange[],
): string {
  const chars = code.slice(range.start, range.end).split("");
  for (const nested of ranges) {
    if (nested.start <= range.start || nested.end > range.end) {
      continue;
    }
    for (let i = nested.start - range.start; i < nested.end - range.start; i += 1) {
      chars[i] = " ";
    }
  }
  return chars.join("");
}

// True when the `(` at `openIndex` is a function/method parameter list (its name
// is not a control keyword), rather than a control statement or a call.
function isDefinitionName(code: string, openIndex: number): boolean {
  let k = openIndex - 1;
  while (k >= 0 && isWs(code[k])) k -= 1;

  // Skip a generic parameter list: `foo<T>(`.
  if (code[k] === ">") {
    k = matchAngleBackward(code, k);
    if (k < 0) {
      return false;
    }
    k -= 1;
    while (k >= 0 && isWs(code[k])) k -= 1;
  }

  let end = k;
  while (k >= 0 && isIdChar(code[k])) k -= 1;
  const word = code.slice(k + 1, end + 1);
  if (word.length === 0) {
    return false;
  }
  return !CONTROL_KEYWORDS.has(word);
}

// From index `from`, find the `{` that opens a function body, allowing an
// optional `: ReturnType` annotation between `)` and `{`.
function findBodyBrace(code: string, from: number): number {
  let i = from;
  const n = code.length;
  while (i < n && isWs(code[i])) i += 1;
  if (code[i] === "{") {
    return i;
  }
  if (code[i] === ":") {
    // Return-type annotation: advance to the next brace, but bail on tokens
    // that mean this was not a function body (`;`, `,`, `)`, `=`).
    for (let j = i + 1; j < n; j += 1) {
      const char = code[j];
      if (char === "{") {
        return j;
      }
      if (char === ";" || char === ")" || char === "=") {
        return -1;
      }
    }
  }
  return -1;
}

function matchBrace(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

function matchParen(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchAngleBackward(code: string, closeIndex: number): number {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (code[i] === ">") depth += 1;
    else if (code[i] === "<") {
      depth -= 1;
      if (depth === 0) return i;
    } else if (code[i] === ";" || code[i] === "{" || code[i] === "}") {
      return -1;
    }
  }
  return -1;
}

function stripStringsAndComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}
