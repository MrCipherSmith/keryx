// The Telegram rendering mode (flow 395): how a reply is written for Telegram.
//
//   auto   a reply with a table goes as a rich message, any other reply as Telegram HTML (default)
//   rich   every reply goes as a rich message
//   html   every reply goes as Telegram HTML (the 0.3.56 to 0.3.63 behaviour)
//   plain  every reply goes as plain text, a table written as aligned lines
//
// Whatever the mode, a refusal falls back: rich to HTML, HTML to plain. The mode is the
// `rendering` key of the remote config file (`config.ts`). A leaf module: no imports.

export const RENDER_MODES = ["auto", "rich", "html", "plain"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];
export const DEFAULT_RENDER_MODE: RenderMode = "auto";

export function isRenderMode(value: unknown): value is RenderMode {
  return typeof value === "string" && (RENDER_MODES as readonly string[]).includes(value);
}

/** The message naming the valid values; it never echoes the rejected value. */
export const RENDER_MODE_CHOICES = `one of ${RENDER_MODES.join(", ")}`;
