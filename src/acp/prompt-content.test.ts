import { describe, expect, test } from "bun:test";
import { renderAcpPromptContent } from "./prompt-content";

describe("renderAcpPromptContent", () => {
  test("joins text blocks with a blank line", () => {
    const rendered = renderAcpPromptContent([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(rendered).toBe("first\n\nsecond");
  });

  test("inlines an embedded text resource (embeddedContext: true)", () => {
    const rendered = renderAcpPromptContent([
      { type: "resource", resource: { uri: "file:///a.ts", text: "const x = 1;" } },
    ]);
    expect(rendered).toBe("const x = 1;");
  });

  test("renders a binary embedded resource as a placeholder, not silently dropped", () => {
    const rendered = renderAcpPromptContent([
      { type: "resource", resource: { uri: "file:///a.png", blob: "aGVsbG8=", mimeType: "image/png" } },
    ]);
    expect(rendered).toContain("file:///a.png");
    expect(rendered).toContain("embedded resource omitted");
  });

  test("renders a resource_link as a placeholder", () => {
    const rendered = renderAcpPromptContent([{ type: "resource_link", name: "a", uri: "file:///a.ts" }]);
    expect(rendered).toBe("[resource link: file:///a.ts]");
  });

  test("renders image/audio blocks as placeholders (promptCapabilities declares both false)", () => {
    const rendered = renderAcpPromptContent([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
    ]);
    expect(rendered).toContain("image content omitted");
    expect(rendered).toContain("audio content omitted");
  });

  test("ignores non-object / malformed entries rather than throwing", () => {
    expect(renderAcpPromptContent([null, 42, "raw string", { type: "text", text: "kept" }])).toBe("kept");
  });

  test("empty prompt renders as an empty string", () => {
    expect(renderAcpPromptContent([])).toBe("");
  });
});
