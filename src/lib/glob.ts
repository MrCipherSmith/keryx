/** Translate one glob (`src/core/**`, `*.ts`, `**\/*.test.ts`) into an anchored RegExp. `**` matches across path separators; `*` does not. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
      // Swallow one following slash so `src/**/*.ts` and `src/**.ts` behave alike.
      if (glob[i + 1] === "/") i += 1;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

/** Expand `{a,b}` alternatives (nesting allowed) into plain globs: `src/**\/*.{ts,tsx}` becomes two. */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === "," && depth === 1) commas.push(i);
  }
  if (close === -1) return [glob];
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let k = 0; k < bounds.length - 1; k += 1) {
    const alternative = glob.slice(bounds[k]! + 1, bounds[k + 1]!);
    for (const expanded of expandBraces(`${head}${alternative}${tail}`)) out.push(expanded);
  }
  return out;
}

/** True when `filePath` matches any glob, braces included. */
export function matchesAnyGlobWithBraces(filePath: string, globs: readonly string[]): boolean {
  return matchesAnyGlob(filePath, globs.flatMap(expandBraces));
}
