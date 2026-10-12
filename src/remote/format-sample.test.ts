// `keryx remote format-sample` and the fixed sample reply (flow 395; AC8): every mode, no network,
// and the same rendering code the outbound path runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { remoteCommand } from "../commands/remote";
import { checkRichMessage } from "./fake-bot-api";
import { formatSampleText, renderAllSamples, renderSample, SAMPLE_REPLY } from "./rendering-sample";
import { containsTable } from "./format-rich";
import { RENDER_MODES } from "./rendering-mode";

let out: string[] = [];
let err: string[] = [];
const realLog = console.log;
const realError = console.error;
const realWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  out = [];
  err = [];
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    out.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.join(" "));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.stdout.write = realWrite;
  process.exitCode = 0;
});

describe("the sample reply", () => {
  test("it holds every construct the flow handles", () => {
    expect(containsTable(SAMPLE_REPLY)).toBe(true);
    expect(SAMPLE_REPLY).toMatch(/^\d+\. /m);
    expect(SAMPLE_REPLY).toMatch(/^\s+- /m);
    expect(SAMPLE_REPLY).toMatch(/- \[x\] /);
    expect(SAMPLE_REPLY).toMatch(/- \[ \] /);
    expect(SAMPLE_REPLY).toMatch(/^---$/m);
  });

  test("html: an aligned <pre> table, numbers and nesting kept, boxes, a line for the rule", () => {
    const [part] = renderSample("html").parts;
    expect(part?.kind).toBe("html");
    expect(part?.text).not.toMatch(/\|\s*:?-{2,}/);
    expect(part?.text).toContain("1. Fix the smoke test");
    expect(part?.text).toContain("   • on the branch first");
    expect(part?.text).toContain("☑");
    expect(part?.text).toContain("☐");
    expect(part?.text).toContain("─");
  });

  test("rich: a native table block, and the message passes the Bot API limits", () => {
    const [part] = renderSample("rich").parts;
    expect(part?.kind).toBe("rich");
    expect(part?.richMessage?.blocks.some((block) => block.type === "table")).toBe(true);
    expect(part?.richMessage?.blocks.some((block) => block.type === "divider")).toBe(true);
    expect(part?.richMessage === undefined ? "no message" : checkRichMessage(part.richMessage)).toBeUndefined();
  });

  test("auto picks rich for this reply because it has a table; plain is plain", () => {
    expect(renderSample("auto").parts[0]?.kind).toBe("rich");
    expect(renderSample("plain").parts[0]?.kind).toBe("plain");
    expect(renderSample("plain").parts[0]?.text).not.toContain("|");
  });

  test("auto on a reply with no table is HTML", () => {
    expect(renderSample("auto", "just **text**").parts[0]).toMatchObject({ kind: "html", text: "just text" });
  });

  test("all four modes are rendered, in the documented order", () => {
    expect(renderAllSamples().map((rendering) => rendering.mode)).toEqual([...RENDER_MODES]);
  });
});

describe("keryx remote format-sample", () => {
  test("with no flags it prints the source and all four modes, with no network", () => {
    remoteCommand(["format-sample"]);
    const text = out.join("");
    for (const mode of RENDER_MODES) {
      expect(text).toContain(`=== ${mode}:`);
    }
    expect(text).toContain("Release check");
    expect(text).toContain("sent as rich");
    expect(text).toContain("sent as html");
    expect(text).toContain("sent as plain");
    expect(process.exitCode).toBe(0);
  });

  test("--mode narrows to one", () => {
    remoteCommand(["format-sample", "--mode", "html"]);
    const text = out.join("");
    expect(text).toContain("=== html:");
    expect(text).not.toContain("=== rich:");
  });

  test("--full prints the rich message itself", () => {
    remoteCommand(["format-sample", "--mode", "rich", "--full"]);
    expect(out.join("")).toContain('"type": "table"');
  });

  test("--json is parseable and carries each part and how it is sent", () => {
    remoteCommand(["format-sample", "--json"]);
    const doc = JSON.parse(out.join("")) as { sample: string; renderings: { mode: string; parts: { kind: string }[] }[] };
    expect(doc.sample).toBe(SAMPLE_REPLY);
    expect(doc.renderings.map((rendering) => rendering.mode)).toEqual([...RENDER_MODES]);
    expect(doc.renderings.find((rendering) => rendering.mode === "rich")?.parts[0]?.kind).toBe("rich");
  });

  test("a bad --mode exits 1 and names the valid ones", () => {
    remoteCommand(["format-sample", "--mode", "fancy"]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("auto, rich, html, plain");
    expect(out).toEqual([]);
  });

  test("an unknown subcommand exits 1; bare and --help print the usage", () => {
    remoteCommand(["nope"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    remoteCommand([]);
    expect(out.join("\n")).toContain("keryx remote format-sample");
    expect(process.exitCode).toBe(0);
  });

  test("it reaches no network: the command and the sample renderer import no socket module and name no fetch", () => {
    const sources = [path.join(import.meta.dir, "rendering-sample.ts"), path.join(import.meta.dir, "..", "commands", "remote.ts")];
    for (const file of sources) {
      const code = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(new RegExp(`\\bfetch\\b|node:(?:http|https|net|tls|dgram|dns)|${["Web", "Socket"].join("")}|Bun\\.(?:serve|connect)`));
    }
  });

  test("the text renderer is stable for a fixed input", () => {
    expect(formatSampleText(renderAllSamples())).toBe(formatSampleText(renderAllSamples()));
  });
});
