export type PairedBenchmarkRun = {
  task_id: string;
  variant: "with-keryx" | "without-keryx";
  run_id: string;
  quality: string;
  metrics: Record<string, number | string | null>;
  human_interventions: number | string | null;
};

export type PairedBenchmarkValidation = {
  valid: boolean;
  errors: string[];
  task_ids: string[];
  speed_claim: "not-claimed";
};

export type PairedBenchmarkTemplate = {
  protocol: "paired-3-5-v1";
  task_ids: string[];
  runs: PairedBenchmarkRun[];
  speed_claim: "not-claimed";
};

export function createPairedBenchmarkTemplate(taskIds: string[]): PairedBenchmarkTemplate {
  const unique = [...new Set(taskIds)].sort();
  if (unique.length < 3 || unique.length > 5) throw new Error("benchmark template requires 3-5 unique task ids");
  return {
    protocol: "paired-3-5-v1",
    task_ids: unique,
    runs: unique.flatMap((task_id) => [
      {
        task_id,
        variant: "with-keryx" as const,
        run_id: "",
        quality: "unknown",
        metrics: {
          active_time_seconds: null,
          wall_time_seconds: null,
          context_files_read: null,
          retry_count: null,
        },
        human_interventions: null,
      },
      {
        task_id,
        variant: "without-keryx" as const,
        run_id: "",
        quality: "unknown",
        metrics: {
          active_time_seconds: null,
          wall_time_seconds: null,
          context_files_read: null,
          retry_count: null,
        },
        human_interventions: null,
      },
    ]),
    speed_claim: "not-claimed",
  };
}

export function validatePairedBenchmark(runs: PairedBenchmarkRun[]): PairedBenchmarkValidation {
  const errors: string[] = [];
  const byTask = new Map<string, PairedBenchmarkRun[]>();
  for (const run of runs) {
    const list = byTask.get(run.task_id) ?? [];
    list.push(run);
    byTask.set(run.task_id, list);
  }
  if (byTask.size < 3 || byTask.size > 5) errors.push("paired benchmark must contain 3-5 tasks");
  for (const [taskId, taskRuns] of byTask) {
    const variants = new Set(taskRuns.map((run) => run.variant));
    if (taskRuns.length !== 2 || variants.size !== 2) errors.push(`task ${taskId} is not paired`);
    if (new Set(taskRuns.map((run) => run.run_id)).size !== taskRuns.length) errors.push(`task ${taskId} has duplicate run_id`);
  }
  return {
    valid: errors.length === 0,
    errors,
    task_ids: [...byTask.keys()].sort(),
    speed_claim: "not-claimed",
  };
}
