import { describe, expect, test } from "bun:test";
import { FakeBotApi } from "./fake-bot-api";
import { formatReply } from "./format";
import { checkTelegramHtml, escapeHtml, isEntityParseError, renderTelegramHtml, sendHtml } from "./format-html";
import { BotApiError, TELEGRAM_MAX_TEXT } from "./types";

/** The text Telegram would show for `html`; fails the test when the HTML is not valid. */
function shown(html: string): string {
  const checked = checkTelegramHtml(html);
  if (!checked.ok) {
    throw new Error(`invalid Telegram HTML (${checked.reason}): ${html}`);
  }
  return checked.text;
}

describe("renderTelegramHtml: the markup it understands", () => {
  test("a short answer without markup comes back unchanged", () => {
    const text = "Done. The build passes and the three failing tests are fixed.";
    expect(renderTelegramHtml(text)).toBe(text);
  });

  test("bold, italic, strike and inline code", () => {
    expect(renderTelegramHtml("a **bold** and __two words__ b")).toBe("a <b>bold</b> and <b>two words</b> b");
    expect(renderTelegramHtml("an *italic* and _also italic_ word")).toBe("an <i>italic</i> and <i>also italic</i> word");
    expect(renderTelegramHtml("~~gone~~ stays")).toBe("<s>gone</s> stays");
    expect(renderTelegramHtml("run `bun test` now")).toBe("run <code>bun test</code> now");
    expect(renderTelegramHtml("**bold with *italic* inside**")).toBe("<b>bold with <i>italic</i> inside</b>");
    expect(renderTelegramHtml("***both***")).toBe("<b><i>both</i></b>");
  });

  test("a bullet list uses bullet characters", () => {
    expect(renderTelegramHtml("Steps:\n- one\n* two **bold**\n  - nested")).toBe("Steps:\n• one\n• two <b>bold</b>\n  • nested");
  });

  test("a heading becomes one bold line", () => {
    expect(renderTelegramHtml("# Title\nbody\n## Sub **x** `y`")).toBe("<b>Title</b>\nbody\n<b>Sub x y</b>");
    expect(renderTelegramHtml("### Fix C# ###")).toBe("<b>Fix C#</b>");
  });

  test("quotes become a blockquote; a long one is expandable", () => {
    expect(renderTelegramHtml("> first\n> second *i*\nafter")).toBe("<blockquote>first\nsecond <i>i</i></blockquote>after");
    const long = Array.from({ length: 9 }, (_, i) => `> line ${i}`).join("\n");
    expect(renderTelegramHtml(long).startsWith("<blockquote expandable>line 0\n")).toBe(true);
    expect(renderTelegramHtml("a > b")).toBe("a &gt; b");
  });

  test("a fenced block with a language becomes pre with code", () => {
    const html = renderTelegramHtml("Here:\n\n```ts\nconst a = 1 < 2 && b;\n```\n\nDone.");
    expect(html).toBe('Here:\n\n<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; b;</code></pre>\nDone.');
    expect(shown(html)).toContain("const a = 1 < 2 && b;");
  });

  test("a fence without a language, a tilde fence, and an odd info string", () => {
    expect(renderTelegramHtml("```\nplain\n```")).toBe("<pre><code>plain</code></pre>");
    expect(renderTelegramHtml("~~~python title=x\nprint(1)\n~~~")).toBe('<pre><code class="language-python">print(1)</code></pre>');
    // an info string that is not a clean language name gives no class and cannot inject an attribute
    const odd = renderTelegramHtml('```a"b onclick=x\ncode\n```');
    expect(odd).toBe("<pre><code>code</code></pre>");
    expect(renderTelegramHtml("```c++\nint x;\n```")).toContain('class="language-c++"');
  });

  test("markup inside a fence is not interpreted", () => {
    const html = renderTelegramHtml("```md\n**not bold** `x` <b>\n# nope\n```");
    expect(html).toBe("<pre><code>**not bold** `x` &lt;b&gt;\n# nope</code></pre>".replace("<code>", '<code class="language-md">'));
    expect(shown(html)).toBe("**not bold** `x` <b>\n# nope");
  });

  test("an unclosed fence runs to the end of the part as one block; an empty one stays literal", () => {
    expect(renderTelegramHtml("```js\nlet a;\nlet b;")).toBe('<pre><code class="language-js">let a;\nlet b;</code></pre>');
    expect(renderTelegramHtml("```\n```")).toBe("```\n```");
  });

  test("inline code with < & > is escaped and holds no tags", () => {
    const html = renderTelegramHtml("use `a < b && c > d` and `<b>`");
    expect(html).toBe("use <code>a &lt; b &amp;&amp; c &gt; d</code> and <code>&lt;b&gt;</code>");
    expect(shown(html)).toBe("use a < b && c > d and <b>");
  });

  test("markup inside inline code stays literal", () => {
    expect(renderTelegramHtml("`**x** _y_`")).toBe("<code>**x** _y_</code>");
    expect(renderTelegramHtml("**bold `a**b` end**")).toBe("<b>bold a**b end</b>");
    expect(renderTelegramHtml("``a ` b``")).toBe("<code>a ` b</code>");
  });
});

describe("renderTelegramHtml: ambiguous and hostile text stays literal", () => {
  test("snake_case_name and other words with markup characters stay as written", () => {
    expect(renderTelegramHtml("call snake_case_name and my_var_ here")).toBe("call snake_case_name and my_var_ here");
    expect(renderTelegramHtml("a*b*c and 2*3*4 and 5 * 3 * 2")).toBe("a*b*c and 2*3*4 and 5 * 3 * 2");
    expect(renderTelegramHtml("globs like src/*.ts and lib/*.js")).toBe("globs like src/*.ts and lib/*.js");
    expect(renderTelegramHtml('if __name__ == "__main__":')).toBe('if __name__ == "__main__":');
    expect(renderTelegramHtml("import __init__.py")).toBe("import __init__.py");
  });

  test("stray _ * < > & and an unmatched ** never produce invalid HTML", () => {
    const samples = [
      "unmatched **bold and *italic and _under and ~~strike and `code",
      "a < b > c & d &amp; e &lt;b&gt;",
      "<script>alert(1)</script> <b>x</b> </b>",
      "**a *b** c*",
      "*a **b* c**",
      "[x](http://a.b/c) [y](",
      "[**b**](https://x.y)",
      "``` not a fence ```\n~~~ also ~~~",
      "> quote with **open\n> still",
      "- ** \n* _ \n# ",
    ];
    for (const sample of samples) {
      const html = renderTelegramHtml(sample);
      expect(checkTelegramHtml(html).ok).toBe(true);
    }
    expect(renderTelegramHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderTelegramHtml("unmatched **bold and a < b")).toBe("unmatched **bold and a &lt; b");
    expect(renderTelegramHtml("Q&A <3")).toBe("Q&amp;A &lt;3");
  });

  test("emphasis does not cross a newline", () => {
    expect(renderTelegramHtml("**one\ntwo**")).toBe("**one\ntwo**");
    expect(renderTelegramHtml("*one\ntwo*")).toBe("*one\ntwo*");
  });

  test("an https link is allowed; other schemes are left as text", () => {
    expect(renderTelegramHtml("see [the docs](https://example.com/a?b=1&c=2) now")).toBe(
      'see <a href="https://example.com/a?b=1&amp;c=2">the docs</a> now',
    );
    expect(renderTelegramHtml("[plain](http://example.com)")).toBe('<a href="http://example.com">plain</a>');
    expect(renderTelegramHtml("[click](javascript:alert(1))")).toBe("[click](javascript:alert(1))");
    expect(renderTelegramHtml("[mail](mailto:a@b.c) [t](tg://user?id=1) [f](file:///etc/passwd) [r](//x.y)")).toBe(
      "[mail](mailto:a@b.c) [t](tg://user?id=1) [f](file:///etc/passwd) [r](//x.y)",
    );
    expect(renderTelegramHtml('[q](https://x.y/"onmouseover=1)')).toBe('[q](https://x.y/"onmouseover=1)');
    expect(renderTelegramHtml("[**bold** `c`](https://x.y)")).toBe('<a href="https://x.y"><b>bold</b> `c`</a>');
  });

  test("a link URL with balanced parentheses is kept whole", () => {
    expect(renderTelegramHtml("[w](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a>');
  });

  test("a heading never repeats the bold tag", () => {
    expect(renderTelegramHtml("# **Title**")).toBe("<b>Title</b>");
  });

  test("inline code inside a heading, bold, italic or strike is plain text; Telegram forbids code in them", () => {
    expect(renderTelegramHtml("# Use `a < b` here")).toBe("<b>Use a &lt; b here</b>");
    expect(renderTelegramHtml("**bold `code` end**")).toBe("<b>bold code end</b>");
    expect(renderTelegramHtml("*it `c`* and ~~st `c`~~")).toBe("<i>it c</i> and <s>st c</s>");
    expect(renderTelegramHtml("***both `c`***")).toBe("<b><i>both c</i></b>");
    // outside emphasis, and in a quote, it is still code
    expect(renderTelegramHtml("**b** `c`")).toBe("<b>b</b> <code>c</code>");
    expect(renderTelegramHtml("> a `c`")).toBe("<blockquote>a <code>c</code></blockquote>");
  });
});

describe("renderTelegramHtml: the guaranteed properties", () => {
  /** Remove everything the renderer may drop or swap, so what is left is plain content. */
  function content(text: string): string {
    return text.replace(/[`*_~#>\-•\s]/g, "");
  }

  function randomText(seed: number, alphabet: string[], length: number): string {
    let state = seed;
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    return Array.from({ length }, () => alphabet[next() % alphabet.length] as string).join("");
  }

  const ALPHABET = ["*", "**", "_", "__", "~~", "`", "``", "<", ">", "&", "&amp;", "a", "b", "x y", " ", "\n", "- ", "# ", "> ", "[", "]", "(", ")", "'", '"', "http", "\r", "\r\n"];
  /** Everything above plus fences, link syntax and emphasis around code. */
  const SOUP = [...ALPHABET, "```", "```ts\n", "\n```\n", "~~~", "\n~~~\n", "](", "](https://a.b)", "[x](https://a.b)", "https://a.b", "**`c`**", "# `c`", "*`c`*", "**", "`c`"];

  test("random markup soup always renders balanced, valid HTML", () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const text = randomText(seed, seed % 2 === 0 ? SOUP : ALPHABET, 5 + (seed % 60));
      const html = renderTelegramHtml(text);
      const checked = checkTelegramHtml(html);
      if (!checked.ok) {
        throw new Error(`seed ${seed}: ${checked.reason}\ninput: ${JSON.stringify(text)}\noutput: ${JSON.stringify(html)}`);
      }
    }
  });

  test("the shown text equals the input with only markup characters removed (no fences or links)", () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const text = randomText(seed, ALPHABET.filter((piece) => !piece.includes("`") || piece.length === 1).filter((piece) => piece !== "[" && piece !== "]" && piece !== "(" && piece !== ")"), 5 + (seed % 60));
      // a run of three or more tildes at a line start opens a fence, which is markup this property excludes
      if (/^ {0,3}~{3,}/m.test(text.replace(/\r\n?/g, "\n"))) {
        continue;
      }
      const html = renderTelegramHtml(text);
      expect(content(shown(html))).toBe(content(text));
    }
  });

  test("a rendered part never shows more characters than the plain part", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const text = randomText(seed + 5000, SOUP, 80);
      expect(shown(renderTelegramHtml(text)).length).toBeLessThanOrEqual(text.length);
    }
  });

  test("random soup through formatReply and the renderer: every part is valid and within the limit", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const text = randomText(seed + 9000, SOUP, 6000);
      for (const part of formatReply(text)) {
        const html = renderTelegramHtml(part);
        const checked = checkTelegramHtml(html);
        if (!checked.ok) {
          throw new Error(`seed ${seed}: ${checked.reason}`);
        }
        expect(checked.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
      }
    }
  });

  test("escapeHtml escapes exactly & < >", () => {
    expect(escapeHtml(`a & b < c > d "q" 'r'`)).toBe(`a &amp; b &lt; c &gt; d "q" 'r'`);
  });
});

describe("renderTelegramHtml on parts from formatReply", () => {
  test("a fence that spans a split renders as a valid pre in both parts", () => {
    const code = Array.from({ length: 300 }, (_, i) => `const value${i} = a < b && c > ${i};`).join("\n");
    const parts = formatReply(`Intro line.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nOutro.`);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const html = renderTelegramHtml(part);
      const text = shown(html);
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
      expect(html).toContain("<pre>");
      expect(html).toContain("</pre>");
      expect(html).not.toContain("```");
    }
    expect(renderTelegramHtml(parts[0] as string)).toContain('<pre><code class="language-ts">');
    expect(renderTelegramHtml(parts[1] as string)).toContain('<pre><code class="language-ts">');
  });

  test("a 400-line numbered reply of 5000+ characters makes several parts, each <= 4096 after rendering", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i + 1}. item **${i + 1}** with \`code_${i}\` & <tag> and snake_case_here`);
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(5000);
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const html = renderTelegramHtml(part);
      expect(shown(html).length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
      expect(shown(html).length).toBeLessThanOrEqual(part.length);
    }
  });

  test("CRLF and lone CR text splits and renders exactly like the LF version, including a fence across a split", () => {
    const code = Array.from({ length: 300 }, (_, i) => `const value${i} = a < b && c > ${i};`).join("\n");
    const lf = `Intro **line**.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nOutro.`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const cr = lf.replace(/\n/g, "\r");
    const expected = formatReply(lf);
    expect(expected.length).toBeGreaterThan(1);
    expect(formatReply(crlf)).toEqual(expected);
    expect(formatReply(cr)).toEqual(expected);
    for (const part of formatReply(crlf)) {
      expect(part).not.toContain("\r");
      expect(renderTelegramHtml(part)).toContain("<pre><code");
    }
    expect(formatReply(crlf).map(renderTelegramHtml)).toEqual(expected.map(renderTelegramHtml));
    // a short CRLF reply is normalised too
    expect(formatReply("a\r\nb")).toEqual(["a\nb"]);
  });

  test("the label line of a numbered part is plain text", () => {
    const parts = formatReply("word ".repeat(1500));
    expect(renderTelegramHtml(parts[0] as string).startsWith("(1/2)\n")).toBe(true);
  });
});

describe("checkTelegramHtml", () => {
  test("accepts the documented tags and rejects the rest", () => {
    for (const ok of [
      "<b>x</b> <strong>x</strong> <i>x</i> <em>x</em> <u>x</u> <ins>x</ins> <s>x</s> <strike>x</strike> <del>x</del>",
      '<span class="tg-spoiler">x</span> <a href="https://x.y">x</a> <code>x</code>',
      '<pre><code class="language-ts">x</code></pre> <blockquote>q</blockquote> <blockquote expandable>q</blockquote>',
      "<b><i><u>x</u></i></b> <a href=\"https://x.y\"><b>x</b></a> a &amp; b &lt; c &gt; d",
      "<b>x</b> <code>y</code> <blockquote>q <code>y</code></blockquote> <blockquote><pre><code>y</code></pre></blockquote>",
    ]) {
      expect(checkTelegramHtml(ok).ok).toBe(true);
    }
    for (const bad of [
      "<b>x",
      "x</b>",
      "<b><i>x</b></i>",
      "<script>x</script>",
      "<b onclick=\"x\">x</b>",
      "<code><b>x</b></code>",
      "<pre><b>x</b></pre>",
      "<blockquote><blockquote>x</blockquote></blockquote>",
      "<b>x <code>y</code></b>",
      "<i><pre>y</pre></i>",
      '<a href="https://x.y"><code>y</code></a>',
      "<s><b><code>y</code></b></s>",
      "<a>x</a>",
      "a < b",
      "a & b",
      "a > b",
      "<b>x</b",
    ]) {
      expect(checkTelegramHtml(bad).ok).toBe(false);
    }
  });
});

describe("sendHtml", () => {
  const chatId = -1001234567890;

  test("sends the rendered part with parse_mode HTML", async () => {
    const api = new FakeBotApi();
    await sendHtml(api, { chatId, text: "a **b** & c" });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toBe("a <b>b</b> &amp; c");
    expect(api.sent[0]?.parseMode).toBe("HTML");
  });

  test("a 400 'can't parse entities' resends the original once as plain text", async () => {
    const api = new FakeBotApi();
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities: Unsupported start tag", { status: 400 }));
    const seen: unknown[] = [];
    await sendHtml(api, { chatId, text: "a **b** & c" }, (error) => seen.push(error));
    expect(seen).toHaveLength(1);
    expect(api.callCount("sendMessage")).toBe(2);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toBe("a **b** & c");
    expect(api.sent[0]?.parseMode).toBeUndefined();
  });

  test("a throwing onFallback callback never prevents the plain-text resend, which happens once", async () => {
    const api = new FakeBotApi();
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities: x", { status: 400 }));
    let called = 0;
    const result = await sendHtml(api, { chatId, text: "a **b** & c" }, () => {
      called += 1;
      throw new Error("observer blew up");
    });
    expect(called).toBe(1);
    expect(result.message_id).toBeGreaterThan(0);
    expect(api.callCount("sendMessage")).toBe(2);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toBe("a **b** & c");
    expect(api.sent[0]?.parseMode).toBeUndefined();
  });

  test("the keyboard and the topic survive the fallback", async () => {
    const api = new FakeBotApi();
    const topic = await api.createForumTopic({ chatId, name: "t" });
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities: x", { status: 400 }));
    const inlineKeyboard = [[{ text: "Allow", callback_data: "a:1" }, { text: "Deny", callback_data: "d:1" }]];
    await sendHtml(api, { chatId, text: "run **it**?", messageThreadId: topic.message_thread_id, inlineKeyboard });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toBe("run **it**?");
    expect(api.sent[0]?.parseMode).toBeUndefined();
    expect(api.sent[0]?.inlineKeyboard).toEqual(inlineKeyboard);
    expect(api.sent[0]?.messageThreadId).toBe(topic.message_thread_id);
  });

  test("the plain resend is attempted once: a second failure is thrown", async () => {
    const api = new FakeBotApi();
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities: x", { status: 400 }), 2);
    await expect(sendHtml(api, { chatId, text: "x" })).rejects.toThrow();
    expect(api.callCount("sendMessage")).toBe(2);
  });

  test("another error is not a formatting problem and is not retried as plain text", async () => {
    const api = new FakeBotApi();
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: chat not found", { status: 400 }));
    await expect(sendHtml(api, { chatId, text: "x" })).rejects.toThrow("chat not found");
    expect(api.callCount("sendMessage")).toBe(1);
  });

  test("isEntityParseError matches only the 400 about entities", () => {
    expect(isEntityParseError(new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities: x", { status: 400 }))).toBe(true);
    expect(isEntityParseError(new BotApiError("rejected", "sendMessage: 400 Bad Request: message is too long", { status: 400 }))).toBe(false);
    expect(isEntityParseError(new BotApiError("server", "sendMessage: 500 can't parse entities", { status: 500 }))).toBe(false);
    expect(isEntityParseError(new Error("can't parse entities"))).toBe(false);
  });
});

describe("the fake Bot API and HTML", () => {
  const chatId = -1001234567890;

  test("rejects malformed HTML with a 400 'can't parse entities'", async () => {
    const api = new FakeBotApi();
    await expect(api.sendMessage({ chatId, text: "<b>open", parseMode: "HTML" })).rejects.toThrow("can't parse entities");
    await expect(api.sendMessage({ chatId, text: "a < b", parseMode: "HTML" })).rejects.toThrow("can't parse entities");
    expect(api.sent).toHaveLength(0);
  });

  test("counts the 4096 limit after parsing: tags do not count, entities count once", async () => {
    const api = new FakeBotApi();
    const text = `<b>${"a".repeat(4090)}</b> &amp;&amp;&amp;`;
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_TEXT);
    await api.sendMessage({ chatId, text, parseMode: "HTML" });
    await expect(api.sendMessage({ chatId, text: `<b>${"a".repeat(4097)}</b>`, parseMode: "HTML" })).rejects.toThrow("too long");
  });

  test("plain text is not parsed", async () => {
    const api = new FakeBotApi();
    await api.sendMessage({ chatId, text: "<b>open & < >" });
    expect(api.sent[0]?.parseMode).toBeUndefined();
  });
});
