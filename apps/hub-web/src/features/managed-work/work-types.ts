import type { Criterion, WorkCommand } from './types';

export type PreparedAction = Omit<WorkCommand, 'operationId'> & {
  title: string;
  help: string;
  waiverCriteria?: Criterion[];
  plan?: {
    criteria: string[];
    results: { title: string; deliverable: string; criteria: string[] }[];
  };
  scopeFlowId?: string;
};
