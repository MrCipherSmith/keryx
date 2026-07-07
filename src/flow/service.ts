import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { assertTransition } from "./machine";
import { collectContext } from "./context";
import {
  acChecksum,
  acPath,
  appendJournal,
  assertAcIntact,
  flowsRoot,
  listFlowDirs,
  nextFlowId,
  readAcCriteria,
  readFlow,
  resolveFlowDir,
  slugify,
  writeFlow,
} from "./store";
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
  FlowInitInput,
  FlowInitResult,
  FlowService,
  FlowServiceDeps,
  FlowState,
  FlowStatus,
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

  async function transition(
    cwd: string,
    id: string,
    to: FlowStatus,
    event: string,
    detail?: string,
  ): Promise<FlowState> {
    const { dir, flow } = await load(cwd, id);
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

      const id = await nextFlowId(input.cwd);
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
      await writeFile(path.join(absolute, "description.md"), renderDescription(title, sourceLabel), "utf8");
      await writeFile(path.join(absolute, "context.md"), context.markdown, "utf8");
      await writeFile(path.join(absolute, "plan.md"), renderPlan(), "utf8");
      await writeFile(path.join(absolute, "tasks.md"), renderTasksDoc(), "utf8");
      await writeFile(path.join(absolute, "acceptance-criteria.md"), renderAcceptanceCriteria(), "utf8");
      await writeFile(path.join(absolute, "journal.md"), renderJournal(createdAt), "utf8");
      await writeFlow(input.cwd, dir, flow);

      return { flow, dir: path.relative(input.cwd, absolute), contextNotes: context.notes };
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
      const { dir, flow } = await load(cwd, id);
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
    },

    async start({ cwd, id }): Promise<FlowState> {
      return transition(cwd, id, "in-progress", "started");
    },

    async taskAdd(input): Promise<FlowState> {
      const { dir, flow } = await load(input.cwd, input.id);
      await assertAcIntact(input.cwd, dir, flow);
      const nextNumber =
        flow.tasks.reduce((acc, task) => Math.max(acc, Number(task.id.slice(1)) || 0), 0) + 1;
      const task = {
        id: `T${nextNumber}`,
        title: input.title,
        kind: input.kind ?? "implement",
        status: "todo" as const,
      };
      flow.tasks.push(task);
      return save(input.cwd, dir, flow, "task-added", `${task.id}: ${task.title}`);
    },

    async taskDone({ cwd, id, taskId }): Promise<FlowState> {
      const { dir, flow } = await load(cwd, id);
      await assertAcIntact(cwd, dir, flow);
      const task = flow.tasks.find((item) => item.id.toUpperCase() === taskId.toUpperCase());
      if (!task) {
        throw new Error(`Task not found: ${taskId}. Known: ${flow.tasks.map((t) => t.id).join(", ")}`);
      }
      task.status = "done";
      return save(cwd, dir, flow, "task-done", `${task.id}: ${task.title}`);
    },

    async acConfirm({ cwd, id, criterion, note }): Promise<FlowState> {
      const { dir, flow } = await load(cwd, id);
      await assertAcIntact(cwd, dir, flow);
      const known = await readAcCriteria(cwd, dir);
      const target = criterion.toUpperCase();
      if (!known.includes(target)) {
        throw new Error(`Unknown criterion ${target}. Known: ${known.join(", ")}`);
      }
      flow.acConfirmed[target] = { at: now(), ...(note ? { note } : {}) };
      return save(cwd, dir, flow, "ac-confirmed", `${target}${note ? `: ${note}` : ""}`);
    },

    async acUpdate({ cwd, id, reason }): Promise<FlowState> {
      const { dir, flow } = await load(cwd, id);
      if (!reason?.trim()) {
        throw new Error('flow ac update requires --reason "<why the criteria changed>"');
      }
      flow.acChecksum = await acChecksum(cwd, dir);
      flow.acConfirmed = {}; // criteria changed - prior confirmations are void
      return save(cwd, dir, flow, "ac-updated", reason);
    },

    async implemented({ cwd, id, prUrl }): Promise<FlowState> {
      if (!prUrl?.trim()) {
        throw new Error("flow implemented requires --pr <draft PR url>");
      }
      const { dir, flow } = await load(cwd, id);
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
    },

    async complete({ cwd, id, comment }): Promise<FlowCompleteResult> {
      const { dir } = await load(cwd, id);
      let flow = await transition(cwd, id, "completing", "completing");

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

      // Gate 2: pull request.
      if (!flow.pr.url) {
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
        flow = await transition(cwd, id, "done", "done", "all gates passed");
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
          id,
          "in-progress",
          "completion-failed",
          failed.map((gate) => `${gate.name}: ${gate.detail}`).join(" | "),
        );
      }

      return { flow, gates, passed, issueComment, commented };
    },

    async block({ cwd, id, reason }): Promise<FlowState> {
      if (!reason?.trim()) {
        throw new Error('flow block requires --reason "<why>"');
      }
      const { dir, flow } = await load(cwd, id);
      assertTransition(flow.status, "blocked");
      flow.previousStatus = flow.status;
      flow.status = "blocked";
      return save(cwd, dir, flow, "blocked", reason);
    },

    async unblock({ cwd, id }): Promise<FlowState> {
      const { dir, flow } = await load(cwd, id);
      if (flow.status !== "blocked" || !flow.previousStatus) {
        throw new Error("Flow is not blocked.");
      }
      flow.status = flow.previousStatus;
      delete flow.previousStatus;
      return save(cwd, dir, flow, "unblocked", `resumed as ${flow.status}`);
    },

    async check({ cwd }): Promise<FlowCheckResult> {
      const issues: FlowCheckResult["issues"] = [];
      for (const dir of await listFlowDirs(cwd)) {
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
        if (flow.schemaVersion !== 1) {
          issues.push({ flow: dir, kind: "schema", message: `unknown schemaVersion ${flow.schemaVersion}` });
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
        if (flow.status === "done" && !flow.pr.url) {
          issues.push({ flow: dir, kind: "state", message: "done without a recorded PR" });
        }
      }
      return { ok: issues.length === 0, issues };
    },
  };
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
    `- Tasks: ${done.length}/${flow.tasks.length} done`,
    `- Acceptance criteria: ${Object.keys(flow.acConfirmed).length} confirmed`,
    `- Gates: ${gateLine}`,
  ].join("\n");
}
