import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requiredReviewers } from "./coverage";
import { type LedgerInputs, type RawFile, buildLedger, ledgerBlockers, parseReviewResult } from "./ledger";
import type { MutationRecord } from "./mutate";
import { emptyRetryState, planRetry, scopeFingerprint } from "./retry-plan";
import { auditPackage, auditSeverity } from "./severity-audit";
import type { SliceManifest } from "./slice";

let root: string;

async function install(name: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-ledger-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of ["review-orchestrator", "review-logic", "review-architecture", "review-testing-practices"]) await install(name);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FILES = ["src/a.ts", "src/b.test.ts"];

function slice(id: string, files: string[], extra: Record<string, unknown> = {}) {
  return { id, path: `${id}.diff`, bytes: 100, contentHash: `test-content-${id}`, files, domain: "src", split: "domain" as const, ...extra };
}

const MANIFEST = {
  schemaVersion: 1,
  maxBytes: 18000,
  source: "diff",
  slices: [slice("slice-01", ["src/a.ts"]), slice("slice-02", ["src/b.test.ts"])],
  omissions: [],
  totals: { slices: 2, bytes: 200, files: 2, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
} as SliceManifest;

let clock = 0;
function raw(reviewer: string, status: string, extra: Record<string, unknown> = {}, name = `raw/${reviewer}.txt`): RawFile {
  clock += 1;
  return { name, hash: `h${clock}`, mtimeMs: clock, empty: false, result: { reviewer, status, summary: "s", findings: [], needs_context: [], ...extra } };
}

async function inputs(overrides: Partial<LedgerInputs> = {}): Promise<LedgerInputs> {
  const required = (await requiredReviewers(root, "all", FILES)).required;
  return {
    mode: "all",
    selected: required,
    manifest: MANIFEST,
    payloadSlices: Object.fromEntries(required.map((r) => [r, ["slice-01", "slice-02"]])),
    payloadDispatchCounts: Object.fromEntries(required.map((r) => [r, 1])),
    ruleFiles: Object.fromEntries(required.map((r) => [r, `.metaproject/skills/gdskills/review/${r}/SKILL.md`])),
    raws: required.map((r) => raw(r, "DONE")),
    retry: { schemaVersion: 1, reviewers: {} },
    canonical: [],
    dispositions: [],
    manifestPath: "slices/manifest.json",
    ...overrides,
  };
}

const blockersOf = (result: ReturnType<typeof buildLedger>, canonical: Array<Record<string, unknown>> = []) =>
  ledgerBlockers(result.ledger, canonical, { root, files: FILES });

describe("parseReviewResult", () => {
  test("takes the last fenced block that is a result: a REVIEW_RESULT fence needs a status, a json fence a reviewer or findings", () => {
    const labelled = 'STATUS: DONE\n\n```REVIEW_RESULT\n{"status":"DONE","reviewer":"review-logic","findings":[]}\n```\n';
    expect(parseReviewResult(labelled)?.reviewer).toBe("review-logic");
    const twoBlocks = '```json\n{"status":"BLOCKED","reviewer":"a"}\n```\ntext\n```json\n{"status":"DONE","reviewer":"b"}\n```\n';
    expect(parseReviewResult(twoBlocks)?.reviewer).toBe("b");
  });

  test("an escaped quote inside a string does not end it, so a brace after it does not close the object", () => {
    const object = { reviewer: "review-logic", status: "DONE", note: 'said "} now' };
    expect(parseReviewResult(`Done.\n${JSON.stringify(object)}\n`)).toEqual(object);
  });

  test("a bare object before a fence is not fenced: two bare objects with different statuses stay ambiguous", () => {
    const first = { reviewer: "review-logic", status: "DONE" };
    const second = { reviewer: "review-logic", status: "BLOCKED" };
    const raw = `${JSON.stringify(first)}\n\`\`\`text\nplain notes\n\`\`\`\n${JSON.stringify(second)}\n`;
    expect(parseReviewResult(raw)).toBeUndefined();
  });

  describe("a complete result is not lost to prose that looks like JSON", () => {
    const good = { reviewer: "r", status: "DONE", findings: [] };
    const goodJson = JSON.stringify(good);

    test("an unclosed fragment that does not carry the result keys is skipped, before or after the result", () => {
      for (const reply of [
        `I saw {"foo": in the code\n${goodJson}`,
        `${goodJson}\nnote: the literal {"x is bad`,
        `${goodJson}\nSee \`foo({"a":1\``,
        `${goodJson}\n{"`,
        `\`\`\`json\n${goodJson}\n\`\`\`\ntext {"x`,
        `He said "{" then\n${goodJson}`,
      ]) expect(parseReviewResult(reply)).toEqual(good);
    });

    test("a value that reads like a result key is not a key", () => {
      expect(parseReviewResult(`${goodJson}\nprose {"note": "status", more`)).toEqual(good);
    });

    test("an unclosed object that carries the result keys is still a truncated reply", () => {
      expect(parseReviewResult('{"status":"DONE","reviewer":"r","findings":[{"severity":"major"')).toBeUndefined();
      expect(parseReviewResult('{\n  "status": "DONE",\n  "reviewer": "r",\n  "findings": [\n')).toBeUndefined();
      expect(parseReviewResult(`${goodJson}\n{"status":"BLOCKED","reviewer":"x","findings":[`)).toBeUndefined();
    });

    test("a cut-off outer object that claims any one result key, in any spacing, hides the complete result nested in it", () => {
      const nested = '{"status":"DONE","reviewer":"inner","findings":[]}';
      for (const outer of ['{"status" : "DONE","notes":[', '{"reviewer":"r","notes":[', '{"status":"DONE","notes":[', '{"findings":[],"notes":[']) {
        expect(parseReviewResult(`${outer}${nested}`)).toBeUndefined();
      }
    });

    test("a result key that is only a fragment of a nested cut-off object ends the scan too, since the fragment is entered at its own brace", () => {
      expect(parseReviewResult('{"note":{"status":"DONE","reviewer":"r"')).toBeUndefined();
    });

    test("a marker whose object is not a reviewer result falls back to an earlier marker, then to the scan", () => {
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\nNote the REVIEW_RESULT: {"status":"X"} format is required`)).toEqual(good);
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\nI follow REVIEW_RESULT: {...}`)).toEqual(good);
      expect(parseReviewResult(`The REVIEW_RESULT {"a":1} stuff\n${goodJson}`)).toEqual(good);
      expect(parseReviewResult(`Per the REVIEW_RESULT {contract} I return:\n${goodJson}`)).toEqual(good);
    });

    test("whitespace after a label, and thousands of unclosed candidates, are read within two seconds", () => {
      const started = performance.now();
      expect(parseReviewResult(`\`\`\`REVIEW_RESULT${" \n".repeat(100_000)}`)).toBeUndefined();
      expect(parseReviewResult(`\`\`\`REVIEW_RESULT${"\n".repeat(100_000)}`)).toBeUndefined();
      expect(parseReviewResult('REVIEW_RESULT{"'.repeat(20_000))).toBeUndefined();
      expect(parseReviewResult('{"'.repeat(20_000))).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  test("returns nothing for prose, empty output or a block without a status", () => {
    expect(parseReviewResult("looks fine to me")).toBeUndefined();
    expect(parseReviewResult("(subagent produced no text)")).toBeUndefined();
    expect(parseReviewResult('```json\n{"verdict":"ok"}\n```')).toBeUndefined();
  });

  // Flow 441 (D-01, D-03, D-05, D-10): a bare reply gives the reviewer's result or nothing, never a fragment of it.
  describe("a bare reply (flow 441 AC11-AC15)", () => {
    const blocked = '{"status":"BLOCKED","reviewer":"r","findings":[]}';

    const entry = (id: string) => `{"id":"${id}","status":"DONE","reviewer":"${id}","findings":[]}`;

    test("AC11: a reply whose outer object never closes gives nothing, not a nested entry that looks like a result", () => {
      expect(parseReviewResult(`Result: {"status":"DONE","reviewer":"r","slices":[${entry("slice-01")},${entry("slice-02")}`)).toBeUndefined();
      expect(parseReviewResult(`Result: {"status":"DONE","reviewer":"r","slices":[${entry("slice-01")}`)).toBeUndefined();
      expect(parseReviewResult('REVIEW_RESULT: {"status":"DONE","reviewer":"b"')).toBeUndefined();
    });

    test("AC12: a trailing comma in `slices` or before the closing brace gives nothing, not a nested entry", () => {
      expect(parseReviewResult(`{"status":"DONE","reviewer":"r","slices":[${entry("s1")},],"findings":[]}`)).toBeUndefined();
      expect(parseReviewResult(`{"status":"DONE","reviewer":"r","findings":[${entry("s1")}],}`)).toBeUndefined();
    });

    test("AC13: two different statuses and no marker give nothing; a marker picks the object after it", () => {
      expect(parseReviewResult(`${blocked}\n{"status":"DONE"}`)).toBeUndefined();
      expect(parseReviewResult(`${blocked}\n{"status":"DONE","reviewer":"r","findings":[]}`)).toBeUndefined();
      expect(parseReviewResult(`REVIEW_RESULT: ${blocked}\n{"status":"DONE"}`)?.status).toBe("BLOCKED");
      expect(parseReviewResult(`${blocked}\nREVIEW_RESULT: {"status":"DONE","reviewer":"r","findings":[]}`)?.status).toBe("DONE");
      expect(parseReviewResult('REVIEW_RESULT: {"status":"DONE"}')).toBeUndefined();
    });

    test("AC13: the same status twice is not ambiguous, the last object is the result", () => {
      const first = '{"status":"DONE","reviewer":"a","findings":[]}';
      const second = '{"status":"DONE","reviewer":"b","findings":[]}';
      expect(parseReviewResult(`${first}\n${second}`)?.reviewer).toBe("b");
    });

    test("AC14: only an object with a status and a `reviewer` or a `findings` array counts", () => {
      expect(parseReviewResult('{"status":"DONE"}')).toBeUndefined();
      expect(parseReviewResult('{"status":"DONE","findings":"none"}')).toBeUndefined();
      expect(parseReviewResult('{"status":"DONE","reviewer":"r"}')?.reviewer).toBe("r");
      expect(parseReviewResult('{"status":"DONE","findings":[]}')?.status).toBe("DONE");
      expect(parseReviewResult('{"reviewer":"r","findings":[]}')).toBeUndefined();
      expect(parseReviewResult('REVIEW_RESULT: {"reviewer":"r","findings":[]}')).toBeUndefined();
    });

    test("AC14: a ```REVIEW_RESULT fence keeps the status-only rule", () => {
      expect(parseReviewResult('```REVIEW_RESULT\n{"status":"DONE"}\n```')?.status).toBe("DONE");
      expect(parseReviewResult('```REVIEW_RESULT\n{"reviewer":"r","findings":[]}\n```')).toBeUndefined();
    });

    test("AC15: the object after the marker is the result whatever other objects carry a status", () => {
      const reply = `{"status":"BLOCKED","reviewer":"a"}\nREVIEW_RESULT: {"status":"DONE","reviewer":"b"}\n{"status":"INCOMPLETE","reviewer":"c"}`;
      expect(parseReviewResult(reply)?.reviewer).toBe("b");
    });

    test("a prose brace before the result does not hide it, and a result with nested objects is read whole", () => {
      const reply = 'Checked the {config} block.\n{"status":"DONE","reviewer":"r","slices":[{"id":"s1","status":"DONE"}],"findings":[]}';
      const parsed = parseReviewResult(reply);
      expect(parsed?.reviewer).toBe("r");
      expect(Array.isArray(parsed?.slices) && parsed.slices.length).toBe(1);
    });

    test("an unbalanced prose brace before the result does not swallow it", () => {
      const reply = 'Use the { to open the block.\n{"status":"DONE","reviewer":"r","findings":[]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("r");
    });

    test("an unparseable outer object is skipped whole: a result-shaped object inside it is not read", () => {
      const inner = '{"status":"DONE","reviewer":"inner","findings":[]}';
      expect(parseReviewResult(`{"status":"DONE","reviewer":"r","findings":[${inner}],}`)).toBeUndefined();
    });

    test("a parsed result is not entered: a result-shaped object nested inside it does not replace it", () => {
      const reply = '{"status":"DONE","reviewer":"outer","findings":[{"status":"DONE","reviewer":"inner","findings":[]}]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("outer");
    });

    test("the last marker wins when a reply names the result twice", () => {
      const first = 'REVIEW_RESULT: {"status":"BLOCKED","reviewer":"first","findings":[]}';
      const second = 'REVIEW_RESULT: {"status":"DONE","reviewer":"second","findings":[]}';
      expect(parseReviewResult(`${first}\ncorrected:\n${second}`)?.reviewer).toBe("second");
    });

    test("a fenced result and a differing bare result are ambiguous: a fenced sample cannot be told from the real result", () => {
      const fenced = '```json\n{"status":"DONE","reviewer":"fenced","findings":[]}\n```';
      const bare = '{"status":"BLOCKED","reviewer":"bare","findings":[]}';
      expect(parseReviewResult(`${fenced}\n${bare}`)).toBeUndefined();
      expect(parseReviewResult(`${bare}\n${fenced}`)).toBeUndefined();
    });

    test("a fenced result beside a bare result with the same status is not ambiguous: the fenced one wins", () => {
      const fenced = '```json\n{"status":"DONE","reviewer":"fenced","findings":[]}\n```';
      const bare = '{"status":"DONE","reviewer":"bare","findings":[]}';
      expect(parseReviewResult(`${fenced}\n${bare}`)?.reviewer).toBe("fenced");
      expect(parseReviewResult(`${bare}\n${fenced}`)?.reviewer).toBe("fenced");
    });

    test("of two fenced results with different statuses the last decides: a bare result with its status is not ambiguous", () => {
      const first = '```json\n{"status":"BLOCKED","reviewer":"first","findings":[]}\n```';
      const second = '```json\n{"status":"DONE","reviewer":"second","findings":[]}\n```';
      const bare = '{"status":"DONE","reviewer":"bare","findings":[]}';
      expect(parseReviewResult(`${first}\n${second}\n${bare}`)?.reviewer).toBe("second");
    });

    test("a fenced result beside a bare object that is no reviewer result (a slice entry) is not ambiguous", () => {
      const reply = '```json\n{"status":"DONE","reviewer":"fenced","findings":[]}\n```\n{"id":"slice-01","status":"BLOCKED"}';
      expect(parseReviewResult(reply)?.reviewer).toBe("fenced");
    });

    test("a fenced example that is not a result does not hide the bare result after it", () => {
      const reply = 'Example of a slice entry:\n```json\n{"id":"slice-01","status":"DONE"}\n```\nMy result: {"status":"DONE","reviewer":"r","findings":[]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("r");
    });

    test("a fenced example with a different status does not make the bare result ambiguous", () => {
      const reply = '```json\n{"id":"slice-01","status":"NOT_READ"}\n```\n{"status":"DONE","reviewer":"r","findings":[]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("r");
    });

    test("a long run of whitespace after a marker, or thousands of fences, are read within two seconds", () => {
      const started = performance.now();
      expect(parseReviewResult(`REVIEW_RESULT${" ".repeat(200_000)}`)).toBeUndefined();
      expect(parseReviewResult(`see \`\`\`a\`\`\` and `.repeat(20_000))).toBeUndefined();
      const block = '```json\n{"status":"DONE","reviewer":"r","findings":[]}\n```\n';
      expect(parseReviewResult(block.repeat(60_000))?.reviewer).toBe("r");
      expect(performance.now() - started).toBeLessThan(2000);
    }, 20_000);
  });
});

// Flow 441 round 2 (PR 997): the marker rule, the caps, and the shapes a fix could silently change.
describe("parseReviewResult: marker, caps and fence shapes", () => {
  const good = { reviewer: "r", status: "DONE", findings: [] };
  const goodJson = JSON.stringify(good);
  const real = '{"status":"INCOMPLETE","reviewer":"review-logic","findings":[],"slices":["slice-01"]}';
  const quoted = 'REVIEW_RESULT: {"status":"DONE","reviewer":"review-logic","findings":[],"slices":["slice-01","slice-02"]}';

  describe("a marker counts only at the start of a line, outside a fence (F-001)", () => {
    // The quoted object is itself a reviewer-shaped object with another status, so the reply is ambiguous: no result (the reviewer is re-dispatched), never the quote.
    test("a marker quoted inside a sentence, before or after the real bare result, does not replace it: the reply gives no result", () => {
      expect(parseReviewResult(`The contract line \`${quoted}\` is quoted.\n${real}`)).toBeUndefined();
      expect(parseReviewResult(`${real}\nAs the contract says, ${quoted}`)).toBeUndefined();
    });

    test("a marker inside a fenced block (an example, a fixture) does not replace the real result: the reply gives no result", () => {
      expect(parseReviewResult(`\`\`\`text\n${quoted}\n\`\`\`\n${real}`)).toBeUndefined();
      expect(parseReviewResult(`${real}\n\`\`\`diff\n${quoted}\n\`\`\``)).toBeUndefined();
    });

    test("a quoted marker with the same status as the real bare result is not a replacement either", () => {
      const sameStatus = quoted.replace('"DONE"', '"INCOMPLETE"').replace('"slice-01","slice-02"', '"slice-09"');
      expect(parseReviewResult(`The contract line \`${sameStatus}\` is quoted.\n${real}`)?.slices).toEqual(["slice-01"]);
    });

    test("a marker after a quote, list or heading prefix at the start of a line still counts", () => {
      for (const prefix of ["", "  ", "> ", "- ", "* ", "## ", ">> "]) {
        expect(parseReviewResult(`${prefix}REVIEW_RESULT: ${goodJson}`)).toEqual(good);
      }
    });

    test("residual, pinned on purpose: a marker alone on its own line after the real marker result still wins, since it cannot be told from a correction", () => {
      const realMarker = `REVIEW_RESULT: ${real}`;
      expect(parseReviewResult(`${realMarker}\n${quoted}`)?.status).toBe("DONE");
    });

    test("buildLedger does not report complete for a reviewer whose INCOMPLETE result is quoted over in prose: the reply is a gap", async () => {
      const parsed = parseReviewResult(`Findings below.\nThe contract line \`${quoted}\` is quoted.\n${real}`);
      expect(parsed).toBeUndefined();
      const base = await inputs();
      const result = buildLedger({
        ...base,
        raws: base.selected.map((r) => (r === "review-logic" ? { name: "raw/review-logic.txt", hash: "h", mtimeMs: 1, empty: false } : raw(r, "DONE"))),
      });
      expect(result.gaps.some((gap) => gap.detail === "raw/review-logic.txt: no parseable REVIEW_RESULT block")).toBe(true);
      expect(result.ledger.scopeReviewed).toBe(false);
      expect(await blockersOf(result)).not.toEqual([]);
    });
  });

  describe("marker forms and precedence (F-014)", () => {
    const differing = '{"status":"BLOCKED","reviewer":"a","findings":[]}';

    test("a colon, an equals sign, a newline after the colon, or no separator all name the marker", () => {
      for (const separator of [": ", ":", " = ", "=", ":\n", ":\n\n  ", " "]) {
        expect(parseReviewResult(`${differing}\nREVIEW_RESULT${separator}${goodJson}`)).toEqual(good);
      }
    });

    test("a marker result wins over a bare scan that would pick another object with the same status", () => {
      const reply = '{"status":"DONE","reviewer":"a","findings":[]}\nREVIEW_RESULT: {"status":"DONE","reviewer":"b","findings":[]}\n{"status":"DONE","reviewer":"c","findings":[]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("b");
    });

    test("a cut-off last marker object falls back to the marker before it", () => {
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\nREVIEW_RESULT: {"status":"DONE","reviewer":"x"`)).toEqual(good);
    });

    test("a mention of the marker with a prose brace after a real marker result does not replace it, at a line start or inside a sentence", () => {
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\nsee REVIEW_RESULT {contract}`)).toEqual(good);
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\nREVIEW_RESULT {contract}`)).toEqual(good);
    });
  });

  describe("the caps (F-003, F-013)", () => {
    const fragments = (count: number) => Array.from({ length: count }, (_, n) => `note ${n} {"x`).join("\n");

    test("up to 64 unclosed prose fragments are skipped; one more gives no result, so the reviewer is re-dispatched", () => {
      expect(parseReviewResult(`${fragments(64)}\n${goodJson}`)).toEqual(good);
      expect(parseReviewResult(`${goodJson}\n${fragments(64)}`)).toEqual(good);
      expect(parseReviewResult(`${fragments(65)}\n${goodJson}`)).toBeUndefined();
      expect(parseReviewResult(`${goodJson}\n${fragments(65)}`)).toBeUndefined();
    });

    test("a single unclosed fragment is skipped as well", () => {
      expect(parseReviewResult(`${fragments(1)}\n${goodJson}`)).toEqual(good);
    });

    const laterMarkers = (count: number) => Array.from({ length: count }, (_, n) => `REVIEW_RESULT: {"status":"S${n}"}`).join("\n");

    test("only the last 64 markers are read: the real marker is found behind 63 later ones and lost behind 64", () => {
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\n${laterMarkers(63)}`)).toEqual(good);
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\n${laterMarkers(64)}`)).toBeUndefined();
    });

    test("the 64 last markers are counted outside fences: a real marker survives 64 fenced marker lines after it", () => {
      const fencedMarkers = Array.from({ length: 64 }, (_, n) => `REVIEW_RESULT: {"status":"S${n}","reviewer":"x","findings":[]}`).join("\n");
      expect(parseReviewResult(`REVIEW_RESULT: ${goodJson}\n\`\`\`text\n${fencedMarkers}\n\`\`\``)).toEqual(good);
    });

    test("the last markers are the ones read, not the first", () => {
      expect(parseReviewResult(`${laterMarkers(70)}\nREVIEW_RESULT: ${goodJson}`)).toEqual(good);
    });
  });

  describe("fences and shapes (F-015)", () => {
    const body = '{"status":"DONE","reviewer":"fence","findings":[]}';

    test("the label is case-insensitive and may be followed by spaces, tabs or a CRLF", () => {
      // A status-only body is accepted by the label alone (the scan would refuse it), so only the label rule can produce the result.
      for (const open of ["```REVIEW_RESULT\n", "```review_result\n", "```REVIEW_RESULT \n", "```REVIEW_RESULT\t\n", "```REVIEW_RESULT\r\n"]) {
        expect(parseReviewResult(`${open}${body}\n\`\`\``)?.reviewer).toBe("fence");
        expect(parseReviewResult(`${open}{"status":"DONE"}\n\`\`\``)).toEqual({ status: "DONE" });
      }
    });

    test("the last of two labelled fences wins", () => {
      const first = '```REVIEW_RESULT\n{"status":"BLOCKED","reviewer":"first"}\n```';
      const second = '```REVIEW_RESULT\n{"status":"DONE","reviewer":"second"}\n```';
      expect(parseReviewResult(`${first}\ntext\n${second}`)?.reviewer).toBe("second");
      expect(parseReviewResult(`${second}\ntext\n${first}`)?.reviewer).toBe("first");
    });

    test("a labelled fence that is not valid JSON decides: the bare result after it is not read", () => {
      expect(parseReviewResult('```REVIEW_RESULT\n{"status":"DONE",\n```\n' + goodJson)).toBeUndefined();
      expect(parseReviewResult('```REVIEW_RESULT\n{"status":"DONE",}\n```\n' + goodJson)).toBeUndefined();
      expect(parseReviewResult('```REVIEW_RESULT\n{"verdict":"DONE"}\n```\n' + goodJson)).toBeUndefined();
    });

    test("a labelled fence needs a string status", () => {
      expect(parseReviewResult('```REVIEW_RESULT\n{"status":1}\n```')).toBeUndefined();
      expect(parseReviewResult('```REVIEW_RESULT\n{"status":null,"reviewer":"r"}\n```')).toBeUndefined();
    });

    describe("a triple backtick inside a JSON string of the labelled fence (F-016)", () => {
      const withTicks = (summary: string) => `\`\`\`REVIEW_RESULT\n${JSON.stringify({ status: "DONE", reviewer: "r", findings: [], summary })}\n\`\`\``;

      test("the block ends at the first line that holds only a closing fence, not at the backticks in the string", () => {
        const parsed = parseReviewResult(`Notes.\n${withTicks("the \`\`\`json fence and \`\`\` again")}\n`);
        expect(parsed?.reviewer).toBe("r");
        expect(parsed?.summary).toBe("the ```json fence and ``` again");
      });

      test("a pretty-printed object with the backticks in a string is read, and CRLF line ends are too", () => {
        const body = JSON.stringify({ status: "DONE", reviewer: "r", findings: [], summary: "see ``` here" }, null, 2);
        expect(parseReviewResult(`\`\`\`REVIEW_RESULT\n${body}\n\`\`\`\n`)?.reviewer).toBe("r");
        expect(parseReviewResult(`\`\`\`REVIEW_RESULT\r\n${body.replaceAll("\n", "\r\n")}\r\n\`\`\`\r\n`)?.reviewer).toBe("r");
      });

      test("an object that is still not JSON, or has no closing line, gives no result", () => {
        expect(parseReviewResult('```REVIEW_RESULT\n{"status":"DONE","summary":"a ``` b",}\n```')).toBeUndefined();
        expect(parseReviewResult('```REVIEW_RESULT\n{"status":"DONE","summary":"a ``` b"}')).toBeUndefined();
      });

      test("a hostile reply of many such blocks is read in linear time", () => {
        const block = withTicks("x ``` y") + "\n";
        const started = performance.now();
        expect(parseReviewResult(block.repeat(40_000))?.reviewer).toBe("r");
        expect(parseReviewResult(`\`\`\`REVIEW_RESULT\n{"status":"DONE","summary":"${"``` ".repeat(500_000)}`)).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(2000);
      }, 20_000);
    });

    test("a pretty-printed bare object is read, and a fence pair around plain text does not hide the fenced result", () => {
      expect(parseReviewResult('{\n  "status": "DONE",\n  "reviewer": "r",\n  "findings": []\n}')).toEqual(good);
      const reply = '```text\nplain\n```\n```json\n{"status":"DONE","reviewer":"fenced","findings":[]}\n```\n{"status":"DONE","reviewer":"bare","findings":[]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("fenced");
    });

    test("a fence that never closes runs to the end of the reply: its object is fenced, a bare one before it with a status only does not count", () => {
      const statusOnly = '{"status":"BLOCKED"}';
      expect(parseReviewResult(`${statusOnly}\n\`\`\`json\n{"status":"DONE","reviewer":"b","findings":[]}`)?.reviewer).toBe("b");
      expect(parseReviewResult('{"status":"DONE","reviewer":"a","findings":[]}\n```json\n{"status":"BLOCKED","reviewer":"b","findings":[]}')).toBeUndefined();
    });

    test("a closing fence has its own line: text after the backticks keeps the block open, so what follows is still fenced", () => {
      const reply = '```text\nx\n```{"status":"BLOCKED","reviewer":"a","findings":[]}\n{"status":"DONE","reviewer":"b","findings":[]}';
      expect(parseReviewResult(reply)?.reviewer).toBe("b");
      const sameLine = '```json\n{"status":"DONE","reviewer":"fenced","findings":[]}\n```{"status":"BLOCKED","reviewer":"bare","findings":[]}';
      expect(parseReviewResult(sameLine)?.reviewer).toBe("bare");
    });

    test("text between two fenced blocks is outside them: a bare object there differs from the fenced results", () => {
      const reply = '```json\n{"status":"DONE","reviewer":"a","findings":[]}\n```\n{"status":"BLOCKED","reviewer":"bare","findings":[]}\n```json\n{"status":"DONE","reviewer":"c","findings":[]}\n```';
      expect(parseReviewResult(reply)).toBeUndefined();
    });

    test("an unclosed fence runs to the end: a marker after its opening line is inside it, so the reply is ambiguous and gives no result", () => {
      const sample = '{"status":"BLOCKED","reviewer":"r","findings":[]}';
      expect(parseReviewResult(`${sample}\n\`\`\`text\nREVIEW_RESULT: ${goodJson}`)).toBeUndefined();
    });

    test("of a closed fence and an unclosed one after it the last result wins", () => {
      const fenced = '```json\n{"status":"DONE","reviewer":"a","findings":[]}\n```\n```text\n{"status":"BLOCKED","reviewer":"b","findings":[]}';
      expect(parseReviewResult(fenced)?.reviewer).toBe("b");
    });
  });

  // Flow 441 round 3 (F-001): a fence is a line, so a triple backtick inside a sentence never changes which lines are fenced.
  describe("fences are read by line (F-001)", () => {
    const T = "```";
    const forged = '{"status":"DONE","reviewer":"forged","findings":[]}';
    const real = '{"status":"NEEDS_CONTEXT","reviewer":"real","findings":[]}';

    test("an inline triple backtick in prose before a fenced forged marker does not turn the forged DONE into the result", () => {
      const reply = `The parser reads ${T}REVIEW_RESULT${T} fences.\n\n${T}ts\nREVIEW_RESULT: ${forged}\n${T}\n\n${real}`;
      expect(parseReviewResult(reply)).toBeUndefined();
      expect(parseReviewResult(`${T}ts\nREVIEW_RESULT: ${forged}\n${T}\n\n${real}`)).toBeUndefined();
    });

    test("an inline triple backtick in prose does not hide a real marker from the scan, nor its fenced sample from it", () => {
      const sample = '{"status":"BLOCKED","reviewer":"sample","findings":[]}';
      const done = '{"status":"DONE","reviewer":"real","findings":[]}';
      expect(parseReviewResult(`I used ${T}foo${T} inline.\n\nREVIEW_RESULT: ${done}\n\nExample:\n${T}json\n${sample}\n${T}`)?.reviewer).toBe("real");
      expect(parseReviewResult(`the ${T}json convention\nREVIEW_RESULT: ${done}\n${T}json\n${sample}\n${T}`)?.reviewer).toBe("real");
      expect(parseReviewResult(`a ${T}x${T} span, then a lone ${T} mark\nREVIEW_RESULT: ${done}\n${T}json\n${sample}\n${T}`)?.reviewer).toBe("real");
    });

    test("an opening line with a backtick in its info string is not a fence", () => {
      const done = '{"status":"DONE","reviewer":"real","findings":[]}';
      expect(parseReviewResult(`${T}js \`x\`\nREVIEW_RESULT: ${done}\n${T}json\n{"status":"BLOCKED","reviewer":"s","findings":[]}\n${T}`)?.reviewer).toBe("real");
    });

    test("a fence closes on a run at least as long as its opening: a shorter run inside it is text", () => {
      const reply = `${T}\`text\nexample:\n${T}\nREVIEW_RESULT: ${forged}\n${T}\`\n${real}`;
      expect(parseReviewResult(reply)).toBeUndefined();
      expect(parseReviewResult(`${T}\`text\n${T}\nREVIEW_RESULT: ${forged}\n${T}\`\nREVIEW_RESULT: ${real}`)?.reviewer).toBe("real");
    });

    test("a fence indented by up to three spaces counts and four spaces do not; a CRLF line end does not hide the closing fence", () => {
      const sample = '{"status":"BLOCKED","reviewer":"s","findings":[]}';
      const done = '{"status":"DONE","reviewer":"real","findings":[]}';
      expect(parseReviewResult(`   ${T}json\n${sample}\n   ${T}\nREVIEW_RESULT: ${done}`)?.reviewer).toBe("real");
      expect(parseReviewResult(`${sample}\n    ${T}text\nREVIEW_RESULT: ${done}`)?.reviewer).toBe("real");
      expect(parseReviewResult(`${T}json\r\n${done}\r\n${T}\r\n${sample}`)).toBeUndefined();
    });
  });

  describe("what starts a candidate and a marker prefix", () => {
    test("a brace that is not followed by a quote or a closing brace is not a candidate: it does not count toward the cap", () => {
      const prose = Array.from({ length: 70 }, (_, n) => `note ${n} { prose`).join("\n");
      expect(parseReviewResult(`${prose}\n${goodJson}`)).toEqual(good);
    });

    test("a marker at a prefixed line start counts even when a bare object with another status stands in the reply", () => {
      const sample = '{"status":"INCOMPLETE","reviewer":"r","findings":[]}';
      for (const prefix of ["  ", "> ", "- ", "* ", "## ", ">> ", "\t"]) {
        expect(parseReviewResult(`${sample}\n${prefix}REVIEW_RESULT: ${goodJson}`)).toEqual(good);
      }
    });

    test("a marker whose object closes but is not JSON is passed over for the marker before it", () => {
      const sample = '{"status":"INCOMPLETE","reviewer":"r","findings":[]}';
      expect(parseReviewResult(`${sample}\nREVIEW_RESULT: ${goodJson}\nREVIEW_RESULT: {"status": DONE}`)).toEqual(good);
    });
  });
});

describe("buildLedger", () => {
  test("finished reviewers covering every slice give a ledger the completion gate accepts", async () => {
    const result = buildLedger(await inputs());
    expect(result.gaps).toEqual([]);
    expect(result.ledger.scopeReviewed).toBe(true);
    expect(result.ledger.rawReconciled).toBe(true);
    expect(await blockersOf(result)).toEqual([]);
    const run = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs[0]!;
    expect(run).toMatchObject({ status: "complete", scopeComplete: true, executionRequired: false });
    expect(String(run.rawEvidence)).toContain("#sha256:");
  });

  describe("a reply's `slices` as objects (flow 430 AC1)", () => {
    const logicGap = (result: ReturnType<typeof buildLedger>) => result.gaps.find((g) => g.reviewer === "review-logic");
    const withLogic = async (slices: unknown) => {
      const base = await inputs();
      return buildLedger({ ...base, raws: base.selected.map((r) => (r === "review-logic" ? raw(r, "DONE", { slices }) : raw(r, "DONE"))) });
    };

    test("objects with an id and a done status or none cover their slices", async () => {
      const result = await withLogic([{ id: "slice-01", status: "DONE" }, { id: "slice-02", coverage: "read in full" }]);
      expect(logicGap(result)).toBeUndefined();
      expect(await blockersOf(result)).toEqual([]);
    });

    test("an object whose status is not done leaves its slice uncovered and the gap names it", async () => {
      const result = await withLogic([{ id: "slice-01", status: "DONE" }, { id: "slice-02", status: "NOT_READ" }]);
      const gap = logicGap(result)!;
      expect(gap.detail).toContain("1 slice(s) not covered by any dispatched payload: slice-02");
      expect(gap.detail).toContain("slice-02 (NOT_READ)");
      expect(result.ledger.scopeReviewed).toBe(false);
      expect((await blockersOf(result)).join("\n")).toContain("review-logic");
    });

    test("an entry with no usable id is reported by count in the gap, not dropped silently", async () => {
      const result = await withLogic([{ id: "slice-01" }, { status: "DONE" }, ""]);
      const gap = logicGap(result)!;
      expect(gap.detail).toContain("slice-02");
      expect(gap.detail).toContain("2 slice entries without a usable id ignored");
    });
  });

  test("no fabrication: a NEEDS_CONTEXT reviewer stays incomplete and the gap carries the exact retry-plan command", async () => {
    const base = await inputs();
    const raws = [raw("review-architecture", "DONE"), raw("review-logic", "NEEDS_CONTEXT", { needs_context: ["finish the unread slices"] }), raw("review-testing-practices", "DONE")];
    const result = buildLedger({ ...base, raws });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic).toMatchObject({ status: "incomplete", scopeComplete: false });
    expect(result.ledger.scopeReviewed).toBe(false);
    const gap = result.gaps.find((g) => g.reviewer === "review-logic")!;
    expect(gap.detail).toContain("finish the unread slices");
    expect(gap.next).toBe("keryx review retry-plan --manifest slices/manifest.json --result raw/review-logic.txt --reviewer review-logic");
    expect((await blockersOf(result)).join("\n")).toContain("review-logic: reviewer scope is incomplete");
  });

  test("a DONE result with open needs_context is not a finished scope", async () => {
    const base = await inputs();
    const raws = base.selected.map((r) => raw(r, "DONE", r === "review-style" || r === "review-logic" ? { needs_context: ["run the tests"] } : {}));
    const result = buildLedger({ ...base, raws });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic.scopeComplete).toBe(false);
  });

  test("a finished reviewer whose payloads missed a slice is not scope-complete and the gap names the slice", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01"] } });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic.scopeComplete).toBe(false);
    expect(result.gaps.find((g) => g.reviewer === "review-logic")!.detail).toContain("slice-02");
    expect(result.ledger.scopeReviewed).toBe(false);
  });

  test("a retry slice accounts for the original it was cut from", async () => {
    const base = await inputs();
    const manifest = { ...MANIFEST, slices: [...MANIFEST.slices, slice("r1-review-logic-01", ["src/b.test.ts"], { retryOf: ["slice-02"], attempt: 1 })] } as SliceManifest;
    const result = buildLedger({ ...base, manifest, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01", "r1-review-logic-01"] } });
    expect(result.gaps).toEqual([]);
  });

  test("a path-gated reviewer is only required to cover the slices its gate matches", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, payloadSlices: { ...base.payloadSlices, "review-testing-practices": ["slice-02"] } });
    expect(result.gaps).toEqual([]);
  });

  test("a required reviewer with no result is not-run, never complete", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, raws: base.raws.filter((r) => r.result?.reviewer !== "review-logic") });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic).toMatchObject({ status: "not-run", scopeComplete: false });
    expect((await blockersOf(result)).join("\n")).toContain("review-logic: not run");
  });

  test("a reviewer the retry state gave up on stays not-run and the gap says no retry is left", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, retry: { schemaVersion: 1, scopeFingerprint: scopeFingerprint(MANIFEST)!, reviewers: { "review-logic": { attempt: 1, status: "BLOCKED", notRun: true } } } });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!;
    expect(logic.status).toBe("not-run");
    expect(result.gaps.find((g) => g.reviewer === "review-logic")!.next).toContain("no retry is left");
  });

  test("a missing rule file leaves the rule evidence empty and the gate refuses", async () => {
    const base = await inputs();
    const { "review-logic": _gone, ...ruleFiles } = base.ruleFiles;
    const result = buildLedger({ ...base, ruleFiles });
    expect((result.ledger.dispatch as { unresolvedRules: string[] }).unresolvedRules).toEqual(["review-logic"]);
    expect((await blockersOf(result)).length).toBeGreaterThan(0);
  });

  test("the latest result of a reviewer decides, not an earlier finished one", async () => {
    const base = await inputs();
    const later = raw("review-logic", "NEEDS_CONTEXT", { needs_context: ["more"] }, "raw/review-logic-2.txt");
    const result = buildLedger({ ...base, raws: [...base.raws, later] });
    expect((result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find((r) => r.reviewer === "review-logic")!.status).toBe("incomplete");
  });

  test("uncovered slices name the waves left and the exact next-wave command", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01"] } });
    const gap = result.gaps.find((g) => g.reviewer === "review-logic")!;
    expect(gap.waves).toBe(1);
    expect(gap.detail).toContain("1 wave(s)");
    expect(gap.next).toContain("keryx review retry-plan --manifest slices/manifest.json --reviewer review-logic --result raw/review-logic.txt --next-wave");
  });

  test("a result already counted in retry-state is not named again in the next command", async () => {
    const base = await inputs();
    const raws = base.raws.map((r) => (r.result?.reviewer === "review-logic" ? { ...r, result: { ...r.result, slices: ["slice-01"] } } : r));
    const retry = { schemaVersion: 1 as const, scopeFingerprint: scopeFingerprint(MANIFEST)!, reviewers: { "review-logic": { attempt: 0, status: "DONE", notRun: false, stalls: 0, covered: ["slice-01"] } } };
    const gap = buildLedger({ ...base, raws, retry }).gaps.find((g) => g.reviewer === "review-logic")!;
    expect(gap.next).not.toContain("--result");
    expect(gap.next).toContain("--next-wave");
  });

  test("slices covered in earlier rounds, recorded in retry-state, finish an incomplete reviewer's scope", async () => {
    const base = await inputs();
    const raws = base.raws.map((r) => (r.result?.reviewer === "review-logic" ? { ...r, result: { ...r.result, slices: ["slice-02"] } } : r));
    const retry = { schemaVersion: 1 as const, scopeFingerprint: scopeFingerprint(MANIFEST)!, reviewers: { "review-logic": { attempt: 1, status: "INCOMPLETE", notRun: false, stalls: 0, covered: ["slice-01"] } } };
    const result = buildLedger({ ...base, raws, retry });
    expect(result.gaps.find((g) => g.reviewer === "review-logic")).toBeUndefined();
  });

  test("an incomplete reviewer's gap counts the waves still owed", async () => {
    const base = await inputs();
    const raws = base.raws.map((r) => (r.result?.reviewer === "review-logic" ? { ...r, result: { ...r.result, status: "INCOMPLETE", slices: ["slice-01"] } } : r));
    const gap = buildLedger({ ...base, raws }).gaps.find((g) => g.reviewer === "review-logic")!;
    expect(gap.waves).toBe(1);
    expect(gap.detail).toContain("1 slice(s) uncovered");
    expect(gap.next).toBe("keryx review retry-plan --manifest slices/manifest.json --result raw/review-logic.txt --reviewer review-logic");
  });

  test("a partly covered re-cut does not close the slice it was cut from", async () => {
    const base = await inputs();
    const pieces = [slice("r1-review-logic-01", ["src/b.test.ts"], { retryOf: ["slice-02"], attempt: 1, reviewer: "review-logic" }), slice("r1-review-logic-02", ["src/b.test.ts"], { retryOf: ["slice-02"], attempt: 1, reviewer: "review-logic" })];
    const manifest = { ...MANIFEST, slices: [...MANIFEST.slices, ...pieces] } as SliceManifest;
    const partial = buildLedger({ ...base, manifest, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01", "r1-review-logic-01"] } });
    expect(partial.gaps.find((g) => g.reviewer === "review-logic")!.detail).toContain("slice-02");
    const whole = buildLedger({ ...base, manifest, payloadSlices: { ...base.payloadSlices, "review-logic": ["slice-01", "r1-review-logic-01", "r1-review-logic-02"] } });
    expect(whole.gaps).toEqual([]);
  });
});

describe("raw findings", () => {
  const finding = { id: "L-01", severity: "minor", problem: "p", impact: "i", suggested_fix: "f", evidence: "e", confidence: 0.5, reviewer: "review-logic" };

  async function withFinding() {
    const base = await inputs();
    return { ...base, raws: base.raws.map((r) => (r.result?.reviewer === "review-logic" ? { ...r, result: { ...r.result, findings: [finding] } } : r)) };
  }

  test("a raw finding with no canonical match and no closure stays unresolved and blocks the gate", async () => {
    const result = buildLedger(await withFinding());
    expect(result.ledger.obligations).toHaveLength(1);
    expect(result.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
    expect(result.ledger.rawReconciled).toBe(false);
    expect(result.gaps.some((g) => g.next.includes("--dispositions"))).toBe(true);
    expect((await blockersOf(result)).join("\n")).toContain("unresolved research");
  });

  test("a canonical finding of the same reviewer and id closes it with evidence", async () => {
    const base = await withFinding();
    const result = buildLedger({ ...base, canonical: [finding] });
    expect(result.ledger.obligations[0]).toMatchObject({ status: "finding", finding: "L-01" });
    expect(await blockersOf(result, [finding])).toEqual([]);
  });

  test("a disposition closes it only with evidence and reason", async () => {
    const base = await withFinding();
    const id = "review-logic:L-01";
    const thin = buildLedger({ ...base, dispositions: [{ id, status: "refuted", evidence: "", reason: "" }] });
    expect(thin.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
    const full = buildLedger({ ...base, dispositions: [{ id, status: "refuted", evidence: "ran the case, no failure", reason: "the guard exists at a.ts:12" }] });
    expect(full.ledger.obligations[0]).toMatchObject({ status: "refuted", evidence: "ran the case, no failure" });
    expect(await blockersOf(full)).toEqual([]);
  });

  test("a finding disposition must resolve to exactly one canonical finding", async () => {
    const base = await withFinding();
    const result = buildLedger({ ...base, dispositions: [{ id: "review-logic:L-01", status: "finding", finding: "nope", evidence: "e", reason: "r" }] });
    expect(result.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
  });
});

describe("raw files", () => {
  test("an empty reviewer output does not block reconciliation, an unparseable one does", async () => {
    const base = await inputs();
    const empty: RawFile = { name: "raw/lost.txt", hash: "x", mtimeMs: 1, empty: true };
    expect(buildLedger({ ...base, raws: [...base.raws, empty] }).ledger.rawReconciled).toBe(true);
    const garbled: RawFile = { name: "raw/garbled.txt", hash: "y", mtimeMs: 1, empty: false };
    const result = buildLedger({ ...base, raws: [...base.raws, garbled] });
    expect(result.ledger.rawReconciled).toBe(false);
    expect(result.gaps.some((g) => g.detail.includes("raw/garbled.txt"))).toBe(true);
  });

  test("the same inputs build the same ledger", async () => {
    const base = await inputs();
    expect(JSON.stringify(buildLedger(base))).toBe(JSON.stringify(buildLedger(base)));
  });
});

// Flow 427: coverage must not be inferred from the union of unrelated dispatch payloads.
describe("autonomy hardening regressions", () => {
  test("bare JSON reviewer output is parsed", () => {
    expect(parseReviewResult('{"reviewer":"review-logic","status":"DONE","findings":[],"needs_context":[]}')?.status).toBe("DONE");
  });

  test("BLOCKED A and DONE B without slice claims do not close payload union A+B", async () => {
    const base = await inputs();
    const earlier = raw("review-logic", "BLOCKED", {}, "raw/logic-a.txt");
    const later = raw("review-logic", "DONE", {}, "raw/logic-b.txt");
    const result = buildLedger({ ...base, raws: [...base.raws.filter(r => r.result?.reviewer !== "review-logic"), earlier, later] });
    const logic = (result.ledger.dispatch as { runs: Array<Record<string, unknown>> }).runs.find(r => r.reviewer === "review-logic")!;
    expect(logic.scopeComplete).toBe(false);
    expect(result.ledger.scopeReviewed).toBe(false);
  });
});

describe("dispatch attribution", () => {
  test("one raw result cannot implicitly close multiple dispatches", async () => {
    const base = await inputs();
    const result = buildLedger({ ...base, payloadDispatchCounts: { ...base.payloadDispatchCounts, "review-logic": 2 } });
    expect(result.ledger.scopeReviewed).toBe(false);
    expect(result.gaps.some(g => g.reviewer === "review-logic")).toBe(true);
  });
  test("explicit result assignments close only their own slices", async () => {
    const base = await inputs();
    const a = { ...raw("review-logic", "DONE", {}, "raw/a.txt"), assignedSlices: ["slice-01"] };
    const b = { ...raw("review-logic", "DONE", {}, "raw/b.txt"), assignedSlices: ["slice-02"] };
    const others = base.raws.filter(r => r.result?.reviewer !== "review-logic");
    expect(buildLedger({ ...base, raws: [...others, a, b] }).ledger.scopeReviewed).toBe(true);
    const hostile = { ...b, result: { ...b.result!, slices: ["slice-01", "slice-02"] } };
    expect(buildLedger({ ...base, raws: [...others, { ...a, result: { ...a.result!, status: "BLOCKED" } }, hostile] }).ledger.scopeReviewed).toBe(false);
  });
  test("prose and JSON strings containing escaped quotes and braces parse", () => {
    const object = { status: "DONE", summary: 'brace } and "quote"', reviewer: "review-logic" };
    expect(parseReviewResult(`prose {not JSON}\n${JSON.stringify(object)}\nend`)).toEqual(object);
  });
});

 test("labelled context result is not replaced by a trailing JSON example", () => {
  expect(parseReviewResult('```REVIEW_RESULT\n{"status":"NEEDS_CONTEXT"}\n```\nExample: {"status":"DONE"}')?.status).toBe("NEEDS_CONTEXT");
  expect(parseReviewResult('```REVIEW_RESULT\ninvalid\n```\n{"status":"DONE"}')).toBeUndefined();
});


test("deterministic lifecycle: dispatch, context, redispatch and completion gate", async () => {
  const input = await inputs();
  const reviewer = "review-logic";
  const readSliceText = () => "fixture diff";
  const dispatch = planRetry({ manifest: MANIFEST, reviewer, result: {}, state: emptyRetryState(), nextWave: true, readSliceText });
  expect(dispatch.decision).toBe("wave");
  expect(dispatch.wave.length).toBeGreaterThan(0);
  const fingerprint = scopeFingerprint(MANIFEST, readSliceText)!;
  const pendingPayload = { reviewer, status: "DONE", scopeFingerprint: fingerprint, needs_context: ["Explain the caller contract"], findings: [] };
  const pending = parseReviewResult(JSON.stringify(pendingPayload))!;
  expect(pending).toEqual(pendingPayload);
  const context = planRetry({ manifest: MANIFEST, reviewer, result: pendingPayload, state: dispatch.state, readSliceText });
  expect(context.decision).toBe("context");
  expect(context.needsContext).toEqual(["Explain the caller contract"]);
  const pendingRaw: RawFile = { ...raw(reviewer, "DONE"), result: pending, assignedSlices: context.wave.map(s => s.id) };
  const pendingLedger = buildLedger({ ...input, raws: [...input.raws.filter(r => r.result?.reviewer !== reviewer), pendingRaw] });
  expect(pendingLedger.ledger.scopeReviewed).toBe(false);
  expect((await blockersOf(pendingLedger)).length).toBeGreaterThan(0);
  const assigned = MANIFEST.slices.map(s => s.id);
  const finishedPayload = { reviewer, status: "DONE", scopeFingerprint: fingerprint, slices: assigned, needs_context: [], findings: [] };
  const finished = parseReviewResult(JSON.stringify(finishedPayload))!;
  expect(finished).toEqual(finishedPayload);
  const accepted = planRetry({ manifest: MANIFEST, reviewer, result: finishedPayload, state: context.state, readSliceText });
  expect(accepted.decision).toBe("accepted");
  expect(accepted.remaining.slices).toBe(0);
  const finishedRaw: RawFile = { ...raw(reviewer, "DONE", {}, "raw/review-logic-second.txt"), result: finished, assignedSlices: assigned };
  const complete = buildLedger({ ...input, payloadDispatchCounts: { ...input.payloadDispatchCounts, [reviewer]: 2 }, raws: [...input.raws.filter(r => r.result?.reviewer !== reviewer), pendingRaw, finishedRaw] });
  expect(complete.gaps).toEqual([]);
  expect(complete.ledger.scopeReviewed).toBe(true);
  expect(await blockersOf(complete)).toEqual([]);
  const changed = { ...MANIFEST, slices: MANIFEST.slices.map(s => ({ ...s, contentHash: "changed-content" })) };
  expect(() => planRetry({ manifest: changed, reviewer, result: finishedPayload, state: accepted.state, readSliceText: () => "changed diff" })).toThrow("not bound to the current scope");
});

describe("severity audit (flow 428 AC6)", () => {
  const record = (statuses: Record<string, "killed" | "survived" | "invalid">, file = "src/a.ts"): MutationRecord => ({
    schemaVersion: 1, worktree: "/w", command: "t", baseline: { exitCode: 0, ms: 1 }, totals: { killed: 0, survived: 0, invalid: 0, timeout: 0 },
    mutants: Object.entries(statuses).map(([id, status]) => ({ id, file, anchor: "a", replacement: "b", status, command: "t", ms: 1 })),
  });
  const run = { name: "mutation-1.json", record: record({ M1: "survived", M2: "killed", M3: "invalid" }) };
  const finding = (extra: Record<string, unknown>) => ({ id: "F1", severity: "minor", evidence: "mutant:M1 survives", ...extra });

  test("a surviving mutant the finding cites raises it to major and records the evidence id", () => {
    const { findings, changes } = auditSeverity([finding({})], [run], { changedFiles: ["src/a.ts"] });
    expect(findings[0]).toMatchObject({ severity: "major", severity_audit: { from: "minor", to: "major", evidence: "mutation-1.json#M1" } });
    expect(changes).toHaveLength(1);
  });

  test("a killed mutant, an invalid one, a blocker and a mutant outside the diff change nothing", () => {
    expect(auditSeverity([finding({ evidence: "mutant:M2" })], [run]).changes).toEqual([]);
    expect(auditSeverity([finding({ evidence: "mutant:M3" })], [run]).findings[0]).toMatchObject({ severity: "minor", labels: ["unproven"] });
    expect(auditSeverity([finding({ severity: "blocker" })], [run]).changes).toEqual([]);
    expect(auditSeverity([finding({})], [run], { changedFiles: ["src/other.ts"] }).changes).toEqual([]);
    expect(auditSeverity([finding({ evidence: "no citation" })], [run]).changes).toEqual([]);
  });

  test("without an executed run the finding stays minor, carries the unproven label, and a major is capped", () => {
    const minor = auditSeverity([finding({})], []);
    expect(minor.findings[0]).toMatchObject({ severity: "minor", labels: ["unproven"] });
    expect(minor.findings[0]!.severity_audit).toBeUndefined();
    expect(auditSeverity([finding({ severity: "major" })], []).findings[0]).toMatchObject({ severity: "minor", labels: ["unproven"] });
  });

  test("the audit never drops a finding and never mutates its input", () => {
    const input = [finding({}), { id: "F2", severity: "major", evidence: "plain" }];
    const copy = JSON.stringify(input);
    expect(auditSeverity(input, [run]).findings).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(copy);
  });

  test("auditPackage reads the recorded passes, rewrites findings.json, and --dry-run leaves it alone", async () => {
    const pkg = path.join(root, "pkg");
    await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
    await writeFile(path.join(pkg, "research-evidence", "mutation-1.json"), JSON.stringify(run.record));
    await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"] }));
    const before = JSON.stringify([finding({})]);
    await writeFile(path.join(pkg, "findings.json"), before);
    const dry = await auditPackage(pkg, { dryRun: true });
    expect([dry.changes.length, dry.written]).toEqual([1, false]);
    expect(await Bun.file(path.join(pkg, "findings.json")).text()).toBe(before);
    expect((await auditPackage(pkg)).written).toBe(true);
    expect(JSON.parse(await Bun.file(path.join(pkg, "findings.json")).text())[0].severity).toBe("major");
  });
});
