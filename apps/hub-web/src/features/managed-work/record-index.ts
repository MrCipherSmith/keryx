import type { Attempt, WorkIntent, WorkRecord } from './types';

export function indexWorkRecords(records: WorkRecord[]) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const intentsByFlow = new Map<string, WorkIntent[]>();
  const attemptsByIntent = new Map<string, Attempt[]>();
  for (const record of records) {
    if (record.kind === 'intent') {
      const children = intentsByFlow.get(record.flowId) ?? [];
      children.push(record);
      intentsByFlow.set(record.flowId, children);
    }
    if (record.kind === 'attempt') {
      const children = attemptsByIntent.get(record.intentId) ?? [];
      children.push(record);
      attemptsByIntent.set(record.intentId, children);
    }
  }
  return {byId, intentsByFlow, attemptsByIntent};
}
