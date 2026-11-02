import type { Criterion, WorkCommand } from './types';

export type PreparedAction = Omit<WorkCommand, 'operationId'> & {
  title: string;
  help: string;
  waiverCriteria?: Criterion[];
  scopeFlowId?: string;
};
