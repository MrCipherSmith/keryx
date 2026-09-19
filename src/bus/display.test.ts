// `./display.ts` (specification §7.3; review r1 F5, F4, F10, F11).

import { describe, expect, test } from "bun:test";
import type { RenderedBusEvent } from "./client";
import { displaySafe, formatBusEventLine, makeBusErrorReporter } from "./display";

const ESC = "\x1b";

function event(overrides: Partial<RenderedBusEvent> = {}): RenderedBusEvent {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    seq: 12,
    shortId: "7c9e6679",
    fromName: "release",
    fromInstanceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    kind: "notice",
    preview: "hello",
    ...overrides,
  };
}

describe("displaySafe (review r1 F5, F11)", () => {
  test("strips CSI sequences", () => {
    expect(displaySafe(`${ESC}[31mred${ESC}[0m text`)).toBe("red text");
  });

  test("strips an OSC sequence terminated by BEL", () => {
    expect(displaySafe(`before${ESC}]0;title\x07after`)).toBe("beforeafter");
  });

  test("strips an OSC sequence terminated by ST (ESC \\\\)", () => {
    expect(displaySafe(`before${ESC}]8;;http://example${ESC}\\after`)).toBe("beforeafter");
  });

  test("turns any other C0/C1 control byte and DEL into a space, then collapses whitespace", () => {
    expect(displaySafe("a\x00b\x1fc\x7fde")).toBe("a b c d e");
  });

  test("collapses runs of whitespace and trims", () => {
    expect(displaySafe("  a   b\n\nc  ")).toBe("a b c");
  });

  test("plain text is untouched", () => {
    expect(displaySafe("flow 273 task T11A")).toBe("flow 273 task T11A");
  });
});

describe("formatBusEventLine (review r1 F4)", () => {
  test("renders ⇄ [#seq] @fromName kind: preview", () => {
    expect(formatBusEventLine(event())).toBe("⇄ [#12] @release notice: hello");
  });

  test("every free-text part is displaySafe'd, even if the caller built the event by hand", () => {
    const dirty = event({
      fromName: `evil${ESC}[31m`,
      kind: "question",
      preview: `hi${ESC}]0;pwned\x07 there`,
    });
    const line = formatBusEventLine(dirty);
    expect(line).not.toContain(ESC);
    expect(line).toBe("⇄ [#12] @evil question: hi there");
  });
});

describe("makeBusErrorReporter (review r1 F10, F11)", () => {
  test("prints bus: <where> failed: <message> on the first call", () => {
    const lines: string[] = [];
    const report = makeBusErrorReporter((line) => lines.push(line));
    report(new Error("boom"), "poll");
    expect(lines).toEqual(["bus: poll failed: boom"]);
  });

  test("suppresses a repeat for the same `where` within the window, but not after it elapses", async () => {
    const lines: string[] = [];
    const report = makeBusErrorReporter((line) => lines.push(line), 20);
    report(new Error("first"), "heartbeat");
    report(new Error("second"), "heartbeat"); // within the window: suppressed
    expect(lines).toEqual(["bus: heartbeat failed: first"]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    report(new Error("third"), "heartbeat"); // window elapsed: printed
    expect(lines).toEqual(["bus: heartbeat failed: first", "bus: heartbeat failed: third"]);
  });

  test("each `where` has its own independent window", () => {
    const lines: string[] = [];
    const report = makeBusErrorReporter((line) => lines.push(line), 60_000);
    report(new Error("poll broke"), "poll");
    report(new Error("heartbeat broke"), "heartbeat");
    report(new Error("session broke"), "session");
    expect(lines).toEqual([
      "bus: poll failed: poll broke",
      "bus: heartbeat failed: heartbeat broke",
      "bus: session failed: session broke",
    ]);
  });

  test("a non-Error thrown value is stringified", () => {
    const lines: string[] = [];
    const report = makeBusErrorReporter((line) => lines.push(line));
    report("plain string failure", "poll");
    expect(lines).toEqual(["bus: poll failed: plain string failure"]);
  });

  test("the message itself is displaySafe'd", () => {
    const lines: string[] = [];
    const report = makeBusErrorReporter((line) => lines.push(line));
    report(new Error(`nasty${ESC}[31m message`), "poll");
    expect(lines).toEqual(["bus: poll failed: nasty message"]);
  });
});
