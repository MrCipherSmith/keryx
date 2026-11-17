import { describe, expect, test } from "bun:test";
import { marked, type Token } from "marked";
import { emptyCache, renderStreaming, type StreamFrame } from "./markdownStream";

marked.setOptions({ gfm: true, breaks: false });

/** Stand-in for the code-block chrome: lets a test see that a block was decorated. */
const decorate = (html: string) => html.split("<pre>").join('<pre data-chrome="1">');
const render = (tokens: Token[]) => decorate(marked.parser(tokens));
const oneShot = (src: string) => decorate(marked.parse(src, { async: false }) as string);
const whole = (f: StreamFrame) => f.blocks.join("") + f.tail;

const FIXTURE = [
  "# Plan",
  "",
  "Some *text* with `code` and a [link](https://example.com).",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "> quoted",
  "> more",
  "",
  "1. first",
  "2. second",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "Last paragraph.",
  "",
].join("\n");

describe("renderStreaming", () => {
  test("every prefix renders exactly like the one-shot rendering", () => {
    const c = emptyCache();
    for (let i = 1; i <= FIXTURE.length; i++) {
      const prefix = FIXTURE.slice(0, i);
      expect(whole(renderStreaming(prefix, c, render))).toBe(oneShot(prefix));
    }
    // The cache really was used: completed blocks were committed along the way.
    expect(c.blocks.length).toBeGreaterThan(3);
  });

  test("completed code blocks are decorated while the message still streams", () => {
    const c = emptyCache();
    const text = "Intro\n\n```sh\nls\n```\n\nMore text";
    let f = renderStreaming(text.slice(0, 5), c, render);
    for (let i = 6; i <= text.length; i++) f = renderStreaming(text.slice(0, i), c, render);
    expect(f.blocks.join("")).toContain('<pre data-chrome="1">');
    expect(f.tail).toContain("More text");
  });

  test("a text that is replaced or shrinks starts over and says so", () => {
    const c = emptyCache();
    renderStreaming("# A\n\nfirst para\n\nsecond", c, render);
    const before = c.epoch;
    const replaced = "# B\n\nother\n\nthird";
    const f = renderStreaming(replaced, c, render);
    expect(whole(f)).toBe(oneShot(replaced));
    expect(f.epoch).toBeGreaterThan(before);
    const shrunk = renderStreaming("# B", c, render);
    expect(whole(shrunk)).toBe(oneShot("# B"));
  });

  test("CRLF text is never committed at a misaligned offset", () => {
    const c = emptyCache();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    // A long CRLF fence: committing its normalised raw would put the cache's end inside the fence.
    const crlf = "para one\r\n\r\n```\r\n" + lines.join("\r\n") + "\r\n```\r\n\r\nnext para\r\n\r\n- a\r\n- b\r\n\r\nend";
    for (let i = 1; i <= crlf.length; i++) {
      const prefix = crlf.slice(0, i);
      expect(whole(renderStreaming(prefix, c, render))).toBe(oneShot(prefix));
    }
  });

  test("blocks already shown stay the same objects' content while the tail grows", () => {
    const c = emptyCache();
    const a = renderStreaming("one\n\ntwo\n\nthr", c, render);
    const firstBlocks = a.blocks.slice();
    const b = renderStreaming("one\n\ntwo\n\nthree and more", c, render);
    expect(b.blocks.slice(0, firstBlocks.length)).toEqual(firstBlocks);
    expect(b.epoch).toBe(a.epoch);
  });
});
