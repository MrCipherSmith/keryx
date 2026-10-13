// Flow 395: `/rendering [auto|rich|html|plain]`, how replies are written for Telegram.
//
// Bare `/rendering` prints the mode in effect and what each mode does; with a mode it saves it in
// the remote config file, which serve reads before each message part, so the change applies at once
// with no restart. The `/settings` row's buttons run this same line, so a press and the typed
// command cannot disagree.

import { readRenderingSetting, writeRenderingMode } from "../remote/rendering-config";
import { DEFAULT_RENDER_MODE, RENDER_MODES, type RenderMode } from "../remote/rendering-mode";

export const RENDERING_COMMAND = "/rendering";
export const RENDERING_SUMMARY = `How Telegram replies are written: ${RENDERING_COMMAND} [${RENDER_MODES.join("|")}]`;

export function isRenderingCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === RENDERING_COMMAND;
}

export const RENDERING_MEANING: Record<RenderMode, string> = {
  auto: "a reply with a table goes as a rich message, any other reply as HTML",
  rich: "every reply goes as a rich message",
  html: "every reply goes as Telegram HTML",
  plain: "every reply goes as plain text, a table as aligned lines",
};

export const RENDERING_FALLBACK_NOTE = "Whatever the mode, a refused message is resent once one step down: rich, then HTML, then plain text.";

/** The text to print. Never throws. */
export function runRenderingCommand(argText: string, dir?: string): string {
  const arg = argText.trim();
  try {
    if (arg.length > 0) {
      const saved = writeRenderingMode(arg, dir);
      return saved.ok
        ? `Telegram rendering: ${saved.value} (${RENDERING_MEANING[saved.value]}). Saved; it applies to the next message.\n`
        : `${RENDERING_COMMAND}: ${saved.reason}\n`;
    }
    const current = readRenderingSetting(dir);
    const where =
      current.source === "config" ? "saved in the remote config" : current.saveable ? `default (${DEFAULT_RENDER_MODE})` : "default, remote control is not set up yet";
    return [
      `Telegram rendering: ${current.mode} (${where})`,
      ...RENDER_MODES.map((mode) => `  ${mode === current.mode ? "*" : " "} ${mode}: ${RENDERING_MEANING[mode]}`),
      RENDERING_FALLBACK_NOTE,
      `Usage: ${RENDERING_COMMAND} [${RENDER_MODES.join("|")}]`,
      "",
    ].join("\n");
  } catch (error) {
    return `${RENDERING_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}
