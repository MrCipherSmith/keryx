// Flow 308 — `keryx review conform`, driven through the real CLI (AC6, AC7,
// AC9). Fixtures under `fixtures/conform/` are entirely INVENTED (AC10): no
// real reference document's wording, name or path appears anywhere here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainConformVerdicts, reviewCommand } from "./review";
import type { ConformVerdict } from "../review/conform-jev";
import type { ModelTurnInput, ModelTurnResult } from "../harness/provider/single-turn";
import { CONFORM_RECENTS_PATH } from "../review/conform-report";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "conform");
const REF_PATH = path.join(FIXTURES_DIR, "invented-ref.md");
const REPORT_DIR = path.join(FIXTURES_DIR, "report-package");
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { conform: enabled } } }));
  return dir;
}

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ORIGINAL_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  }
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

interface JsonClause {
  clause_id: string;
  state_kind: string;
  status: string;
  probability?: number;
  reason?: string;
  evidence: string[];
  explanation?: string;
}

interface JsonResult {
  ref: string;
  target: { kind: string; label: string };
  clauses: JsonClause[];
  usage?: { jevCalls: number };
}

describe("AC6: keryx review conform --pr — pr-kind and hunk-kind clauses, from fixtures", () => {
  test("--json prints every clause: evaluated, not-checkable, and not-evaluated", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "999", "--fixtures", FIXTURES_DIR, "--json"]);

    const parsed = JSON.parse(output()) as JsonResult;
    expect(parsed.target.kind).toBe("pr");
    const byId = new Map(parsed.clauses.map((c) => [c.clause_id, c]));

    // pr-kind: satisfied (0.91 >= 0.5) and likely-violated (0.22 < 0.5).
    expect(byId.get("change-limits-1")?.status).toBe("satisfied");
    expect(byId.get("change-limits-1")?.probability).toBe(0.91);
    expect(byId.get("change-limits-2")?.status).toBe("likely-violated");

    // hunk-kind: evaluated against the PR's own diff.
    expect(byId.get("hunks-1")?.status).toBe("satisfied");
    expect(byId.get("hunks-1")?.state_kind).toBe("hunk");

    // report-kind: no report supplied this run.
    expect(byId.get("findings-1")?.status).toBe("not-evaluated");

    // not-checkable: always listed, never dropped, never scored.
    expect(byId.get("ownership-1")?.status).toBe("not-checkable");
    expect(byId.get("ownership-1")?.reason).toContain("no artefact");
    expect(byId.get("ownership-1")?.probability).toBeUndefined();

    expect(process.exitCode ?? 0).toBe(0);
  });

  test("without --json, prints a human-readable report grouped by kind", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "999", "--fixtures", FIXTURES_DIR]);

    expect(output()).toContain("## pr");
    expect(output()).toContain("## hunk");
    expect(output()).toContain("not checkable");
    expect(output()).toContain("summary:");
  });

  test("--explain adds a labelled advisory explanation for a clause scored below threshold, from explain-response.json", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "999", "--fixtures", FIXTURES_DIR, "--explain"]);

    expect(output()).toContain("ADVISORY");
    expect(output()).toContain("Clause change-limits-2 looks violated");
  });

  test("--threshold changes which clauses are satisfied vs likely-violated", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "999", "--fixtures", FIXTURES_DIR, "--threshold", "0.95", "--json"]);
    const parsed = JSON.parse(output()) as JsonResult;
    const byId = new Map(parsed.clauses.map((c) => [c.clause_id, c]));
    expect(byId.get("change-limits-1")?.status).toBe("likely-violated");
  });

  test("an out-of-range --threshold is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "999", "--fixtures", FIXTURES_DIR, "--threshold", "1.5"]);
    expect(output()).toContain("--threshold");
    expect(process.exitCode).toBe(1);
  });
});

describe("AC6: keryx review conform --report — report-kind clauses only", () => {
  test("--json scores report-kind clauses against report.md/findings.json; pr/hunk are not evaluated", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", REF_PATH, "--report", REPORT_DIR, "--fixtures", FIXTURES_DIR, "--json"]);

    const parsed = JSON.parse(output()) as JsonResult;
    expect(parsed.target.kind).toBe("report");
    const byId = new Map(parsed.clauses.map((c) => [c.clause_id, c]));
    expect(byId.get("findings-1")?.status).toBe("likely-violated");
    expect(byId.get("findings-1")?.evidence.join(" ")).toContain("findings missing");
    expect(byId.get("change-limits-1")?.status).toBe("not-evaluated");
    expect(byId.get("hunks-1")?.status).toBe("not-evaluated");
    expect(byId.get("ownership-1")?.status).toBe("not-checkable");
  });
});

describe("AC9: opt-in per project, and credential gating — both refuse before any read", () => {
  test("review.jev.conform absent/false: refused, the reference doc is never even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", path.join(ROOT, "does-not-exist.md"), "--pr", "999", "--fixtures", FIXTURES_DIR]);

    expect(output()).toContain("conform");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY: refused, the reference doc is never even opened", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["conform", "--ref", path.join(ROOT, "does-not-exist.md"), "--pr", "999", "--fixtures", FIXTURES_DIR]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("AC7 privacy: --explain never sends the reference document's full path to the model", () => {
  test("explainConformVerdicts sends only the redacted basename, not refPath", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    // A path deliberately shaped to carry two things that must never reach
    // the model: a private-looking directory and a secret-shaped span.
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const refPath = path.join(ROOT, "private-project", `notes-${secret}.md`);

    const verdict: ConformVerdict = {
      clause_id: "change-limits-1",
      state_kind: "pr",
      status: "likely-violated",
      probability: 0.1,
      factLines: ["a fact"],
    };

    let capturedUser: string | undefined;
    const fakeRunTurn = async (input: ModelTurnInput): Promise<ModelTurnResult> => {
      capturedUser = input.user;
      return { provider: "fixture", model: "fixture", credentialAvailable: true, text: "explanation text" };
    };

    const explanations = await explainConformVerdicts(ROOT, refPath, [verdict], 0.5, undefined, fakeRunTurn);

    expect(explanations["change-limits-1"]).toBe("explanation text");
    expect(capturedUser).toBeDefined();
    expect(capturedUser).not.toContain(ROOT);
    expect(capturedUser).not.toContain("private-project");
    expect(capturedUser).not.toContain(secret);
    expect(capturedUser).toContain("[REDACTED:");
    // The filename's non-secret part still gets through — only the secret
    // span and the directory are stripped/omitted.
    expect(capturedUser).toContain("notes-");
  });
});

describe.skipIf(process.platform === "win32")("recent-docs.json is written owner-only (0o600)", () => {
  test("after a successful --pr run", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "999", "--fixtures", FIXTURES_DIR, "--json"]);

    const mode = (await stat(path.join(ROOT, CONFORM_RECENTS_PATH))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("CLI arg validation", () => {
  test("unknown flags are refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["conform", "--ref", REF_PATH, "--pr", "1", "--bogus"]);
    expect(output()).toContain("Unknown option");
  });

  test("exactly one of --pr/--report/--diff is required", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["conform", "--ref", REF_PATH]);
    expect(output()).toContain("Usage: keryx review conform");
  });
});
