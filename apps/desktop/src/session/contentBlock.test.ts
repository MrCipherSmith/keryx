import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "../acp/types";
import { blockView, fenced, imageDataUri, uriName } from "./contentBlock";

const b = (x: Record<string, unknown>) => x as unknown as ContentBlock;

describe("imageDataUri", () => {
  test("builds a data URI for raster types with a base64 payload", () => {
    expect(imageDataUri("image/png", "iVBO\nRw0K")).toBe("data:image/png;base64,iVBORw0K");
    expect(imageDataUri("IMAGE/JPEG; q=1", "AAAA")).toBe("data:image/jpeg;base64,AAAA");
  });

  test("refuses SVG, unknown types and payloads that are not base64", () => {
    expect(imageDataUri("image/svg+xml", "PHN2Zz4=")).toBeNull();
    expect(imageDataUri("text/html", "AAAA")).toBeNull();
    expect(imageDataUri("image/png", "AA\"onerror=x")).toBeNull();
    expect(imageDataUri("image/png", "")).toBeNull();
    expect(imageDataUri(undefined, "AAAA")).toBeNull();
  });
});

describe("blockView", () => {
  test("an image shows as a picture, an unsafe one as a label", () => {
    expect(blockView(b({ type: "image", mimeType: "image/webp", data: "AAAA" }))).toEqual({ kind: "image", src: "data:image/webp;base64,AAAA", alt: "image" });
    expect(blockView(b({ type: "image", mimeType: "image/svg+xml", data: "AAAA" }))).toEqual({ kind: "unknown", label: "image (image/svg+xml) not shown" });
  });

  test("a resource link names its target with type and size", () => {
    expect(blockView(b({ type: "resource_link", name: "report.pdf", uri: "file:///tmp/report.pdf", mimeType: "application/pdf", size: 2048 }))).toEqual({
      kind: "link",
      name: "report.pdf",
      uri: "file:///tmp/report.pdf",
      detail: "application/pdf · 2.0 KB",
    });
  });

  test("an embedded text resource is a file with the language of its extension; a blob is binary or an image", () => {
    expect(blockView(b({ type: "resource", resource: { uri: "file:///src/a.ts", text: "let a = 1" } }))).toEqual({ kind: "file", uri: "file:///src/a.ts", text: "let a = 1", lang: "ts" });
    expect(blockView(b({ type: "resource", resource: { uri: "file:///x.patch", text: "@@" } }))).toMatchObject({ kind: "file", lang: "diff" });
    expect(blockView(b({ type: "resource", resource: { uri: "file:///p.png", blob: "AAAA", mimeType: "image/png" } }))).toEqual({ kind: "image", src: "data:image/png;base64,AAAA", alt: "p.png" });
    expect(blockView(b({ type: "resource", resource: { uri: "file:///d.bin", blob: "AAAAAAAA", mimeType: "application/octet-stream" } }))).toEqual({
      kind: "binary",
      uri: "file:///d.bin",
      detail: "application/octet-stream · 6 B",
    });
  });

  test("an unknown type is labelled, not dropped silently", () => {
    expect(blockView(b({ type: "audio", data: "x", mimeType: "audio/wav" }))).toEqual({ kind: "unknown", label: "audio content not shown" });
  });
});

test("uriName takes the last path segment, decoded", () => {
  expect(uriName("file:///a/b/My%20File.md?x=1")).toBe("My File.md");
  expect(uriName("https://example.com/")).toBe("example.com");
});

test("fenced picks a fence no backtick run inside the text can close", () => {
  expect(fenced("a\n", "ts")).toBe("```ts\na\n```");
  expect(fenced("x ```` y", "")).toBe("`````\nx ```` y\n`````");
});
