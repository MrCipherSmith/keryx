import type * as TypeScript from "typescript";
import type { DetectorMatch } from "./types";

type Parser = typeof TypeScript;
let parserPromise: Promise<Parser | undefined> | undefined;
async function loadParser(): Promise<Parser | undefined> {
  // Optional precision only: do not bundle a compiler or require it at runtime.
  const packageName = "typescript";
  parserPromise ??= import(packageName).then((module) => module as Parser).catch(() => undefined);
  return parserPromise;
}

/** Filesystem source scans only, never output/redaction or arbitrary text.
 * A property named env is not a reference to a file named .env.
 * Other policies and ambiguous syntax retain their original matches.
 */
export async function filterSourceMatches(
  content: string,
  filePath: string,
  matches: DetectorMatch[],
  getParser: () => Promise<Parser | undefined> = loadParser,
): Promise<{ matches: DetectorMatch[]; warning?: string }> {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filePath) ||
      !matches.some((match) => match.policyId === "egress.private-file-publish")) return { matches };
  try {
    const ts = await getParser();
    if (!ts) return { matches, warning: "source parser unavailable; conservative security matches retained" };
    const tree = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const diagnostics = (tree as TypeScript.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
    if (!diagnostics || diagnostics.length > 0) {
      return { matches, warning: "source syntax unverified; conservative security matches retained" };
    }
    const parser = ts;
    const properties = new Set<string>();
    function visit(node: TypeScript.Node): void {
      if (parser.isPropertyAccessExpression(node) && node.name.text === "env") {
        const end = node.name.getEnd();
        const start = node.name.getStart(tree) - 1;
        if (content.slice(start, end) === ".env") properties.add(`${start}:${end}`);
      }
      parser.forEachChild(node, visit);
    }
    visit(tree);
    return { matches: matches.filter((match) => match.policyId !== "egress.private-file-publish" ||
      !properties.has(`${match.start}:${match.end}`)) };
  } catch {
    return { matches, warning: "source context unavailable; conservative security matches retained" };
  }
}
