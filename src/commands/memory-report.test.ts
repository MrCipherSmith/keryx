import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { memoryCommand } from "./memory";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");

function captureOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  return { lines, restore: () => { console.log = original; } };
}

test("P1-5: --save-report is the only CLI mode that publishes a report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-cli-report-"));
  const output = captureOutput();
  try {
    await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
    await withCwd(root, async () => memoryCommand(["search", "authority boundary", "--json", "--save-report"]));
    const rendered = JSON.parse(output.lines.join("\n")) as { report: { runId: string; jsonPath: string } };
    expect(rendered.report.runId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(JSON.parse(await readFile(path.join(root, rendered.report.jsonPath), "utf8"))).toMatchObject({ runId: rendered.report.runId });
  } finally {
    output.restore();
    await rm(root, { recursive: true, force: true });
  }
});
