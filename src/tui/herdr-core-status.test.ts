import { describe, expect, test } from "bun:test";
import {
  createHerdrCoreReporter,
  createStatusWriter,
  encodeOsc7501,
  HERDR_CORE_CLEAR,
  herdrCoreStateFor,
  prepareStatusMessage,
  type HerdrCoreState,
} from "./herdr-core-status";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const decodeMsg = (seq: string): string => {
  const m = /:msg=([A-Za-z0-9+/=]*)/.exec(seq);
  return m === null ? "" : Buffer.from(m[1] ?? "", "base64").toString("utf8");
};
// Built at runtime, as the other suites do, so no token-shaped literal sits in the source.
const FAKE_TOKEN = `ghp_${"A".repeat(36)}`;

describe("encodeOsc7501", () => {
  test("pins the herdr-core wire format byte-exactly", () => {
    expect(encodeOsc7501({ state: "working" })).toBe("\x1b]7501;state=working:app=keryx\x1b\\");
    expect(encodeOsc7501({ state: "blocked", kind: "permission", msg: "Apply?" })).toBe(
      `\x1b]7501;state=blocked:kind=permission:app=keryx:msg=${b64("Apply?")}\x1b\\`,
    );
    expect(b64("Apply?")).toBe("QXBwbHk/");
  });

  test("field order is state, kind, progress, app, title, msg", () => {
    const out = encodeOsc7501({ state: "blocked", kind: "question", progress: 40, title: "T", msg: "M" });
    expect(out).toBe(`\x1b]7501;state=blocked:kind=question:progress=40:app=keryx:title=${b64("T")}:msg=${b64("M")}\x1b\\`);
  });

  test("Cyrillic text round-trips through base64", () => {
    const out = encodeOsc7501({ state: "blocked", kind: "question", msg: "Применить изменения?" });
    expect(decodeMsg(out)).toBe("Применить изменения?");
  });

  test("empty fields are omitted", () => {
    expect(encodeOsc7501({ state: "idle", title: "", msg: "" })).toBe("\x1b]7501;state=idle:app=keryx\x1b\\");
  });

  test("refuses an unknown state, bad app, kind without blocked, bad progress", () => {
    expect(() => encodeOsc7501({ state: "bogus" as HerdrCoreState })).toThrow(/unknown state/);
    expect(() => encodeOsc7501({ state: "idle" }, "Bad App")).toThrow(/app/);
    expect(() => encodeOsc7501({ state: "working", kind: "permission" })).toThrow(/blocked/);
    expect(() => encodeOsc7501({ state: "working", progress: 101 })).toThrow(/progress/);
    expect(() => encodeOsc7501({ state: "working", progress: 1.5 })).toThrow(/progress/);
  });
});

describe("herdrCoreStateFor", () => {
  test("maps every status", () => {
    expect(herdrCoreStateFor("queued")).toEqual({ state: "idle" });
    expect(herdrCoreStateFor("running")).toEqual({ state: "working" });
    expect(herdrCoreStateFor("done")).toEqual({ state: "done" });
    expect(herdrCoreStateFor("failed")).toEqual({ state: "error" });
    expect(herdrCoreStateFor("blocked")).toEqual({ state: "blocked", kind: "permission" });
    expect(herdrCoreStateFor("blocked", { kind: "permission", text: "rm -rf x" })).toEqual({
      state: "blocked",
      kind: "permission",
      msg: "rm -rf x",
    });
    expect(herdrCoreStateFor("blocked", { kind: "question", text: "Which?" })).toEqual({
      state: "blocked",
      kind: "question",
      msg: "Which?",
    });
    expect(HERDR_CORE_CLEAR).toEqual({ state: "clear" });
  });
});

describe("prepareStatusMessage (AC4)", () => {
  test("a secret in the command is absent from the decoded msg; one line; <= 200 chars", () => {
    const cmd = `curl -H "Authorization: token ${FAKE_TOKEN}"\n  https://api.example.com\n\tdone`;
    const out = prepareStatusMessage(cmd, (s) => s.replace(FAKE_TOKEN, "[REDACTED]"));
    expect(out).not.toContain("\n");
    // and with the REAL redactor, via the reporter
    const writes: string[] = [];
    const r = createHerdrCoreReporter({ env: { HC_TERMINAL_ID: "t1" }, write: (b) => writes.push(b) });
    r.report(herdrCoreStateFor("blocked", { kind: "permission", text: cmd + " " + "x".repeat(400) }));
    expect(writes).toHaveLength(1);
    const decoded = decodeMsg(writes[0] ?? "");
    expect(decoded).not.toContain(FAKE_TOKEN);
    expect(decoded).not.toContain("\n");
    expect(Array.from(decoded).length).toBeLessThanOrEqual(200);
    expect(decoded.length).toBeGreaterThan(0);
  });

  test("the real redactor really redacts the fake token", () => {
    expect(prepareStatusMessage(`export GITHUB_TOKEN=${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN);
  });

  test("cuts on a code-point boundary", () => {
    const out = prepareStatusMessage("😀".repeat(300), (s) => s);
    expect(Array.from(out)).toHaveLength(200);
    expect(out).toBe("😀".repeat(200));
  });
});

describe("createHerdrCoreReporter", () => {
  test("inert with HC_TERMINAL_ID unset or empty", () => {
    for (const env of [{}, { HC_TERMINAL_ID: "" }]) {
      const writes: string[] = [];
      const r = createHerdrCoreReporter({ env, write: (b) => writes.push(b) });
      r.report({ state: "working" });
      r.clear();
      expect(writes).toEqual([]);
    }
  });

  test("one write per change, dedupes identical, clear resets memory", () => {
    const writes: string[] = [];
    const r = createHerdrCoreReporter({ env: { HC_TERMINAL_ID: "t1" }, write: (b) => writes.push(b) });
    r.report({ state: "working" });
    r.report({ state: "working" });
    expect(writes).toHaveLength(1);
    r.report({ state: "idle" });
    expect(writes).toHaveLength(2);
    r.clear();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toBe("\x1b]7501;state=clear:app=keryx\x1b\\");
    r.report({ state: "idle" });
    expect(writes).toHaveLength(4);
  });

  test("a throwing writer never propagates", () => {
    const r = createHerdrCoreReporter({
      env: { HC_TERMINAL_ID: "t1" },
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => r.report({ state: "working" })).not.toThrow();
    expect(() => r.clear()).not.toThrow();
  });
});

describe("createStatusWriter (AC5)", () => {
  test("uses renderer.writeOut once per sequence, never stdout", () => {
    const calls: string[] = [];
    const out: string[] = [];
    const renderer = {
      tag: "r",
      writeOut(chunk: string) {
        expect(this.tag).toBe("r");
        calls.push(chunk);
      },
    };
    const w = createStatusWriter(() => renderer, (s) => out.push(s));
    w("a");
    w("b");
    expect(calls).toEqual(["a", "b"]);
    expect(out).toEqual([]);
  });

  test("falls back to stdout without a renderer or without writeOut", () => {
    const out: string[] = [];
    createStatusWriter(() => undefined, (s) => out.push(s))("x");
    createStatusWriter(() => ({}), (s) => out.push(s))("y");
    createStatusWriter(() => ({ writeOut: 1 }), (s) => out.push(s))("z");
    expect(out).toEqual(["x", "y", "z"]);
  });
});
