import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// Static guard: no TUI runtime source may paint with OpenTUI's fixed colour
// helpers.
//
// `otui.cyan`/`otui.yellow`/`otui.green`/`otui.red`/`otui.magenta` are NOT
// theme-aware: they resolve through OpenTUI's CSS-name table to constant hexes
// (`cyan` = #00FFFF, `yellow` = #FFFF00). Against a light palette's own
// background (#f5f5f5 in `grokday`) that is a contrast ratio of 1.15:1 and
// 1.02:1 — text that is painted but cannot be read, which is exactly the
// "bright cyan commands in the feed" report this guard exists for. A `/theme`
// switch cannot repair it either, because `recolorThemeTree`
// (`src/tui/shell-chrome.ts`) only remaps values matching an OLD palette slot.
//
// Every such site now goes through `src/tui/theme-text.ts` (`roleChunk` /
// `dimChunk` / `boldChunk`), which names a colour from the ACTIVE theme. The
// OTHER half of the same defect — text painted with no `fg` at all, drawn in the
// terminal's own default foreground over keryx's background — is behavioural
// and is pinned by the light-theme frame test in `src/tui/tui-shell.test.ts`.

const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ROOT = path.join(SRC_ROOT, "..");
const TUI_ROOT = path.join(SRC_ROOT, "tui");

/** Runtime (non-test) `.ts` files under `dir`, recursively. */
async function runtimeTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await runtimeTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

test("no TUI runtime source paints with OpenTUI's fixed colour helpers", async () => {
  const files = await runtimeTsFiles(TUI_ROOT);
  expect(files.length).toBeGreaterThan(0);

  const fixed = /\botui\.(cyan|yellow|green|red|blue|magenta|white|black|bright[A-Z]\w*)\s*\(/;
  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      // Code only: a prose mention in a comment is how the ban is explained.
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (fixed.test(code)) {
        violations.push(`${path.relative(PKG_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
// end of tui-theme guard
