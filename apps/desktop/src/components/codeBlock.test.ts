import { describe, expect, test } from "bun:test";
import { codeBlockCopyText, revealCodeBlock } from "./codeBlock";

const BIDI = String.fromCharCode(0x202e);

function block(text: string) {
  return { code: { textContent: text as string | null }, wrap: { dataset: {} as { raw?: string } } };
}

describe("code block reveal", () => {
  test("a hidden character is shown as an escape in the code text", () => {
    const b = block(`a${BIDI}b`);
    revealCodeBlock(b.code, b.wrap);
    expect(b.code.textContent).not.toContain(BIDI);
    expect(b.code.textContent).toContain("202E");
  });

  test("the raw text is kept aside on the wrapper", () => {
    const b = block(`a${BIDI}b`);
    revealCodeBlock(b.code, b.wrap);
    expect(b.wrap.dataset.raw).toBe(`a${BIDI}b`);
  });

  test("Copy prefers the raw text over what the block shows", () => {
    const b = block(`a${BIDI}b`);
    revealCodeBlock(b.code, b.wrap);
    expect(codeBlockCopyText(b.wrap, b.code)).toBe(`a${BIDI}b`);
  });

  test("a plain block is untouched and Copy reads its text", () => {
    const b = block("let x = 1;");
    revealCodeBlock(b.code, b.wrap);
    expect(b.code.textContent).toBe("let x = 1;");
    expect(b.wrap.dataset.raw).toBeUndefined();
    expect(codeBlockCopyText(b.wrap, b.code)).toBe("let x = 1;");
    expect(codeBlockCopyText(null, null)).toBe("");
  });
});
