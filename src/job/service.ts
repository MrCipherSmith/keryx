import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathExists, withFileLock, writeFileAtomic } from "../lib/fs";
import {
  assertPhaseTransition,
  assertStepTransition,
  evaluateJobGate,
  firstOpenStep,
  isTerminalStep,
  parseIntent,
  parseStepStatus,
  toStatusFlag,
} from "./machine";
import { defaultPlan } from "./plans";
import {
  appendJournal,
  assertDocumentType,
  assertJobName,
  documentFileName,
  jobDir,
  jobsRoot,
  listJobNames,
  readJob,
  renderJournal,
  writeJob,
} from "./store";
import type {
  JobDocumentInput,
  JobDocumentResult,
  JobInitInput,
  JobService,
  JobServiceDeps,
  JobState,
  JobStatusReport,
  JobStep,
  JobStepInput,
  JobStepMetric,
  JobStepResult,
  JobSummary,
} from "./types";

export function createJobService(deps: JobServiceDeps): JobService {
  const now = (): string => deps.now().toISOString();

  function lockPath(cwd: string, name: string): string {
    return path.join(jobsRoot(cwd), `.job-lock-${name}`);
  }

  /** Serialize load-mutate-save per job, as `src/flow/service.ts` does per flow. */
  async function mutate(
    cwd: string,
    name: string,
    run: (state: JobState) => Promise<{ state: JobState; event: string; detail?: string }>,
  ): Promise<JobState> {
    assertJobName(name);
    return withFileLock(lockPath(cwd, name), async () => {
      const loaded = await readJob(cwd, name);
      const { state, event, detail } = await run(loaded);
      state.updated_at = now();
      await writeJob(cwd, name, state);
      await appendJournal(cwd, name, state.updated_at, detail ? `${event}: ${detail}` : event);
      return state;
    });
  }

  function findStep(state: JobState, stepId: string): JobStep {
    const step = state.plan.steps.find((entry) => entry.id === stepId);
    if (!step) {
      throw new Error(
        `Unknown step "${stepId}" in job ${state.job_name}. ` +
          `Known steps: ${state.plan.steps.map((entry) => entry.id).join(", ")}`,
      );
    }
    return step;
  }

  /** The metrics row for a step, created on first touch so `retries` always exists. */
  function metricFor(state: JobState, stepId: string): JobStepMetric {
    state.metrics ??= { steps: [] };
    const existing = state.metrics.steps.find((entry) => entry.step_id === stepId);
    if (existing) {
      return existing;
    }
    const created: JobStepMetric = { step_id: stepId, retries: 0 };
    state.metrics.steps.push(created);
    return created;
  }

  return {
    async init(input: JobInitInput): Promise<{ state: JobState; dir: string }> {
      const name = assertJobName(input.name);
      const intent = parseIntent(input.intent);
      const absolute = jobDir(input.cwd, name);
      if (await pathExists(absolute)) {
        throw new Error(
          `Job package already exists: .metaproject/jobs/${name}. ` +
            `Run: keryx job status ${name}`,
        );
      }
      await mkdir(absolute, { recursive: true });

      const createdAt = now();
      const state: JobState = {
        // The plan is built at init, so the package opens in PLAN. CONTEXT stays
        // reachable in the machine for a state written by another producer.
        phase: "PLAN",
        intent,
        job_name: name,
        context: {
          project_dir: input.projectDir ?? input.cwd,
        },
        plan: { steps: defaultPlan(intent) },
        documentation: {
          job_path: path.join(".metaproject", "jobs", name),
          documents_created: [],
        },
        metrics: { steps: [] },
        jobs_root: path.join(".metaproject", "jobs"),
        updated_at: createdAt,
      };
      const first = firstOpenStep(state.plan.steps);
      if (first) {
        state.plan.current_step = first.id;
      }

      await writeFileAtomic(path.join(absolute, "journal.md"), renderJournal(name, createdAt));
      await writeJob(input.cwd, name, state);
      return { state, dir: path.relative(input.cwd, absolute) };
    },

    async status({ cwd, name }): Promise<JobStatusReport> {
      assertJobName(name);
      const state = await readJob(cwd, name);
      const gate = evaluateJobGate(state.plan.steps);
      const retries: Record<string, number> = {};
      for (const metric of state.metrics?.steps ?? []) {
        retries[metric.step_id] = metric.retries;
      }
      return {
        state,
        dir: path.join(".metaproject", "jobs", name),
        stepsDone: state.plan.steps.filter((step) => isTerminalStep(step.status)).length,
        stepsTotal: state.plan.steps.length,
        nextStep: firstOpenStep(state.plan.steps),
        open: gate.open,
        failed: gate.failed,
        retries,
        documents: state.documentation?.documents_created ?? [],
      };
    },

    async step(input: JobStepInput): Promise<JobStepResult> {
      // Parse BEFORE opening the package: an unknown --status must refuse with
      // the valid values, not with a lock timeout or a half-written state.
      const next = parseStepStatus(input.status);
      let result!: JobStepResult;
      await mutate(input.cwd, input.name, async (state) => {
        const step = findStep(state, input.stepId);
        assertStepTransition(step.id, step.status, next);
        const metric = metricFor(state, step.id);

        // The retry counter, made real. An attempt begins each time the step
        // moves INTO `in_progress`; the first leaves `retries` at 0 and every
        // re-entry adds one. `started_at` is how "has it been attempted before"
        // is decided, so the count survives a restart rather than living in a
        // resuming agent's memory.
        if (next === "in_progress") {
          if (metric.started_at !== undefined) {
            metric.retries += 1;
          }
          metric.started_at = now();
          delete metric.completed_at;
          delete metric.duration_ms;
        }
        if (isTerminalStep(next) || next === "failed") {
          const completedAt = now();
          metric.completed_at = completedAt;
          if (metric.started_at !== undefined) {
            metric.duration_ms = Math.max(
              0,
              Date.parse(completedAt) - Date.parse(metric.started_at),
            );
          }
        }
        metric.status = next;
        step.status = next;

        // Phase follows the work: the first recorded step moves the package out
        // of PLAN, so `job status` cannot report PLAN while steps are running.
        assertPhaseTransition(state.phase, "EXECUTION");
        state.phase = "EXECUTION";

        const open = firstOpenStep(state.plan.steps);
        if (open) {
          state.plan.current_step = open.id;
        } else {
          delete state.plan.current_step;
        }

        result = { state, step, retries: metric.retries };
        const reason = input.reason?.trim();
        return {
          state,
          event: "step",
          detail:
            `${step.id} ${toStatusFlag(next)} (retries ${metric.retries})` +
            (reason ? ` — ${reason}` : ""),
        };
      });
      return result;
    },

    async document(input: JobDocumentInput): Promise<JobDocumentResult> {
      const type = assertDocumentType(input.type);
      if (!input.file) {
        throw new Error(
          'Missing --file. Usage: keryx job document <name> --type <type> --file <path>',
        );
      }
      const source = path.isAbsolute(input.file)
        ? input.file
        : path.join(input.cwd, input.file);
      if (!(await pathExists(source))) {
        throw new Error(`--file not found: ${input.file}. Write the document first, then record it.`);
      }

      let recorded!: JobDocumentResult;
      await mutate(input.cwd, input.name, async (state) => {
        const fileName = documentFileName(type, source);
        const target = path.join(jobDir(input.cwd, state.job_name), fileName);
        await copyFile(source, target);

        state.documentation ??= {};
        state.documentation.job_path ??= path.join(".metaproject", "jobs", state.job_name);
        const created = state.documentation.documents_created ?? [];
        // Re-recording a document replaces the file and leaves ONE entry; a
        // duplicated name would make `documents_created` a count of writes
        // rather than a list of documents.
        state.documentation.documents_created = created.includes(fileName)
          ? created
          : [...created, fileName];

        recorded = {
          state,
          document: fileName,
          path: path.join(".metaproject", "jobs", state.job_name, fileName),
        };
        return { state, event: "document", detail: `${type} -> ${fileName}` };
      });
      return recorded;
    },

    async complete({ cwd, name }): Promise<JobState> {
      return mutate(cwd, name, async (state) => {
        const gate = evaluateJobGate(state.plan.steps);
        if (!gate.passed) {
          const parts: string[] = [];
          if (gate.open.length > 0) {
            parts.push(`not terminal: ${gate.open.join(", ")}`);
          }
          if (gate.failed.length > 0) {
            parts.push(`failed: ${gate.failed.join(", ")}`);
          }
          throw new Error(
            `Cannot complete job ${name} — ${gate.total - gate.open.length - gate.failed.length}/` +
              `${gate.total} steps terminal (${parts.join("; ")}). ` +
              "Close each with: keryx job step " +
              `${name} <step-id> --status completed|skipped [--reason "<why>"]`,
          );
        }
        assertPhaseTransition(state.phase, "COMPLETION");
        state.phase = "COMPLETION";
        delete state.plan.current_step;
        return { state, event: "completed", detail: `${gate.total} steps terminal` };
      });
    },

    async list({ cwd }): Promise<JobSummary[]> {
      const names = await listJobNames(cwd);
      const summaries: JobSummary[] = [];
      for (const name of names) {
        try {
          const state = await readJob(cwd, name);
          summaries.push({
            name: state.job_name,
            phase: state.phase,
            intent: state.intent,
            dir: path.join(".metaproject", "jobs", name),
            stepsDone: state.plan.steps.filter((step) => isTerminalStep(step.status)).length,
            stepsTotal: state.plan.steps.length,
            nextStep: firstOpenStep(state.plan.steps)?.id ?? null,
          });
        } catch {
          // A package without a readable state.json is reported by `job status`,
          // which can name the parse error; the listing stays usable.
        }
      }
      return summaries;
    },
  };
}
