import { describe, expect, test } from "bun:test";
import { buildFqn, catalogForServer, FQN_PATTERN, mergeCatalogs, resolveFqn } from "./catalog";

const tool = (name: string, over: Record<string, unknown> = {}): never =>
  ({ name, ...over }) as never;

describe("AC3 — an unqualifiable tool is skipped AND said so", () => {
  test("a name over 64 characters is skipped with its length in the reason", () => {
    const long = "x".repeat(60);
    const { entries, skipped } = catalogForServer("srv", [tool(long)]);

    // Both halves. Absent-and-unexplained is indistinguishable from a tool
    // the server never had, and the operator debugs the server.
    expect(entries).toEqual([]);
    expect(skipped[0]?.reason).toContain("64");
    expect(skipped[0]?.rawName).toBe(long);
  });

  test("a name that cannot start an identifier is skipped with the pattern named", () => {
    // The FQN begins with the SERVER name, so this is a server called `9bad`.
    const { entries, skipped } = catalogForServer("9bad", [tool("read")]);
    expect(entries).toEqual([]);
    expect(skipped[0]?.reason).toContain("^[a-zA-Z_]");
  });

  test("a good tool alongside a bad one still reaches the catalog", () => {
    const { entries, skipped } = catalogForServer("srv", [tool("read"), tool("x".repeat(70))]);
    expect(entries.map((e) => e.fqn)).toEqual(["srv__read"]);
    expect(skipped).toHaveLength(1);
  });

  test("a duplicate raw name is skipped rather than shadowing the first", () => {
    // Two tools answering to one FQN means one is unreachable, and which one
    // should not be something the operator discovers by calling it.
    const { entries, skipped } = catalogForServer("srv", [tool("read"), tool("read")]);
    expect(entries).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("duplicate");
  });
});

describe("qualified names", () => {
  test("the delimiter is __, not _", () => {
    // A single underscore cannot be split back into server and tool when
    // either half contains one, and `use_tool` must route an FQN to its owner.
    expect(buildFqn("linear", "create_issue")).toBe("linear__create_issue");
  });

  test("the pattern accepts what the specification accepts and rejects the rest", () => {
    expect(FQN_PATTERN.test("a")).toBe(true);
    expect(FQN_PATTERN.test("_x-1")).toBe(true);
    expect(FQN_PATTERN.test("x".repeat(64))).toBe(true);
    expect(FQN_PATTERN.test("x".repeat(65))).toBe(false);
    expect(FQN_PATTERN.test("1x")).toBe(false);
    expect(FQN_PATTERN.test("has space")).toBe(false);
    expect(FQN_PATTERN.test("")).toBe(false);
  });

  test("an entry keeps the RAW name, which is what tools/call must send", () => {
    // Sending the FQN back to the server would be a call for a tool it does
    // not have.
    const { entries } = catalogForServer("linear", [tool("create_issue")]);
    expect(entries[0]?.fqn).toBe("linear__create_issue");
    expect(entries[0]?.rawName).toBe("create_issue");
  });
});

describe("merging servers", () => {
  test("entries from several servers coexist and resolve to their owner", () => {
    const merged = mergeCatalogs([
      catalogForServer("a", [tool("read")]),
      catalogForServer("b", [tool("read")]),
    ]);

    expect(merged.entries.map((e) => e.fqn)).toEqual(["a__read", "b__read"]);
    expect(resolveFqn(merged, "b__read")?.server).toBe("b");
  });

  test("a genuine collision names the server that already owns the name", () => {
    // Cannot happen through config, which is keyed by name — asserted anyway,
    // because if it ever did occur it would shadow one server's whole toolset.
    const merged = mergeCatalogs([
      catalogForServer("a", [tool("read")]),
      catalogForServer("a", [tool("read")]),
    ]);
    expect(merged.entries).toHaveLength(1);
    expect(merged.skipped[0]?.reason).toContain('already provided by server "a"');
  });

  test("skips from every server survive the merge", () => {
    const merged = mergeCatalogs([
      catalogForServer("a", [tool("x".repeat(70))]),
      catalogForServer("b", [tool("y".repeat(70))]),
    ]);
    expect(merged.skipped.map((s) => s.server)).toEqual(["a", "b"]);
  });

  test("an unknown FQN resolves to nothing rather than to the first entry", () => {
    const merged = mergeCatalogs([catalogForServer("a", [tool("read")])]);
    expect(resolveFqn(merged, "a__missing")).toBeUndefined();
  });
});
