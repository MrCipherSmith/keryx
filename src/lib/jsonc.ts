/**
 * Parse JSON-with-comments: `//` and `/* *\/` comments and trailing commas,
 * the dialect editors such as VS Code accept in their own config files.
 *
 * Only for READING a file keryx did not write. Writing the value back with
 * `JSON.stringify` would drop the user's comments, so a writer must keep using
 * strict JSON and refuse a file that needs this.
 *
 * Comments and trailing commas are removed in one linear, string-aware pass,
 * then the result goes through `JSON.parse`, so anything else invalid still
 * throws.
 */
export function parseJsonc(source: string): unknown {
  return JSON.parse(stripJsonc(source));
}

function stripJsonc(source: string): string {
  const out: string[] = [];
  // Index in `out` of a comma that is dropped if the next significant
  // character closes an object or array.
  let pendingComma = -1;
  let inString = false;
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (inString) {
      out.push(char);
      if (char === "\\" && i + 1 < source.length) {
        out.push(source[i + 1]!);
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      i += 1;
      continue;
    }
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out.push(" ");
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      out.push(char);
      i += 1;
      continue;
    }
    if ((char === "}" || char === "]") && pendingComma !== -1) out[pendingComma] = "";
    pendingComma = -1;
    if (char === ",") pendingComma = out.length;
    if (char === '"') inString = true;
    out.push(char);
    i += 1;
  }
  return out.join("");
}
