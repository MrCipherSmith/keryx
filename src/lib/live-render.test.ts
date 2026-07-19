import { expect, test } from "bun:test";
import { LiveMarkdownBlock, computeRepaint, displayWidth, physicalRows, stripAnsi } from "./live-render";

const ESC = "\x1b";

// --- stripAnsi / displayWidth ---

test("stripAnsi removes SGR and cursor escapes, keeps text", () => {
  expect(stripAnsi(`${ESC}[1mbold${ESC}[22m`)).toBe("bold");
  expect(stripAnsi(`a${ESC}[2Kb`)).toBe("ab");
  expect(stripAnsi("plain")).toBe("plain");
});

test("displayWidth ignores escapes and counts wide code points as 2", () => {
  expect(displayWidth("abc")).toBe(3);
  expect(displayWidth(`${ESC}[36m•${ESC}[39m text`)).toBe(6); // "• text"
  expect(displayWidth("日本")).toBe(4); // two CJK cells
  expect(displayWidth("")).toBe(0);
});

// --- physicalRows ---

test("physicalRows accounts for wrapping and empty lines", () => {
  expect(physicalRows(["hello"], 80)).toBe(1);
  expect(physicalRows(["", ""], 80)).toBe(2); // empty line still one row
  expect(physicalRows(["a".repeat(10)], 4)).toBe(3); // 10/4 -> 3 rows
  expect(physicalRows(["a".repeat(8)], 8)).toBe(1); // exactly full -> 1 row
  expect(physicalRows(["one", "two"], 80)).toBe(2);
});

test("physicalRows falls back to one row per line when cols is unknown", () => {
  expect(physicalRows(["a".repeat(100), "b"], 0)).toBe(2);
});

// --- computeRepaint ---

test("computeRepaint first paint emits no cursor movement", () => {
  const { output, rows } = computeRepaint({ prevRows: 0, nextLines: ["hello", "world"], cols: 80 });
  expect(output).toBe("hello\nworld");
  expect(rows).toBe(2);
});

test("computeRepaint returns to the block top, clears, and reprints", () => {
  const { output, rows } = computeRepaint({ prevRows: 3, nextLines: ["a", "b", "c", "d"], cols: 80 });
  // \r + up(2) + clear-to-end + new body
  expect(output).toBe(`\r${ESC}[2A${ESC}[0Ja\nb\nc\nd`);
  expect(rows).toBe(4);
});

test("computeRepaint with prevRows=1 moves no rows up but still clears", () => {
  const { output } = computeRepaint({ prevRows: 1, nextLines: ["x"], cols: 80 });
  expect(output).toBe(`\r${ESC}[0Jx`);
});

test("computeRepaint sync wraps the whole repaint in synchronized-output markers", () => {
  const { output } = computeRepaint({ prevRows: 0, nextLines: ["hi"], cols: 80, sync: true });
  expect(output).toBe(`${ESC}[?2026hhi${ESC}[?2026l`);
});

// --- LiveMarkdownBlock ---

function harness(cols = 80, sync = false): { block: LiveMarkdownBlock; writes: string[]; setCols: (n: number) => void } {
  const writes: string[] = [];
  let currentCols = cols;
  const block = new LiveMarkdownBlock({
    out: (s) => writes.push(s),
    cols: () => currentCols,
    render: (md) => md, // identity render keeps assertions about control flow simple
    sync,
  });
  return { block, writes, setCols: (n) => (currentCols = n) };
}

test("LiveMarkdownBlock: append is silent, flush paints once, dirty resets", () => {
  const { block, writes } = harness();
  block.append("hel");
  block.append("lo");
  expect(writes).toEqual([]); // append never paints
  block.flush();
  expect(writes).toEqual(["hello"]); // first paint, no cursor move
  block.flush(); // not dirty
  expect(writes).toEqual(["hello"]);
});

test("LiveMarkdownBlock: a second flush repaints in place over the previous rows", () => {
  const { block, writes } = harness();
  block.append("a\nb");
  block.flush();
  block.append("\nc");
  block.flush();
  expect(writes[0]).toBe("a\nb");
  // second paint: prevRows=2 -> \r + up(1) + clear + full body
  expect(writes[1]).toBe(`\r${ESC}[1A${ESC}[0Ja\nb\nc`);
});

test("LiveMarkdownBlock: finalize paints the tail, breaks the line, and resets", () => {
  const { block, writes } = harness();
  block.append("done");
  block.finalize();
  expect(writes[0]).toBe("done"); // final repaint
  expect(writes[1]).toBe("\n"); // line break
  // after reset, a new block starts fresh (no cursor-up)
  block.append("next");
  block.flush();
  expect(writes[2]).toBe("next");
});

test("LiveMarkdownBlock: a width change since last paint degrades to a fresh block", () => {
  const { block, writes, setCols } = harness(80);
  block.append("line");
  block.flush();
  expect(writes[0]).toBe("line");
  setCols(40); // terminal resized between paints
  block.append("more");
  block.flush();
  // fresh-block newline, THEN a first-paint (no cursor-up) of the new render
  expect(writes[1]).toBe("\n");
  expect(writes[2]).toBe("linemore");
});

test("LiveMarkdownBlock: sync markers wrap live repaints", () => {
  const { block, writes } = harness(80, true);
  block.append("hi");
  block.flush();
  expect(writes[0]).toBe(`${ESC}[?2026hhi${ESC}[?2026l`);
});
