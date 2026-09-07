import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJsonFile, readJsonFileOr, readJsonObjectFile } from "./json";

/**
 * T43 (T39-review.md "Judgement calls" #4): `readJsonFileOr` falls back only
 * when the payload does not PARSE. A file whose whole content is `null`, `[]`,
 * `42` or `"advisory"` parses fine and is handed to a caller that asked for an
 * object, under a signature that promised the fallback's type. Three separate
 * repairs this phase started from that: a security gate that vanished from a
 * completion record, enforcement downgraded to advisory, and a clean exit code
 * for a check that never ran.
 *
 * The ruling was NOT to change `readJsonFileOr` — 30 call sites across 23 files
 * pass it non-object payloads legitimately, and a changed contract is not
 * opt-in — but to add a sibling that can say which of the three things
 * happened. These tests fix both halves: the new reader's three states, and
 * `readJsonFileOr`'s unchanged behaviour on exactly the payloads that would
 * have moved had the sibling been a rewrite instead.
 */

async function withFile<T>(
  body: string | null,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-json-read-"));
  try {
    const filePath = path.join(dir, "payload.json");
    if (body !== null) {
      await writeFile(filePath, body, "utf8");
    }
    return await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readJsonObjectFile: a plain object payload reports state 'object' and hands back exactly what it verified", async () => {
  await withFile('{"mode":"ci","policies":{"secrets":{"enabled":true}}}', async (file) => {
    const read = await readJsonObjectFile(file);
    expect(read.state).toBe("object");
    if (read.state !== "object") return;
    expect(read.value.mode).toBe("ci");
    expect(read.value.policies).toEqual({ secrets: { enabled: true } });
  });

  // An empty object is a legitimate payload, not an absence: this is the case
  // `readJsonFileOr(file, {})` cannot tell apart from a parse failure, and the
  // reason `config.ts` and `guard.ts` each had to invent a Symbol.
  await withFile("{}", async (file) => {
    const read = await readJsonObjectFile(file);
    expect(read.state).toBe("object");
    if (read.state !== "object") return;
    expect(Object.keys(read.value)).toEqual([]);
  });
});

test("readJsonObjectFile: every non-object payload that still parses reports state 'non-object' and carries the payload", async () => {
  const cases: Array<{ body: string; value: unknown }> = [
    { body: "null", value: null },
    { body: "[]", value: [] },
    { body: '[{"tools":[]}]', value: [{ tools: [] }] },
    { body: "42", value: 42 },
    { body: '"advisory"', value: "advisory" },
    { body: "true", value: true },
  ];
  for (const testCase of cases) {
    await withFile(testCase.body, async (file) => {
      const read = await readJsonObjectFile(file);
      expect(read.state).toBe("non-object");
      if (read.state !== "non-object") return;
      expect(read.value).toEqual(testCase.value);
    });
  }
});

test("readJsonObjectFile: a payload that does not parse, an empty file, whitespace and an absent file all report state 'unreadable'", async () => {
  for (const body of ["{not json", "", "   \n ", "{"]) {
    await withFile(body, async (file) => {
      expect((await readJsonObjectFile(file)).state).toBe("unreadable");
    });
  }
  await withFile(null, async (file) => {
    expect((await readJsonObjectFile(file)).state).toBe("unreadable");
  });
});

test("readJsonObjectFile: an own `__proto__` member is data on the returned object and never reaches the prototype", async () => {
  await withFile('{"__proto__":{"modules":{"security":{"enabled":true}}}}', async (file) => {
    const read = await readJsonObjectFile(file);
    expect(read.state).toBe("object");
    if (read.state !== "object") return;
    // JSON.parse gives this payload an OWN `__proto__` data property; its own
    // `modules` is absent, which is what the manifest reader must see.
    expect(read.value.modules).toBeUndefined();
    expect((Object.prototype as unknown as { modules?: unknown }).modules).toBeUndefined();
  });
});

test("readJsonObjectFile: the returned object state does not promise a shape it did not check", async () => {
  // The whole point of dropping the type parameter: what comes back is
  // `Record<string, unknown>` — the fact that WAS verified — so a caller must
  // narrow rather than receive a lie in the type. A payload that is an object
  // but has none of the caller's fields is still `state: "object"`.
  await withFile('{"unrelated":1}', async (file) => {
    const read = await readJsonObjectFile(file);
    expect(read.state).toBe("object");
    if (read.state !== "object") return;
    expect(read.value.gate).toBeUndefined();
  });
});

test("readJsonFileOr is unchanged: it still returns non-object payloads verbatim and falls back only on a parse failure", async () => {
  // The migration must not move these. A reader that started returning the
  // fallback for arrays would break the honest callers quietly (T39 #4.3).
  await withFile("[1,2,3]", async (file) => {
    expect(await readJsonFileOr<unknown>(file, { fallback: true })).toEqual([1, 2, 3]);
  });
  await withFile("42", async (file) => {
    expect(await readJsonFileOr<unknown>(file, {})).toBe(42);
  });
  await withFile("null", async (file) => {
    expect(await readJsonFileOr<unknown>(file, { fallback: true })).toBeNull();
  });
  await withFile("{not json", async (file) => {
    expect(await readJsonFileOr<unknown>(file, { fallback: true })).toEqual({ fallback: true });
  });
  await withFile(null, async (file) => {
    expect(await readJsonFileOr<unknown>(file, { fallback: true })).toEqual({ fallback: true });
  });
});

test("readJsonFile is unchanged: it throws a path-qualified error and never leaks the file body", async () => {
  await withFile('{"secret":"AKIAIOSFODNN7EXAMPLE"', async (file) => {
    let message: string | null = null;
    try {
      await readJsonFile<unknown>(file);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Invalid JSON in");
    expect(message).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
