// A link whose label reads as one site and whose target is another (flow 395, S-002).

import { describe, expect, test } from "bun:test";
import { hostMarker, mismatchedHost } from "./format-link";
import { renderRichMessage } from "./format-rich";
import { escapeHtml, renderTelegramHtml } from "./format-html";
import { renderPlainText } from "./format-plain";

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, "&quot;");

describe("a URL-like label for another host shows the target host (HTML)", () => {
  test("the form is `label (→ host)`, with the host after the link", () => {
    expect(renderTelegramHtml("[https://mybank.example](https://evil.example/login)")).toBe(
      '<a href="https://evil.example/login">https://mybank.example</a> (→ evil.example)',
    );
  });

  for (const label of ["www.mybank.example", "mybank.example", "mybank.example/login", "HTTP://MyBank.example", "**https://mybank.example**", "`mybank.example`"]) {
    test(`label ${label}`, () => {
      expect(renderTelegramHtml(`[${label}](https://evil.example/x)`).endsWith("</a> (→ evil.example)")).toBe(true);
    });
  }

  test("a user part in the target, the trick `bank@evil`, shows the real host", () => {
    expect(renderTelegramHtml("[https://mybank.example](https://mybank.example@evil.example/)")).toBe(
      '<a href="https://mybank.example@evil.example/">https://mybank.example</a> (→ evil.example)',
    );
  });

  test("a user part in the label shows the host even when label and target agree on it", () => {
    expect(renderTelegramHtml("[https://mybank.example@evil.example](https://evil.example)")).toBe(
      '<a href="https://evil.example">https://mybank.example@evil.example</a> (→ evil.example)',
    );
  });

  test("an internationalised host is shown as punycode, so a look-alike is visible", () => {
    const html = renderTelegramHtml("[https://apple.com](https://аpple.com/id)");
    expect(html).toContain("(→ xn--");
    expect(html).not.toContain("аpple.com</a>");
  });

  test("the same internationalised host in label and target needs no marker", () => {
    expect(renderTelegramHtml("[https://bücher.example](https://xn--bcher-kva.example/)")).toBe(
      '<a href="https://xn--bcher-kva.example/">https://bücher.example</a>',
    );
  });

  test("a target the URL parser refuses does not throw, and its host is escaped", () => {
    let html = "";
    expect(() => {
      html = renderTelegramHtml("[https://mybank.example](https://x&y.example/p)");
    }).not.toThrow();
    expect(html).toBe('<a href="https://x&amp;y.example/p">https://mybank.example</a> (→ x&amp;y.example)');
    expect(() => renderTelegramHtml("[www.a.example](https://[bad)")).not.toThrow();
  });

  test("the marker never makes the visible text longer than the Markdown it came from", () => {
    const sources = [
      "[https://mybank.example](https://evil.example)",
      "[a.example](https://абвгдежзийклмнопрсту.example/)",
      "[https://a.b](https://c.d)",
    ];
    for (const source of sources) {
      const visible = renderTelegramHtml(source)
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      expect(visible.length).toBeLessThanOrEqual(source.length);
    }
  });
});

describe("the rich message agrees with the HTML", () => {
  test("the link node is followed by the marker as text", () => {
    const block = renderRichMessage("[https://mybank.example](https://evil.example/login)").blocks[0];
    expect(block).toEqual({
      type: "paragraph",
      text: [{ type: "url", text: "https://mybank.example", url: "https://evil.example/login" }, " (→ evil.example)"],
    });
  });

  test("inside a table cell", () => {
    const table = renderRichMessage("| site |\n|---|\n| [https://mybank.example](https://evil.example) |").blocks[0];
    expect(JSON.stringify(table)).toContain("(→ evil.example)");
  });
});

describe("plain text already shows the whole target", () => {
  test("a message without a table is returned untouched, link source and all", () => {
    const text = "[https://mybank.example](https://evil.example/login)";
    expect(renderPlainText(text)).toBe(text);
  });
});

describe("every other link renders exactly as before (AC9)", () => {
  // [label source, target, label as HTML]
  const GOLDEN: [string, string, string][] = [
    ["the docs", "https://example.com/a?b=1&c=2", "the docs"],
    ["plain", "http://example.com", "plain"],
    ["x", "http://a.b/c", "x"],
    ["**b**", "https://x.y", "<b>b</b>"],
    ["w", "https://en.wikipedia.org/wiki/Foo_(bar)", "w"],
    ["x", "https://evil.example", "x"],
    ["l", "https://a.b/c?d=1&e=2", "l"],
    ["README.md", "https://github.com/o/r", "README.md"],
    ["index.ts", "https://github.com/o/r/blob/main/index.ts", "index.ts"],
    ["version 1.2.3", "https://example.com/v", "version 1.2.3"],
    ["see example.com now", "https://other.example", "see example.com now"],
    ["https://example.com", "https://example.com", "https://example.com"],
    ["https://www.Example.com/a", "https://example.com/b", "https://www.Example.com/a"],
    ["WWW.EXAMPLE.COM", "https://example.com:8443/", "WWW.EXAMPLE.COM"],
    ["example.com", "http://www.example.com/x", "example.com"],
    ["https://bücher.example", "https://xn--bcher-kva.example/", "https://bücher.example"],
    ["https://example.com/", "https://EXAMPLE.com./", "https://example.com/"],
    ["日本語", "https://example.jp", "日本語"],
  ];

  test("a golden list is byte for byte `<a href>label</a>`", () => {
    for (const [label, url, shown] of GOLDEN) {
      expect(mismatchedHost(label, url)).toBeUndefined();
      expect(renderTelegramHtml(`[${label}](${url})`)).toBe(`<a href="${escapeAttr(url)}">${shown}</a>`);
    }
  });

  test("a generated cross product of ordinary labels and targets", () => {
    const labels = ["a", "docs", "the report", "v1.0", "main.ts", "Dockerfile", "a, b", "1.5x faster", "e.g. this", "wiki"];
    const targets = ["https://a.example", "http://b.example/p", "https://c.example/a?x=1&y=2", "https://d.example:8080/#top"];
    for (const label of labels) {
      for (const url of targets) {
        expect(hostMarker(label, url)).toBe("");
        expect(renderTelegramHtml(`[${label}](${url})`)).toBe(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
      }
    }
  });

  test("an address label for the same host, in any spelling, is left alone", () => {
    for (const label of ["https://a.example", "http://a.example/x", "www.a.example", "A.EXAMPLE", "a.example/path", "https://www.a.example:99/"]) {
      expect(hostMarker(label, "https://a.example/target")).toBe("");
    }
  });
});
