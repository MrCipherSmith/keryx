import { revealHidden } from "../session/toolInput";

/** The parts of a DOM element these helpers touch, so they run without a DOM. */
interface TextNode {
  textContent: string | null;
}
interface DataHolder {
  dataset: { raw?: string };
}

/** What the user reads must expose hidden and reordering characters; Copy still gets the raw text. */
export function revealCodeBlock(codeEl: TextNode, wrap: DataHolder): void {
  const rawText = codeEl.textContent ?? "";
  const shown = revealHidden(rawText);
  if (!shown.changed) return;
  codeEl.textContent = shown.text;
  wrap.dataset.raw = rawText;
}

/** The text Copy puts on the clipboard: the raw text a revealed block carries aside, else what it shows. */
export function codeBlockCopyText(wrap: DataHolder | null, codeEl: TextNode | null): string {
  return wrap?.dataset.raw ?? codeEl?.textContent ?? "";
}
