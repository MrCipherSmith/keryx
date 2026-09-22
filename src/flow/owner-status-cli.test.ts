// Flow 289, AC7 — `flow status` shows the owner and the latest signature in
// the same line style as its existing rows. Also exercises the CLI's own
// signer-identity wiring (`--signed-by`, KERYX_ACTOR, and the git-config
// fallback `readGitUserEmail` in src/commands/flow.ts), not just the pure
// `resolveSignerIdentity` function (covered separately in identity.test.ts).
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { flowCommand } from "../commands/flow";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ACTOR = process.env["KERYX_ACTOR"];
let logs: string[] = [];
const realLog = console.log;

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-22T10:00:00Z"),
    ...over,
  };
}

// A fresh flow, created via a LOCAL service instance (fake tracker — never
// the CLI's real githubAdapter). `flowCommand` calls below read/mutate the
// same on-disk flow.json through the CLI's own service singleton, which
// touches no tracker for `status`/`owner set`/`ac confirm`.
async function fresh(): Promise<{ service: FlowService; id: string; dir: string }> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-owner-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const service = createFlowService(makeDeps());
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "CLI owner/signature test" });
  const dir = path.basename(created);
  return { service, id: flow.id, dir };
}

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ORIGINAL_ACTOR === undefined) {
    delete process.env["KERYX_ACTOR"];
  } else {
    process.env["KERYX_ACTOR"] = ORIGINAL_ACTOR;
  }
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

function captureLogs(): void {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
}

test("AC7: `flow status` shows 'not set' before an owner is named, and no signature line before one is signed", async () => {
  const { id } = await fresh();
  process.chdir(ROOT);
  captureLogs();

  await flowCommand(["status", id]);

  const printed = logs.join("\n");
  expect(printed).toContain("owner:");
  expect(printed).toContain("not set");
  expect(printed).toContain("signed:");
  expect(printed).toContain("no signatures yet");
});

test("AC1/AC7: `flow owner set` via the CLI is reflected in `flow status`", async () => {
  const { id } = await fresh();
  process.chdir(ROOT);

  await flowCommand(["owner", "set", id, "--owner", "Aleks", "--reason", "picked it up"]);

  captureLogs();
  await flowCommand(["status", id]);
  const printed = logs.join("\n");
  expect(printed).toContain("Aleks");
  expect(printed).toContain("[stated]");
});

test("AC7: `flow status` shows the latest signature after `ac confirm --signed-by`", async () => {
  const { service, id, dir } = await fresh();
  const acPath = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await Bun.write(acPath, "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n");
  await service.freeze({ cwd: ROOT, id });

  process.chdir(ROOT);
  await flowCommand(["ac", "confirm", id, "AC1", "--signed-by", "Priya"]);

  captureLogs();
  await flowCommand(["status", id]);
  const printed = logs.join("\n");
  expect(printed).toContain("Priya");
  expect(printed).toContain("[stated]");
  expect(printed).toContain("ac-confirm");
});

test("AC3/AC4: with no --signed-by and no KERYX_ACTOR, the CLI falls back to the local git identity (derived)", async () => {
  const { service, id, dir } = await fresh();
  const acPath = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await Bun.write(acPath, "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n");
  await service.freeze({ cwd: ROOT, id });

  // A local, checkout-only git identity — never a real person's credentials.
  const initProc = Bun.spawn(["git", "init", "-q"], { cwd: ROOT });
  await initProc.exited;
  const emailProc = Bun.spawn(["git", "config", "user.email", "checkout-only@example.com"], { cwd: ROOT });
  await emailProc.exited;

  delete process.env["KERYX_ACTOR"];
  process.chdir(ROOT);
  await flowCommand(["ac", "confirm", id, "AC1"]);

  const raw = JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8"),
  ) as FlowState;
  const signature = raw.signatures?.at(-1);
  expect(signature?.identity.basis).toBe("derived");
  expect(signature?.identity.value).toBe("checkout-only@example.com");
});
