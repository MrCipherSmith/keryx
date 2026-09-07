import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

test("offline stress fixture writes JSON with the configured maxRounds resolver value", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "keryx-stress-report-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(REPO_ROOT, "scripts/stress/keryx-shell-stress.ts"),
        "--only",
        "__offline_report_only__",
        "--out",
        outputDir,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KERYX_AGENT_MAX_ROUNDS: "7",
          DEEPSEEK_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    const reports = (await readdir(outputDir)).filter((entry) => /^stress-.*\.json$/.test(entry));
    expect(reports).toHaveLength(1);
    const reportName = reports[0];
    if (reportName === undefined) throw new Error("stress report was not written");
    const report = JSON.parse(await readFile(path.join(outputDir, reportName), "utf8")) as Record<string, unknown>;
    expect(report.maxRounds).toBe(7);
    expect(report).not.toHaveProperty("maxToolCalls");
    expect(report.findings).toEqual([]);
    expect(stdout).toContain(`report:  ${path.join(outputDir, reportName)}`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
