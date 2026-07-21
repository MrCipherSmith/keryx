import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// Static guard (flow 115 / AC1): `alignSelf` must not appear on any renderable
// the TUI mounts.
//
// Why a static guard and not just a render test: `alignSelf` is a *cross-axis*
// hint, and in a column-flex ScrollBox the cross axis is the WIDTH — but setting
// it also makes the node stop measuring its intrinsic HEIGHT. Measured on a
// 40x12 test renderer, a bordered box holding a 30-line text child:
//
//   plain box .................... h=30 (text 30)   scrollHeight 30
//   + border ..................... h=32 (text 30)   scrollHeight 32
//   + alignSelf: "flex-start" .... h=12 (text 12)   scrollHeight 12   <- the bug
//   + maxWidth: 11 ............... h=32 (text 30)   scrollHeight 32
//
// A box squeezed below its natural height paints its top and bottom border rows
// over its single content row (the corrupted `❯ …` echo box users reported), and
// the under-reported `scrollHeight` makes every transcript row BELOW the box
// unreachable. `maxWidth` gives the same hug-the-content look with correct
// measurement and is clamped by the parent, so it is also resize-safe.
//
// Flow 109's risk-R4 guidance ("every new box gets flexShrink:0 +
// alignSelf:'flex-start'") is what introduced the idiom; `flexShrink: 0` stays,
// `alignSelf` is banned. Use `hugWidth()` + `maxWidth` instead.

const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ROOT = path.join(SRC_ROOT, "..");
const TUI_ROOT = path.join(SRC_ROOT, "tui");

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

test("no TUI runtime source sets alignSelf on a renderable (flow 115 / AC1)", async () => {
  const files = await runtimeTsFiles(TUI_ROOT);
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      // Property assignment or option field — `alignSelf: "flex-start"`,
      // `box.alignSelf = …`. A prose mention in a comment is allowed, since the
      // ban itself has to be explainable in the code that used to violate it.
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (/\balignSelf\s*[:=]/.test(code)) {
        violations.push(`${path.relative(PKG_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
