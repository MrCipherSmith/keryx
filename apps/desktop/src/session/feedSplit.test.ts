import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "../acp/types";
import { applyUpdates, newConv, type ConvState, type Item } from "./reducer";
import { isLegacySystemText, isSystemMeta, parseSystemNote } from "./systemNote";

const u = (x: Record<string, unknown>) => x as unknown as SessionUpdate;
const agent = (text: string, meta?: unknown) =>
  u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(meta !== undefined ? { _meta: meta } : {}) });
const SYSTEM = { keryx: { system: true } };
const apply = (c: ConvState, ...updates: SessionUpdate[]) => applyUpdates(c, updates.map((update, i) => ({ update, at: i })));
const shape = (items: readonly Item[]) =>
  items.map((i) => {
    if (i.kind === "notice") return { kind: "notice", level: i.level, tag: i.system?.tag ?? null, text: i.text };
    if (i.kind === "block") return { kind: "block", role: i.role, type: i.block.type };
    return { kind: i.kind, text: "text" in i ? i.text : "" };
  });

const GATE_CONTINUE = "\n[review-gate] Review not complete (continue 1); `review complete` still refuses. Continuing.\n";
const GATE_STOP =
  "\n[review-gate] Review r02 is not complete after 3 continue(s). `keryx review complete` would still be refused on:\n" +
  "- research scope census is incomplete\n- raw observations are not reconciled\n";

describe("system notes", () => {
  test("parseSystemNote takes the tag off and grades the level", () => {
    expect(parseSystemNote(GATE_CONTINUE)).toEqual({
      tag: "review-gate",
      body: "Review not complete (continue 1); `review complete` still refuses. Continuing.",
      level: "info",
    });
    const stop = parseSystemNote(GATE_STOP);
    expect(stop.tag).toBe("review-gate");
    expect(stop.level).toBe("warn");
    expect(stop.body).toContain("\n- research scope census is incomplete");
    expect(parseSystemNote("\n[error] boom\n").level).toBe("error");
    expect(parseSystemNote("\n[budget] 90% spent\n").level).toBe("warn");
    expect(parseSystemNote("keryx: MCP server \"x\" failed\n")).toEqual({ tag: null, body: 'keryx: MCP server "x" failed', level: "info" });
  });

  test("isSystemMeta reads keryx's marker and nothing else", () => {
    expect(isSystemMeta(SYSTEM)).toBe(true);
    expect(isSystemMeta({ keryx: { selfAnsweredQuestion: true } })).toBe(true);
    expect(isSystemMeta({ keryx: { system: "yes" } })).toBe(false);
    expect(isSystemMeta(undefined)).toBe(false);
    expect(isSystemMeta(null)).toBe(false);
  });

  test("an unmarked chunk counts as a note only in system()'s exact shape with a known tag", () => {
    expect(isLegacySystemText(GATE_CONTINUE)).toBe(true);
    expect(isLegacySystemText("\n[plan] next step\n")).toBe(true);
    expect(isLegacySystemText("[review-gate] no leading newline\n")).toBe(false);
    expect(isLegacySystemText("\n[review-gate] no trailing newline")).toBe(false);
    expect(isLegacySystemText("\n[note] unknown tag\n")).toBe(false);
    expect(isLegacySystemText("\n[1] a footnote\n")).toBe(false);
  });
});

describe("reducer: keryx notes are split out of the reply", () => {
  test("a marked note between two reply chunks becomes its own notice, and the reply resumes as a new message", () => {
    const c = apply(newConv("s", { replaying: false }), agent("The blocker stays: review tier said no."), agent(GATE_CONTINUE, SYSTEM), agent("Blocker: the router"));
    expect(shape(c.items)).toEqual([
      { kind: "agent", text: "The blocker stays: review tier said no." },
      {
        kind: "notice",
        level: "info",
        tag: "review-gate",
        text: "Review not complete (continue 1); `review complete` still refuses. Continuing.",
      },
      { kind: "agent", text: "Blocker: the router" },
    ]);
  });

  test("the gate's final report keeps its list of reasons for the Markdown notice", () => {
    const c = apply(newConv("s", { replaying: false }), agent("x"), agent(GATE_STOP, SYSTEM));
    const note = c.items[1];
    expect(note?.kind).toBe("notice");
    if (note?.kind === "notice") {
      expect(note.level).toBe("warn");
      expect(note.text.split("\n").slice(1)).toEqual(["- research scope census is incomplete", "- raw observations are not reconciled"]);
    }
  });

  test("an older keryx's unmarked gate line is split out too", () => {
    const c = apply(newConv("s", { replaying: false }), agent("prose"), agent(GATE_CONTINUE), agent("more prose"));
    expect(c.items.map((i) => i.kind)).toEqual(["agent", "notice", "agent"]);
  });

  test("the model's own bracketed text mid-stream stays in the reply", () => {
    const c = apply(newConv("s", { replaying: false }), agent("See "), agent("[plan] the plan"), agent(" below.\n"));
    expect(shape(c.items)).toEqual([{ kind: "agent", text: "See [plan] the plan below.\n" }]);
  });

  test("an empty marked note adds nothing", () => {
    const c0 = newConv("s", { replaying: false });
    expect(apply(c0, agent("\n\n", SYSTEM))).toBe(c0);
  });
});

describe("reducer: non-text content blocks", () => {
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };

  test("an agent image sits between the text around it as its own item", () => {
    const c = apply(
      newConv("s", { replaying: false }),
      agent("before"),
      u({ sessionUpdate: "agent_message_chunk", content: image }),
      agent("after"),
    );
    expect(shape(c.items)).toEqual([
      { kind: "agent", text: "before" },
      { kind: "block", role: "agent", type: "image" },
      { kind: "agent", text: "after" },
    ]);
  });

  test("resource links and embedded resources are kept as blocks; a replayed user image is the user's", () => {
    const c = apply(
      newConv("s", { replaying: true }),
      u({ sessionUpdate: "user_message_chunk", content: image }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "resource_link", name: "a.ts", uri: "file:///a.ts" } }),
      u({ sessionUpdate: "agent_message_chunk", content: { type: "resource", resource: { uri: "file:///b.md", text: "# b" } } }),
    );
    expect(shape(c.items)).toEqual([
      { kind: "block", role: "user", type: "image" },
      { kind: "block", role: "agent", type: "resource_link" },
      { kind: "block", role: "agent", type: "resource" },
    ]);
  });

  test("an unknown block type is still ignored", () => {
    const c0 = newConv("s", { replaying: false });
    expect(apply(c0, u({ sessionUpdate: "agent_message_chunk", content: { type: "audio", data: "x", mimeType: "audio/wav" } }))).toBe(c0);
  });
});
