// Flow 403: the REAL ports behind a card decision, driven with a fake `keryx` runner and real directories.
//   S2  `flow init` adopts only the directory whose origin source names THIS card, one init at a time per project.
//   S5  the keryx child never sees a token of the host.
//   S6  a hung child (or a grandchild holding its pipes) cannot hold a card in `taking`.
//   T7  a failed init leaves nothing behind; a successful one returns the right directory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowsRoot } from "../flow/store";
import { createDefaultFlowPort, intakeChildEnv, runProcess, type Captured, type KeryxRunner } from "./intake-ports";

let project: string;
beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "keryx-intake-ports-"));
  mkdirSync(flowsRoot(project), { recursive: true });
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const OK: Captured = { code: 0, timedOut: false, stdout: "", stderr: "" };

function makeFlow(id: number, source: string | undefined, slug = "from-card"): string {
  const dir = `${id}-2026-10-05-${slug}`;
  mkdirSync(path.join(flowsRoot(project), dir), { recursive: true });
  if (source !== undefined) writeFileSync(path.join(flowsRoot(project), dir, "flow.json"), JSON.stringify({ origin: { kind: "agent-proposal", source } }));
  return dir;
}

const sourceArg = (args: readonly string[]): string => args[args.indexOf("--source") + 1] ?? "";
const dirsNow = (): string[] => readdirSync(flowsRoot(project)).sort();

describe("the real flow port (S2, T7)", () => {
  test("a successful init returns the directory made for this card, with its flow id", async () => {
    const run: KeryxRunner = async (args) => {
      makeFlow(501, sourceArg(args));
      return OK;
    };
    const port = createDefaultFlowPort({ run });
    const result = await port.init(project, { issueUrl: "https://github.com/o/r/issues/1", source: "https://github.com/o/r/issues/1 card abc123" });
    expect(result).toEqual({ ok: true, flowId: "501", dir: "501-2026-10-05-from-card" });
    expect(await port.findByCard(project, "abc123")).toEqual({ flowId: "501", dir: "501-2026-10-05-from-card" });
    expect(await port.findByCard(project, "zzz999")).toBeUndefined();
  });

  test("a directory someone else made at the same moment is never adopted", async () => {
    const run: KeryxRunner = async (args) => {
      makeFlow(500, "manual: the operator ran flow init by hand");
      makeFlow(501, sourceArg(args));
      return OK;
    };
    const result = await createDefaultFlowPort({ run }).init(project, { source: "https://github.com/o/r/issues/2 card def456" });
    expect(result).toMatchObject({ ok: true, flowId: "501" });
  });

  test("when only a foreign directory appeared, the init is a failure and the foreign directory is left alone", async () => {
    const run: KeryxRunner = async () => {
      makeFlow(500, "manual: the operator ran flow init by hand");
      return OK;
    };
    const result = await createDefaultFlowPort({ run }).init(project, { source: "https://github.com/o/r/issues/3 card aaa111" });
    expect(result.ok).toBe(false);
    expect(dirsNow()).toEqual(["500-2026-10-05-from-card"]);
  });

  test("two inits at once each get their own flow, and never run at the same time", async () => {
    let running = 0;
    let peak = 0;
    let next = 600;
    const run: KeryxRunner = async (args) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      makeFlow(next++, sourceArg(args));
      running -= 1;
      return OK;
    };
    const port = createDefaultFlowPort({ run });
    const [a, b] = await Promise.all([
      port.init(project, { source: "https://github.com/o/r/issues/4 card cardaaa1" }),
      port.init(project, { source: "https://github.com/o/r/issues/5 card cardbbb2" }),
    ]);
    expect(a).toMatchObject({ ok: true, flowId: "600" });
    expect(b).toMatchObject({ ok: true, flowId: "601" });
    expect(peak).toBe(1);
    expect(await port.findByCard(project, "cardaaa1")).toMatchObject({ flowId: "600" });
    expect(await port.findByCard(project, "cardbbb2")).toMatchObject({ flowId: "601" });
  });

  test("a failed init removes what it left, keeps what is not its own, and says why", async () => {
    const run: KeryxRunner = async (args) => {
      makeFlow(700, sourceArg(args));
      makeFlow(701, undefined, "half-written");
      makeFlow(702, "manual: not ours");
      return { code: 1, timedOut: false, stdout: "", stderr: "flow init: the issue could not be read\n" };
    };
    const result = await createDefaultFlowPort({ run }).init(project, { source: "https://github.com/o/r/issues/6 card fail999" });
    expect(result).toEqual({ ok: false, reason: "flow init failed: flow init: the issue could not be read" });
    expect(dirsNow()).toEqual(["702-2026-10-05-from-card"]);
  });

  test("a timed-out init is a failure too and leaves nothing of its own", async () => {
    const run: KeryxRunner = async (args) => {
      makeFlow(710, sourceArg(args));
      return { code: null, timedOut: true, stdout: "", stderr: "" };
    };
    const result = await createDefaultFlowPort({ run }).init(project, { source: "https://github.com/o/r/issues/7 card slow777" });
    expect(result).toEqual({ ok: false, reason: "flow init failed: timed out" });
    expect(dirsNow()).toEqual([]);
  });

  test("the keryx child gets the arguments of the card: issue, origin and source", async () => {
    let seen: readonly string[] = [];
    const run: KeryxRunner = async (args) => {
      seen = args;
      makeFlow(720, sourceArg(args));
      return OK;
    };
    await createDefaultFlowPort({ run }).init(project, { issueUrl: "https://github.com/o/r/issues/8", source: "https://github.com/o/r/issues/8 card args888" });
    expect(seen).toEqual(["flow", "init", "--issue", "https://github.com/o/r/issues/8", "--origin", "agent-proposal", "--source", "https://github.com/o/r/issues/8 card args888"]);
  });
});

describe("the environment of the keryx child (S5)", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    GH_TOKEN: "ghp_secret",
    GITHUB_TOKEN: "ghs_secret",
    GH_ENTERPRISE_TOKEN: "ghe_secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    KERYX_HOME: "/home/me/.keryx",
    KERYX_API_KEY: "keryx-secret",
    KERYX_DB_PASSWORD: "pw",
    GH_WORK_ROOT: "/home/me/work",
  };

  test("no token or secret of the host reaches it, and the account of the path is set", () => {
    const env = intakeChildEnv("/home/me/work/app", host);
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "KERYX_API_KEY", "KERYX_DB_PASSWORD"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(env["GH_ACCOUNT"]).toBe("work");
    expect(intakeChildEnv("/home/me/play/app", host)["GH_ACCOUNT"]).toBe("personal");
  });

  test("what it needs to run and find its settings is kept", () => {
    const env = intakeChildEnv("/home/me/work/app", host);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/me");
    expect(env["KERYX_HOME"]).toBe("/home/me/.keryx");
  });
});

describe("running a process (S6)", () => {
  const options = { cwd: tmpdir(), env: { PATH: process.env["PATH"] }, maxBytes: 4000 };

  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 100; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  test("a child that outlives its timeout is killed with its whole group, and the call returns soon after", async () => {
    const started = Date.now();
    const result = await runProcess(["sh", "-c", "sleep 30 & echo $!; wait"], { ...options, timeoutMs: 300, graceMs: 100 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  });

  test("a grandchild that keeps the output pipes open cannot hold the call: it returns after the child exits plus the grace", async () => {
    const started = Date.now();
    const result = await runProcess(["sh", "-c", "sleep 30 & echo $!; echo hello"], { ...options, timeoutMs: 20_000, graceMs: 150 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(await gone(Number(result.stdout.split("\n")[0]))).toBe(true);
  });

  test("an ordinary child returns its code and output, capped at maxBytes", async () => {
    const ok = await runProcess(["sh", "-c", "echo out; echo err 1>&2; exit 3"], { ...options, timeoutMs: 5000 });
    expect(ok).toMatchObject({ code: 3, timedOut: false, stdout: "out\n", stderr: "err\n" });
    const big = await runProcess(["sh", "-c", "yes x | head -c 100000"], { ...options, timeoutMs: 5000, maxBytes: 100 });
    expect(big.stdout.length).toBeLessThanOrEqual(100);
  });

  test("a program that does not exist is a result, not a throw", async () => {
    const result = await runProcess(["/definitely/not/a/program"], { ...options, timeoutMs: 1000 });
    expect(result.code).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(existsSync(options.cwd)).toBe(true);
  });
});
