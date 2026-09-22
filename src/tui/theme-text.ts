// Theme-driven text chunks — the one way a TUI surface colours text.
//
// Why this module exists. OpenTUI's named helpers (`otui.cyan`, `otui.yellow`,
// `otui.green`, `otui.red`, `otui.magenta`) are FIXED, terminal-independent
// hexes out of its CSS-name table (`cyan` = #00FFFF, `yellow` = #FFFF00). Against
// a light palette's own background (#f5f5f5 in `grokday`) those land at contrast
// ratios of 1.15:1 and 1.02:1 — text that is painted but cannot be read — and a
// `/theme` switch cannot repair it either: `recolorThemeTree` (shell-chrome.ts)
// only remaps values matching an OLD palette slot, so a fixed hex survives the
// switch unchanged.
//
// The second half of the same defect is silence. A chunk carrying no `fg`
// renders with OpenTUI's INTENT_DEFAULT, i.e. the TERMINAL's own default
// foreground: on a dark terminal that stays light, over the light background
// keryx itself paints. So even where the old code only wanted `otui.dim`, the
// colour has to be named.
//
// OpenTUI stays a parameter (ADR-0005) — the import below is type-only, so this
// module adds no runtime dependency and is exercisable with a plain fake.
import { getTheme, isLightTheme, roleColor, type TextRole } from "./theme";

type OpenTui = typeof import("@opentui/core");
type Chunk = ReturnType<OpenTui["bold"]>;

/** `text` in `role`'s theme colour — an explicit fg, never the terminal's default. */
export function roleChunk(otui: OpenTui, role: TextRole, text: string): Chunk {
  return otui.fg(roleColor(role))(text);
}

/**
 * Secondary text: labels, hints, retained bodies. De-emphasised by whichever
 * mechanism the ACTIVE palette can actually de-emphasise with. A dark palette
 * keeps OpenTUI's DIM attribute over `text` — the rendering the TUI has always
 * had, now with a known base colour instead of the terminal's own. A light
 * palette cannot use DIM for that: DIM lowers luminance, so dimming a dark
 * foreground (#262626 on #f5f5f5) raises its contrast and makes secondary text
 * LOUDER than the prose around it. There the `muted` slot — the palette's own
 * author-chosen secondary colour — carries the de-emphasis instead.
 */
export function dimChunk(otui: OpenTui, text: string): Chunk {
  return isLightTheme(getTheme().name)
    ? roleChunk(otui, "muted", text)
    : otui.dim(roleChunk(otui, "text", text));
}

/** Emphasised text: the `text` role plus OpenTUI's BOLD attribute. */
export function boldChunk(otui: OpenTui, text: string): Chunk {
  return otui.bold(roleChunk(otui, "text", text));
}
