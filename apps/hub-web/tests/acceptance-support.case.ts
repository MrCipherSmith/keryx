import { expect, test } from 'vitest';
import { canonicalCriteria } from '../src/features/acceptance/model';
import { demoWorkAdapter } from '../src/features/managed-work/demo';
import { recordOf } from '../src/features/managed-work/model';

test('late exact-subject evidence remains visible as a conflict outside the immutable submission manifest',async()=>{
 const records=(await demoWorkAdapter('p').snapshot()).records;const submission=recordOf(records,'submission','sub-agent')!;const revision=recordOf(records,'intent-revision',submission.intentRevisionId)!;const passing=recordOf(records,'evidence','ev-agent')!;
 records.push({...passing,id:'late-failure',result:'fail',report:'Late contradictory review'});
 const row=canonicalCriteria(revision.criteria,submission,records)[0]!;
 expect(row.status).toBe('conflicting');expect(row.reports.map(report=>report.id)).toContain('late-failure');expect(submission.evidenceIds).not.toContain('late-failure');
});
