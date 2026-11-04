export type CssRule = { selector: string; decls: Map<string, string>; layered: boolean; media: string[] };

// Flattens styles.css into style rules, tracking whether each sits inside an
// @layer block and which @media heads enclose it (outermost first). jsdom applies no CSS, so the cascade is checked on the parsed
// rules rather than on the spelling of one old bug.
export function parseCssRules(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const stack: { layer: boolean; head: string }[] = [];
  let buffer = "";
  for (const ch of text) {
    if (ch === "{") {
      const head = buffer.trim();
      buffer = "";
      stack.push({ head, layer: head.startsWith("@layer") });
    } else if (ch === "}") {
      const { head } = stack.pop()!;
      if (!head.startsWith("@")) {
        const decls = new Map<string, string>();
        for (const part of buffer.split(";")) {
          const at = part.indexOf(":");
          if (at > 0)
            decls.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
        }
        rules.push({
          selector: head,
          decls,
          layered: stack.some((outer) => outer.layer),
          media: stack.filter((outer) => outer.head.startsWith("@media")).map((outer) => outer.head),
        });
      }
      buffer = "";
    } else buffer += ch;
  }
  return rules;
}

// Selector alternatives after splitting top-level commas and one :is(...) level.
export function selectorAlternatives(selector: string): string[] {
  const top = selector.split(/,(?![^()]*\))/).map((part) => part.trim());
  return top.flatMap((part) => {
    const is = part.match(/^(.*?):is\(([^()]*)\)(.*)$/);
    return is
      ? is[2]!.split(",").map((inner) => `${is[1]}${inner.trim()}${is[3]}`)
      : [part];
  });
}
