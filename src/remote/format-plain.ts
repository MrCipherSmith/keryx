// The plain-text form of one message part (flow 395): what goes out when a message is refused as
// rich and as HTML, or when the rendering mode is `plain`.
//
// It is the part itself, byte for byte, with one exception: a Markdown table is written as the
// same aligned monospace lines the HTML `<pre>` block holds, so a plain message never shows raw
// pipes either. Text without a table comes back untouched (the 0.3.63 behaviour).

import { closesFence, fenceOpening } from "./format";
import { renderTableLines, tableAt } from "./format-table";

export function renderPlainText(part: string): string {
  if (!part.includes("|")) {
    return part;
  }
  const lines = part.split("\n");
  const bare = lines.map((entry) => entry.replace(/\r$/, ""));
  const out: string[] = [];
  let fence: ReturnType<typeof fenceOpening>;
  let changed = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        fence = undefined;
      }
      out.push(line);
      index += 1;
      continue;
    }
    fence = fenceOpening(line);
    const found = fence === undefined ? tableAt(bare, index) : undefined;
    if (found === undefined) {
      out.push(line);
      index += 1;
      continue;
    }
    out.push(...renderTableLines(found.table));
    changed = true;
    index = found.end;
  }
  return changed ? out.join("\n") : part;
}
