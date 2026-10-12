// The slice of the Telegram Bot API 10.3 rich-message objects keryx writes (flow 395).
//
// Source: https://core.telegram.org/bots/api, anchors `inputrichmessage`, `inputrichblock*`,
// `inputrichblocklistitem`, `richblocktablecell` and the `richtext*` objects. keryx sends
// `blocks` (never `markdown` or `html`): a block list is data, so text from the model cannot
// add markup, which is the same guarantee the HTML renderer gives by escaping.
// docs/requirements/keryx-telegram-rendering/spike.md records each fact with its anchor.

/** `RichText`: a string, an array of RichText, or a typed object. Only the types keryx writes. */
export type RichText = string | RichTextNode | RichText[];

export type RichTextNode =
  | { type: "bold" | "italic" | "strikethrough" | "code"; text: RichText }
  | { type: "url"; text: RichText; url: string };

export interface InputRichBlockListItem {
  blocks: InputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  /** Ordered lists: the number the item shows. */
  value?: number;
  /** Ordered lists: `"1"` is decimal numbers. */
  type?: "1";
}

export interface RichBlockTableCell {
  text?: RichText;
  is_header?: true;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
}

export type InputRichBlock =
  | { type: "paragraph"; text: RichText }
  | { type: "heading"; text: RichText; size: number }
  | { type: "pre"; text: RichText; language?: string }
  | { type: "divider" }
  | { type: "list"; items: InputRichBlockListItem[] }
  | { type: "blockquote"; blocks: InputRichBlock[] }
  | { type: "expandable_blockquote"; text: RichText }
  | { type: "table"; cells: RichBlockTableCell[][]; is_bordered?: true };

/** `InputRichMessage`: exactly one of `html`, `markdown`, `blocks`; keryx uses `blocks`. */
export interface InputRichMessage {
  blocks: InputRichBlock[];
}

/** Documented limits of a rich message (anchor `rich-message-limits`). */
export const RICH_LIMITS = {
  characters: 32768,
  blocks: 500,
  nesting: 16,
  tableColumns: 20,
} as const;
