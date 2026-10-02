// The fixed sample reply of flow 395, rendered in every mode with no network.
//
// It is what `keryx remote format-sample` prints, and it is the reply the operator judges in
// Telegram for the live acceptance: the same text, so what the terminal shows is what the chat is
// expected to show. Rendering here is the very code the outbound path runs (`formatReply` for the
// split, `firstStep` for the mode, `renderTelegramHtml` / `renderRichMessage` / `renderPlainText`
// for the text), only without the Bot API call, so a sample cannot drift from a real send.
// (`format-sample.ts` is the older script that shows how plain replies are split; this one shows
// how a reply with a table and lists is written in each mode.)

import { formatReply } from "./format";
import { checkTelegramHtml, renderTelegramHtml } from "./format-html";
import { renderPlainText } from "./format-plain";
import { renderRichMessage, RichRenderError } from "./format-rich";
import { firstStep } from "./rendering";
import { RENDER_MODES, type RenderMode } from "./rendering-mode";
import type { InputRichMessage } from "./rich-types";

/** Every construct flow 395 handles, in one reply a person would plausibly get from the agent. */
export const SAMPLE_REPLY = [
  "## Release check",
  "",
  "Everything below is **one reply**: a table, lists, a rule and some `code`.",
  "",
  "| Step | Result | Time |",
  "|:-----|:------:|-----:|",
  "| build | `ok` | 41s |",
  "| unit tests | ok | 2m 08s |",
  "| smoke | **failed** | 12s |",
  "",
  "1. Fix the smoke test",
  "2. Re-run the release check",
  "   - on the branch first",
  "   - then on main",
  "",
  "- [x] changelog written",
  "- [ ] tag pushed",
  "",
  "---",
  "",
  "> The tag is pushed by the operator, not by the agent.",
].join("\n");

export type SamplePartKind = "rich" | "html" | "plain";

export interface SamplePart {
  /** The (i/n) part number, 1-based. */
  index: number;
  total: number;
  /** How this part would be sent in this mode. */
  kind: SamplePartKind;
  /** The text sent for `html` and `plain`; for `rich`, a count of the blocks. */
  text: string;
  /** The `rich_message` body, for `rich` only. */
  richMessage?: InputRichMessage;
  /** Set when the part could not go the way the mode asks. */
  note?: string;
}

export interface SampleRendering {
  mode: RenderMode;
  parts: SamplePart[];
}

interface CountedBlock {
  type: string;
  items?: readonly { blocks?: readonly CountedBlock[] }[];
}

function describeBlocks(message: InputRichMessage): string {
  const counts = new Map<string, number>();
  const walk = (blocks: readonly CountedBlock[]): void => {
    for (const block of blocks) {
      counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
      for (const item of block.items ?? []) {
        walk(item.blocks ?? []);
      }
    }
  };
  walk(message.blocks as unknown as readonly CountedBlock[]);
  return [...counts.entries()].map(([type, count]) => `${count} ${type}`).join(", ");
}

function htmlOrPlain(part: string): { kind: "html" | "plain"; text: string; note?: string } {
  const html = renderTelegramHtml(part);
  const checked = checkTelegramHtml(html);
  return checked.ok
    ? { kind: "html", text: checked.text }
    : { kind: "plain", text: renderPlainText(part), note: `HTML refused locally (${checked.reason}); plain text` };
}

export function renderSample(mode: RenderMode, reply: string = SAMPLE_REPLY): SampleRendering {
  const pieces = formatReply(reply);
  const parts = pieces.map((piece, position): SamplePart => {
    const base = { index: position + 1, total: pieces.length };
    const step = firstStep(mode, piece);
    if (step === "plain") {
      return { ...base, kind: "plain", text: renderPlainText(piece) };
    }
    if (step === "rich") {
      try {
        const richMessage = renderRichMessage(piece);
        return { ...base, kind: "rich", text: describeBlocks(richMessage), richMessage };
      } catch (error) {
        if (!(error instanceof RichRenderError)) {
          throw error;
        }
        return { ...base, ...htmlOrPlain(piece), note: `not renderable as a rich message (${error.message}); HTML instead` };
      }
    }
    return { ...base, ...htmlOrPlain(piece) };
  });
  return { mode, parts };
}

export function renderAllSamples(reply: string = SAMPLE_REPLY): SampleRendering[] {
  return RENDER_MODES.map((mode) => renderSample(mode, reply));
}

const MODE_HEADLINE: Record<RenderMode, string> = {
  auto: "auto: rich where there is a table, otherwise HTML",
  rich: "rich: every reply as a rich message",
  html: "html: every reply as Telegram HTML",
  plain: "plain: every reply as plain text",
};

/** The text `keryx remote format-sample` prints for the chosen renderings. */
export function formatSampleText(renderings: readonly SampleRendering[], options: { full?: boolean } = {}): string {
  const lines: string[] = ["Sample reply (source):", "", ...SAMPLE_REPLY.split("\n").map((line) => `  ${line}`), ""];
  for (const rendering of renderings) {
    lines.push(`=== ${MODE_HEADLINE[rendering.mode]} ===`);
    for (const part of rendering.parts) {
      lines.push(`--- part ${part.index}/${part.total}, sent as ${part.kind}${part.note === undefined ? "" : ` (${part.note})`} ---`);
      if (part.kind === "rich" && options.full === true) {
        lines.push(JSON.stringify(part.richMessage, null, 2));
      } else if (part.kind === "rich") {
        lines.push(`rich blocks: ${part.text}`);
      } else {
        lines.push(part.text);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
