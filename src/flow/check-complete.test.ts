// Flow 364, AC4/AC5/AC8: the read-only completion check.
//
// - It evaluates the gates `complete` evaluates, through the same function: a
//   check followed by a completion on the same state reports the same gates.
// - It writes nothing, pass or fail: every file under the flow directory is
//   byte-identical afterwards, a confirmation token included.
// - It reports the PR's merge state from the tracker, and `unknown` whenever
//   the tracker did not say.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand } from "../commands/flow";
import { writeCleanReviewPackage } from "./review-fixtures";
import { completionFixHint, createFlowService } from "./service";
import type { FlowService, FlowServiceDeps, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";
const PR = "https://github.com/acme/app/pull/1";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const clock = new Date("2026-10-01T10:00:00Z");

type PrStatus = Awaited<ReturnType<TrackerAdapter["prStatus"]>>;

function fakeTracker(status: Partial<PrStatus> = {}, detect = true): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => detect,
    parseRef: () => null,
    fetchIssue: async () => null,
    prStatus: async () => ({ exists: true, isDraft: false, checksGreen: true, headSha: HEAD, state: "MERGED", ...status }),
    comment: async () => true,
  };
}

async function fresh(over: Partial<FlowServiceDeps> = {}): Promise<FlowService> {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-check-complete-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService({
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => clock,
    ...over,
  });
}

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function readyFlow(
  service: FlowService,
  opts: { confirmAc?: boolean; implemented?: boolean; requireConfirmation?: boolean } = {},
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({
    cwd: ROOT,
    title: "Check me",
    owner: "Aleks",
    requireConfirmation: opts.requireConfirmation ?? false,
  });
  const dir = path.basename(created);
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: One\n- AC2: Two\n",
    "utf8",
  );
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  if (opts.implemented !== false) await service.implemented({ cwd: ROOT, id: flow.id, prUrl: PR });
  if (opts.confirmAc !== false) {
    await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
    await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC2" });
  }
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR });
  for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  return { id: flow.id, dir };
}

/** Every file under `.metaproject/flows`, path → bytes, the lock directory included if one were left. */
async function snapshot(): Promise<Map<string, string>> {
  const root = path.join(ROOT, ".metaproject", "flows");
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, full), entry.isFile() ? await readFile(full, "utf8") : "<dir>");
  }
  return files;
}

test("AC4: a passing check writes nothing, and `complete` on the same state then records the same gates", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service);
  const before = await snapshot();

  const check = await service.checkComplete({ cwd: ROOT, id });
  expect(await snapshot()).toEqual(before);
  expect(check.status).toBe("implemented");
  expect(check.transition.allowed).toBe(true);
  expect(check.merge).toEqual({ state: "merged", detail: "PR merged" });
  expect(check.confirmationRequired).toBe(false);

  const completed = await service.complete({ cwd: ROOT, id });
  expect(completed.gates).toEqual(check.gates);
  expect(check.passed).toBe(completed.passed);
});

test("AC4: a failing check writes nothing either — no attempt, no status change — and names the fix", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service, { confirmAc: false });
  const before = await snapshot();

  const check = await service.checkComplete({ cwd: ROOT, id });
  expect(await snapshot()).toEqual(before);
  expect(check.passed).toBe(false);
  const ac = check.gates.find((gate) => gate.name === "acceptance-criteria");
  expect(ac).toEqual({ name: "acceptance-criteria", status: "fail", detail: "unconfirmed: AC1, AC2" });
  expect(completionFixHint(ac!, id)).toBe(`keryx flow ac confirm ${id} AC1 --note "<evidence>" (then AC2)`);
  expect((await service.get({ cwd: ROOT, id })).completionAttempts).toBeUndefined();
});

test("AC4: a confirmation token is checked, never spent", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service, { requireConfirmation: true });
  const { token } = await service.confirmMint({ cwd: ROOT, id });
  const before = await snapshot();

  const check = await service.checkComplete({ cwd: ROOT, id, confirmToken: token });
  expect(check.confirmationRequired).toBe(true);
  expect(check.gates.at(-1)?.name).toBe("confirmation");
  expect(check.gates.at(-1)?.status).toBe("pass");
  expect(await snapshot()).toEqual(before);
  // The same token still completes the flow: the check did not spend it.
  expect((await service.complete({ cwd: ROOT, id, confirmToken: token })).passed).toBe(true);
});

test("AC4: an in-progress flow without a merged commit cannot start a completion; the check says so", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service, { implemented: false });
  const check = await service.checkComplete({ cwd: ROOT, id });
  expect(check.transition.allowed).toBe(false);
  expect(check.transition.detail).toContain(`keryx flow implemented ${id} --pr <url>`);
  expect(check.passed).toBe(false);
  expect(check.merge.state).toBe("no-pr");
});

test("AC4: merge state comes from the tracker, and is `unknown` whenever the tracker did not say", async () => {
  // The flow is made implemented against an existing PR, then the tracker's answer changes.
  let current: TrackerAdapter = fakeTracker();
  const tracker: TrackerAdapter = {
    ...fakeTracker(),
    detect: () => current.detect(),
    prStatus: (url) => current.prStatus(url),
  };
  const service = await fresh({ tracker });
  const { id } = await readyFlow(service);
  const cases: Array<[TrackerAdapter, string]> = [
    [fakeTracker({ state: "OPEN" }), "open"],
    [fakeTracker({ state: "CLOSED" }), "closed"],
    [fakeTracker({ state: null }), "unknown"],
    [fakeTracker({ state: undefined }), "unknown"],
    [fakeTracker({ exists: false }), "not-found"],
    [fakeTracker({}, false), "unknown"],
  ];
  for (const [next, expected] of cases) {
    current = next;
    expect((await service.checkComplete({ cwd: ROOT, id })).merge.state).toBe(expected);
  }
});

test("AC4: `keryx flow check-complete --json` prints the check and exits by whether complete would pass", async () => {
  const service = await fresh();
  const { id } = await readyFlow(service, { confirmAc: false });
  process.chdir(ROOT);
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  // The CLI builds its own service from the real deps; only its shape and exit code are asserted here.
  await flowCommand(["check-complete", id, "--json"]);
  const printed = JSON.parse(lines.join("\n")) as { id: string; passed: boolean; gates: unknown[] };
  expect(printed.id).toBe(id);
  expect(printed.passed).toBe(false);
  expect(printed.gates.length).toBeGreaterThan(0);
  expect(process.exitCode).toBe(1);
});

test("AC5: completionFixHint names a command only for a failing gate with a known remedy", () => {
  expect(completionFixHint({ name: "owner", status: "fail", detail: "no owner set" }, "7")).toBe(
    'keryx flow owner set 7 --owner "<name>" --reason "<why>"',
  );
  expect(completionFixHint({ name: "pull-request", status: "fail", detail: "no PR recorded" }, "7")).toBe(
    "keryx flow implemented 7 --pr <url>",
  );
  expect(completionFixHint({ name: "pull-request", status: "fail", detail: "PR checks not green" }, "7")).toBeUndefined();
  expect(completionFixHint({ name: "health", status: "pass", detail: "health gate: pass" }, "7")).toBeUndefined();
  expect(completionFixHint({ name: "review", status: "fail", detail: "x" }, "7")).toBeUndefined();
});
