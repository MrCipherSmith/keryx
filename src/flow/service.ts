import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic, withFileLock } from "../lib/fs";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { assertTransition } from "./machine";
import { flowStateSchema } from "./schema";
import { collectContext } from "./context";
import {
  acChecksum,
  acPath,
  appendJournal,
  assertAcIntact,
  flowIdOf,
  flowsRoot,
  groupFlowDirsById,
  listFlowDirs,
  nextFlowId,
  readAcCriteria,
  readFlow,
  resolveFlowDir,
  slugify,
  writeFlow,
} from "./store";
import {
  recordAllocation,
  reservedIds,
  resolveAllocationScope,
} from "./allocation";
import {
  renderAcceptanceCriteria,
  renderDescription,
  renderJournal,
  renderPlan,
  renderTasksDoc,
} from "./templates";
import type {
  FlowCheckResult,
  FlowCompleteResult,
  FlowIdMapEntry,
  FlowInitInput,
  FlowInitResult,
  FlowRenumberResult,
  FlowService,
  FlowServiceDeps,
  FlowState,
  FlowStatus,
  FlowTask,
  FlowSummary,
  GateOutcome,
  TaskKind,
} from "./types";

const DEFAULT_TASKS: Array<{ id: string; title: string; kind: TaskKind }> = [
  { id: "T1", title: "Collect remaining context", kind: "context" },
  { id: "T2", title: "Implement per plan", kind: "implement" },
  { id: "T3", title: "Add/adjust tests and make them pass", kind: "test" },
  { id: "T4", title: "Self-review and prepare draft PR", kind: "review" },
];

export function createFlowService(deps: FlowServiceDeps): FlowService {
  const now = () => deps.now().toISOString();

  async function load(cwd: string, id: string): Promise<{ dir: string; flow: FlowState }> {
    const dir = await resolveFlowDir(cwd, id);
    const flow = await readFlow(cwd, dir);
    return { dir, flow };
  }

  async function save(
    cwd: string,
    dir: string,
    flow: FlowState,
    event: string,
    detail?: string,
  ): Promise<FlowState> {
    flow.updatedAt = now();
    flow.history.push({ at: flow.updatedAt, event, ...(detail ? { detail } : {}) });
    await writeFlow(cwd, dir, flow);
    await appendJournal(cwd, dir, flow.updatedAt, detail ? `${event}: ${detail}` : event);
    return flow;
  }

  function flowLockPath(cwd: string, dir: string): string {
    return path.join(flowsRoot(cwd), `.flow-lock-${dir}`);
  }

  // Serialize load-mutate-save on one flow so concurrent agents cannot lose
  // updates (F-100). Keyed per-flow (by dir) — different flows never block each
  // other. `transition` runs WITHOUT its own lock so callers already holding the
  // lock (e.g. complete) do not deadlock the non-reentrant mkdir lock.
  async function mutate(
    cwd: string,
    id: string,
    run: (ctx: { dir: string; flow: FlowState }) => Promise<FlowState>,
  ): Promise<FlowState> {
    const dir = await resolveFlowDir(cwd, id);
    return withFileLock(flowLockPath(cwd, dir), async () => {
      const flow = await readFlow(cwd, dir);
      return run({ dir, flow });
    });
  }

  async function transition(
    cwd: string,
    dir: string,
    flow: FlowState,
    to: FlowStatus,
    event: string,
    detail?: string,
  ): Promise<FlowState> {
    await assertAcIntact(cwd, dir, flow);
    assertTransition(flow.status, to);
    flow.status = to;
    return save(cwd, dir, flow, event, detail);
  }

  return {
    async init(input: FlowInitInput): Promise<FlowInitResult> {
      if (!input.title && !input.issue) {
        throw new Error('flow init requires --title "<problem>" or --issue <url>');
      }

      const trackerReady = deps.tracker ? await deps.tracker.detect() : false;
      const tracker = trackerReady ? deps.tracker : null;
      const issueRef =
        input.issue && deps.tracker ? deps.tracker.parseRef(input.issue) : null;
      if (input.issue && deps.tracker && !issueRef) {
        throw new Error(`Unrecognized issue URL: ${input.issue}`);
      }

      const provisionalTitle = input.title ?? `Issue ${issueRef?.repo ?? ""}#${issueRef?.number ?? ""}`;
      const context = await collectContext({
        cwd: input.cwd,
        title: provisionalTitle,
        issueRef,
        issueUrl: input.issue ?? null,
        tracker,
        now: deps.now(),
      });
      const title = input.title ?? context.issueTitle ?? provisionalTitle;

      // The lock and the high-water mark live in the clone-wide allocation
      // scope, so a sibling worktree cannot mint the same id (flow 116).
      const scope = await resolveAllocationScope(input.cwd);
      return withFileLock(scope.lockPath, async () => {
        const id = await nextFlowId(input.cwd, await reservedIds(scope));
        const date = now().slice(0, 10);
        const slug = slugify(input.slug ?? title);
        const dir = `${id}-${date}-${slug}`;
        const absolute = path.join(flowsRoot(input.cwd), dir);
        if (await pathExists(absolute)) {
          throw new Error(`Flow directory already exists: ${dir}`);
        }
        await mkdir(absolute, { recursive: true });

        const createdAt = now();
        const flow: FlowState = {
          schemaVersion: 1,
          id,
          slug,
          title,
          status: "initializing",
          createdAt,
          updatedAt: createdAt,
          source: {
            type: input.issue ? "github-issue" : "description",
            ref: input.issue ?? null,
          },
          acChecksum: null,
          acConfirmed: {},
          pr: { url: null },
          tasks: DEFAULT_TASKS.map((task) => ({ ...task, status: "todo" })),
          history: [{ at: createdAt, event: "created" }],
        };

        const sourceLabel = input.issue ?? "user description";
        await writeFileAtomic(path.join(absolute, "description.md"), renderDescription(title, sourceLabel));
        await writeFileAtomic(path.join(absolute, "context.md"), context.markdown);
        await writeFileAtomic(path.join(absolute, "plan.md"), renderPlan());
        await writeFileAtomic(path.join(absolute, "tasks.md"), renderTasksDoc());
        await writeFileAtomic(path.join(absolute, "acceptance-criteria.md"), renderAcceptanceCriteria());
        await writeFileAtomic(path.join(absolute, "journal.md"), renderJournal(createdAt));
        await writeFlow(input.cwd, dir, flow);
        await recordAllocation(scope, { id, dir, at: createdAt, project: scope.project });

        return { flow, dir: path.relative(input.cwd, absolute), contextNotes: context.notes };
      });
    },

    async list({ cwd }): Promise<FlowSummary[]> {
      const dirs = await listFlowDirs(cwd);
      const summaries: FlowSummary[] = [];
      for (const dir of dirs) {
        try {
          const flow = await readFlow(cwd, dir);
          summaries.push({
            id: flow.id,
            slug: flow.slug,
            title: flow.title,
            status: flow.status,
            dir: `.metaproject/flows/${dir}`,
            tasksDone: flow.tasks.filter((task) => task.status === "done").length,
            tasksTotal: flow.tasks.length,
          });
        } catch {
          // surfaced by `flow check`
        }
      }
      return summaries;
    },

    async get({ cwd, id }): Promise<FlowState> {
      return (await load(cwd, id)).flow;
    },

    async freeze({ cwd, id }): Promise<FlowState> {
      return mutate(cwd, id, async ({ dir, flow }) => {
      assertTransition(flow.status, "ready");
      const criteria = await readAcCriteria(cwd, dir);
      const placeholder = criteria.length === 1 && (await isPlaceholderAc(cwd, dir));
      if (criteria.length === 0 || placeholder) {
        throw new Error(
          "Cannot freeze: acceptance-criteria.md must contain at least one real `- ACn:` criterion.",
        );
      }
      flow.acChecksum = await acChecksum(cwd, dir);
      flow.status = "ready";
      return save(cwd, dir, flow, "frozen", `${criteria.length} criteria; checksum recorded`);
      });
    },

    async start({ cwd, id }): Promise<FlowState> {
      return mutate(cwd, id, ({ dir, flow }) => transition(cwd, dir, flow, "in-progress", "started"));
    },

    async taskAdd(input): Promise<FlowState> {
      return mutate(input.cwd, input.id, async ({ dir, flow }) => {
      await assertAcIntact(input.cwd, dir, flow);
      const nextNumber =
        flow.tasks.reduce((acc, task) => Math.max(acc, Number(task.id.slice(1)) || 0), 0) + 1;
      const task: FlowTask = {
        id: `T${nextNumber}`,
        title: input.title,
        kind: input.kind ?? "implement",
        status: "todo" as const,
        // v2 additive defaults (TM-01 §2 / §5.1) for a freshly created task.
        dependsOn: input.dependsOn ?? [],
        attempts: { count: 0, log: [] },
        acRefs: [],
        evidenceRefs: [],
        budget: {},
      };
      flow.tasks.push(task);
      return save(input.cwd, dir, flow, "task-added", `${task.id}: ${task.title}`);
      });
    },

    async taskDone({ cwd, id, taskId, disposition, evidenceRefs, runLink }): Promise<FlowState> {
      return mutate(cwd, id, async ({ dir, flow }) => {
      await assertAcIntact(cwd, dir, flow);
      const task = flow.tasks.find((item) => item.id.toUpperCase() === taskId.toUpperCase());
      if (!task) {
        throw new Error(`Task not found: ${taskId}. Known: ${flow.tasks.map((t) => t.id).join(", ")}`);
      }
      task.status = "done";
      // Disposition is distinct from status (TM-01 §6). Honor an explicit
      // disposition; otherwise default a completed task to "completed".
      task.disposition = disposition ?? task.disposition ?? "completed";
      // v2 additive (backward-compatible): when the caller supplies mapped
      // evidence refs / run link (e.g. the harness ManagedFlowPort), record them
      // on the task. Omitted args leave existing behavior untouched.
      if (evidenceRefs !== undefined) {
        task.evidenceRefs = evidenceRefs;
      }
      if (runLink !== undefined) {
        task.runLink = runLink;
      }
      return save(cwd, dir, flow, "task-done", `${task.id}: ${task.title}`);
      });
    },

    async acConfirm({ cwd, id, criterion, note }): Promise<FlowState> {
      return mutate(cwd, id, async ({ dir, flow }) => {
      await assertAcIntact(cwd, dir, flow);
      const known = await readAcCriteria(cwd, dir);
      const target = criterion.toUpperCase();
      if (!known.includes(target)) {
        throw new Error(`Unknown criterion ${target}. Known: ${known.join(", ")}`);
      }
      flow.acConfirmed[target] = { at: now(), ...(note ? { note } : {}) };
      return save(cwd, dir, flow, "ac-confirmed", `${target}${note ? `: ${note}` : ""}`);
      });
    },

    async acUpdate({ cwd, id, reason }): Promise<FlowState> {
      if (!reason?.trim()) {
        throw new Error('flow ac update requires --reason "<why the criteria changed>"');
      }
      return mutate(cwd, id, async ({ dir, flow }) => {
        flow.acChecksum = await acChecksum(cwd, dir);
        flow.acConfirmed = {}; // criteria changed - prior confirmations are void
        return save(cwd, dir, flow, "ac-updated", reason);
      });
    },

    async implemented({ cwd, id, prUrl }): Promise<FlowState> {
      if (!prUrl?.trim()) {
        throw new Error("flow implemented requires --pr <draft PR url>");
      }
      return mutate(cwd, id, async ({ dir, flow }) => {
      await assertAcIntact(cwd, dir, flow);
      assertTransition(flow.status, "implemented");

      let detail = `draft PR: ${prUrl}`;
      if (deps.tracker && (await deps.tracker.detect())) {
        const pr = await deps.tracker.prStatus(prUrl);
        if (!pr.exists) {
          throw new Error(`PR not found or inaccessible: ${prUrl}`);
        }
        if (!pr.isDraft) {
          detail += " (warning: PR is not a draft)";
        }
      } else {
        detail += " (tracker unavailable: existence not verified)";
      }

      flow.pr.url = prUrl;
      flow.status = "implemented";
      return save(cwd, dir, flow, "implemented", detail);
      });
    },

    async complete({ cwd, id, comment, mergedCommit }): Promise<FlowCompleteResult> {
      const dir = await resolveFlowDir(cwd, id);
      return withFileLock(flowLockPath(cwd, dir), async () => {
      let flow = await readFlow(cwd, dir);
      if (mergedCommit && flow.status === "in-progress") {
        await assertAcIntact(cwd, dir, flow);
        flow.status = "completing";
        flow = await save(cwd, dir, flow, "completing", `merged commit: ${mergedCommit}`);
      } else {
        flow = await transition(cwd, dir, flow, "completing", "completing");
      }

      const gates: GateOutcome[] = [];

      // Gate 1: acceptance criteria (checksum + confirmations).
      try {
        await assertAcIntact(cwd, dir, flow);
        const criteria = await readAcCriteria(cwd, dir);
        const missing = criteria.filter((criterion) => !flow.acConfirmed[criterion]);
        gates.push(
          missing.length === 0 && criteria.length > 0
            ? { name: "acceptance-criteria", status: "pass", detail: `${criteria.length} confirmed` }
            : {
                name: "acceptance-criteria",
                status: "fail",
                detail: criteria.length === 0 ? "no criteria found" : `unconfirmed: ${missing.join(", ")}`,
              },
        );
      } catch (error) {
        gates.push({
          name: "acceptance-criteria",
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      // Gate 2: pull request, or an explicit proof that the implementation
      // commit is already contained in origin/main (direct-merge handoff).
      if (mergedCommit) {
        const merge = deps.mainMergeGate
          ? await deps.mainMergeGate(cwd, mergedCommit)
          : await verifyCommitOnMain(cwd, mergedCommit);
        gates.push({ name: "main-merge", status: merge.status, detail: merge.detail });
      } else if (!flow.pr.url) {
        gates.push({ name: "pull-request", status: "fail", detail: "no PR recorded" });
      } else if (deps.tracker && (await deps.tracker.detect())) {
        const pr = await deps.tracker.prStatus(flow.pr.url);
        gates.push(
          pr.exists && pr.checksGreen === true
            ? { name: "pull-request", status: "pass", detail: "PR exists, checks green" }
            : {
                name: "pull-request",
                status: "fail",
                detail: !pr.exists ? "PR not found" : "PR checks not green",
              },
        );
      } else {
        gates.push({
          name: "pull-request",
          status: "skipped",
          detail: "tracker unavailable; verify PR checks manually",
        });
      }

      // Gate 3: code health.
      try {
        const health = await deps.healthGate(cwd);
        gates.push(
          health.status === "fail"
            ? { name: "health", status: "fail", detail: health.reasons.join("; ") || "health gate failed" }
            : { name: "health", status: "pass", detail: `health gate: ${health.status}` },
        );
      } catch (error) {
        gates.push({
          name: "health",
          status: "skipped",
          detail: `health unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // Gate 4: security (§11). Omitted entirely when the module is disabled
      // (dep returns null), so advisory `flow complete` is never regressed.
      // Advisory -> pass (informational); enforced/ci -> may fail.
      if (deps.securityGate) {
        try {
          const security = await deps.securityGate(cwd);
          if (security) {
            gates.push({ name: "security", status: security.status, detail: security.detail });
          }
        } catch (error) {
          gates.push({
            name: "security",
            status: "skipped",
            detail: `security unavailable: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const passed = gates.every((gate) => gate.status !== "fail");
      let issueComment: string | null = null;
      let commented = false;

      if (passed) {
        if (mergedCommit) {
          flow.merged = { commit: mergedCommit, ref: "origin/main", at: now() };
        }
        flow = await transition(cwd, dir, flow, "done", "done", "all gates passed");
        issueComment = buildIssueComment(flow, gates);
        if (comment && flow.source.type === "github-issue" && flow.source.ref && deps.tracker) {
          const ref = deps.tracker.parseRef(flow.source.ref);
          if (ref && (await deps.tracker.detect())) {
            commented = await deps.tracker.comment(ref, issueComment);
          }
        }
      } else {
        const failed = gates.filter((gate) => gate.status === "fail");
        flow = await transition(
          cwd,
          dir,
          flow,
          "in-progress",
          "completion-failed",
          failed.map((gate) => `${gate.name}: ${gate.detail}`).join(" | "),
        );
      }

      return { flow, gates, passed, issueComment, commented };
      });
    },

    async block({ cwd, id, reason }): Promise<FlowState> {
      if (!reason?.trim()) {
        throw new Error('flow block requires --reason "<why>"');
      }
      return mutate(cwd, id, async ({ dir, flow }) => {
        assertTransition(flow.status, "blocked");
        flow.previousStatus = flow.status;
        flow.status = "blocked";
        return save(cwd, dir, flow, "blocked", reason);
      });
    },

    async unblock({ cwd, id }): Promise<FlowState> {
      return mutate(cwd, id, async ({ dir, flow }) => {
        if (flow.status !== "blocked" || !flow.previousStatus) {
          throw new Error("Flow is not blocked.");
        }
        flow.status = flow.previousStatus;
        delete flow.previousStatus;
        return save(cwd, dir, flow, "unblocked", `resumed as ${flow.status}`);
      });
    },

    async renumber({ cwd, ref, to, reason }): Promise<FlowRenumberResult> {
      if (!reason.trim()) {
        throw new Error('flow renumber requires --reason "<why>"');
      }
      if (!/^\d{3}$/.test(to)) {
        throw new Error(`Target flow id must be exactly three digits: got "${to}"`);
      }
      const fromDir = await resolveFlowDir(cwd, ref);
      const from = flowIdOf(fromDir);
      if (from === to) {
        throw new Error(`Flow ${fromDir} already has id ${to}`);
      }

      const scope = await resolveAllocationScope(cwd);
      return withFileLock(scope.lockPath, async () => {
        const dirs = await listFlowDirs(cwd);
        const taken = dirs.filter((dir) => flowIdOf(dir) === to);
        if (taken.length > 0) {
          throw new Error(`Flow id ${to} is already taken by ${taken.join(", ")}`);
        }
        // A number handed out once stays spent: reusing it would make the
        // references in merged PRs and journals ambiguous.
        if ((await reservedIds(scope)).includes(Number(to))) {
          throw new Error(
            `Flow id ${to} was already used in this repository and cannot be reused. ` +
              "Pick a fresh number (see .metaproject/flows/id-map.json).",
          );
        }

        const toDir = `${to}${fromDir.slice(3)}`;
        const flowsDir = flowsRoot(cwd);
        await rename(path.join(flowsDir, fromDir), path.join(flowsDir, toDir));

        const flow = await readFlow(cwd, toDir);
        flow.id = to;
        const at = now();
        await save(cwd, toDir, flow, "renumbered", `${from} -> ${to}: ${reason}`);
        await appendIdMap(cwd, { from, to, fromDir, toDir, at, reason });
        await recordAllocation(scope, { id: to, dir: toDir, at, project: scope.project });
        await recordAllocation(scope, {
          id: from,
          dir: fromDir,
          at,
          project: scope.project,
          retired: true,
        });

        return { flow, from, to, fromDir, toDir };
      });
    },

    async check({ cwd }): Promise<FlowCheckResult> {
      const issues: FlowCheckResult["issues"] = [];
      const allDirs = await listFlowDirs(cwd);
      // Repo-level rule: two packages sharing a number make every bare-id
      // reference ambiguous, so this is a hard failure like a checksum break.
      for (const [id, group] of groupFlowDirsById(allDirs)) {
        if (group.length < 2) {
          continue;
        }
        for (const dir of group) {
          issues.push({
            flow: dir,
            kind: "duplicate-id",
            message:
              `duplicate flow id ${id}, shared with ${group.filter((other) => other !== dir).join(", ")}` +
              ` — repair with: keryx flow renumber ${dir} --to <free id> --reason "<why>"`,
          });
        }
      }
      for (const dir of allDirs) {
        let flow: FlowState;
        try {
          flow = await readFlow(cwd, dir);
        } catch (error) {
          issues.push({
            flow: dir,
            kind: "structure",
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (flow.schemaVersion !== 1 && flow.schemaVersion !== 2) {
          issues.push({ flow: dir, kind: "schema", message: `unknown schemaVersion ${flow.schemaVersion}` });
        }
        // Validate the RAW on-disk flow.json against the published schema
        // (read-only; never writes flow.json — D-02 preserved).
        try {
          const raw: unknown = JSON.parse(await Bun.file(path.join(flowsRoot(cwd), dir, "flow.json")).text());
          const validation = validateAgainstSchemaObject(flowStateSchema(), raw);
          if (!validation.valid) {
            issues.push({
              flow: dir,
              kind: "schema",
              message: `schema: ${validation.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
            });
          }
        } catch {
          // A parse failure was already reported by readFlow above.
        }
        for (const file of ["description.md", "context.md", "plan.md", "tasks.md", "acceptance-criteria.md", "journal.md"]) {
          if (!(await pathExists(path.join(flowsRoot(cwd), dir, file)))) {
            issues.push({ flow: dir, kind: "structure", message: `missing ${file}` });
          }
        }
        if (flow.acChecksum && (await pathExists(acPath(cwd, dir)))) {
          const current = await acChecksum(cwd, dir);
          if (current !== flow.acChecksum) {
            issues.push({
              flow: dir,
              kind: "checksum",
              message: "acceptance criteria modified outside task-manager (checksum mismatch)",
            });
          }
        }
        if (flow.status === "done" && !flow.pr.url && !flow.merged) {
          issues.push({ flow: dir, kind: "state", message: "done without a recorded PR" });
        }
      }
      return { ok: issues.length === 0, issues };
    },
  };
}

// Renumbering rewrites a flow's identity, so the old number must stay
// traceable: merged PRs, journals and evidence refs still name it.
async function appendIdMap(cwd: string, entry: FlowIdMapEntry): Promise<void> {
  const file = path.join(flowsRoot(cwd), "id-map.json");
  let entries: FlowIdMapEntry[] = [];
  if (await pathExists(file)) {
    const raw = await readFile(file, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("expected an array");
      }
      entries = parsed as FlowIdMapEntry[];
    } catch (error) {
      // Never silently drop recorded history — the operator must fix the file.
      throw new Error(
        `Cannot read ${path.relative(cwd, file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  entries.push(entry);
  await writeFileAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
}

async function isPlaceholderAc(cwd: string, dir: string): Promise<boolean> {
  const content = await Bun.file(acPath(cwd, dir)).text();
  return content.includes("<replace with a hard, verifiable criterion");
}

function buildIssueComment(flow: FlowState, gates: GateOutcome[]): string {
  const done = flow.tasks.filter((task) => task.status === "done");
  const gateLine = gates.map((gate) => `${gate.name}: ${gate.status}`).join(", ");
  return [
    `Flow ${flow.id} (${flow.title}) is complete.`,
    "",
    `- Draft PR: ${flow.pr.url ?? "n/a"}`,
    ...(flow.merged ? [`- Main merge: ${flow.merged.commit} contained in ${flow.merged.ref}`] : []),
    `- Tasks: ${done.length}/${flow.tasks.length} done`,
    `- Acceptance criteria: ${Object.keys(flow.acConfirmed).length} confirmed`,
    `- Gates: ${gateLine}`,
  ].join("\n");
}

async function verifyCommitOnMain(
  cwd: string,
  commit: string,
): Promise<{ status: "pass" | "fail"; detail: string }> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
    return { status: "fail", detail: "merged commit must be a hexadecimal Git commit id" };
  }
  const process = Bun.spawn(["git", "merge-base", "--is-ancestor", commit, "origin/main"], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await process.exited;
  return exitCode === 0
    ? { status: "pass", detail: `${commit} is contained in origin/main` }
    : { status: "fail", detail: `${commit} is not contained in origin/main` };
}
