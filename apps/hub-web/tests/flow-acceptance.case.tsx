import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import i18n from '../src/i18n';
import { recordOf } from '../src/features/managed-work/model';
import { acceptanceFixture, addCoverageCases, mountAcceptance, mutationRequests, returnedDecision, type AcceptanceFixture } from './flow-acceptance.fixture';

let fixture:AcceptanceFixture;
beforeEach(async()=>{fixture=await acceptanceFixture();});
const openReturn=async()=>{const button=await screen.findByRole('button',{name:'Return for changes'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);return screen.findByRole('textbox',{name:'Return comment'});};
const confirmReturn=()=>fireEvent.click(screen.getByRole('button',{name:'Confirm return'}));

test('canonical review explains delivered effect and exact Intent target before collapsed technical identifiers',async()=>{
 mountAcceptance('canonical');
 const narrative=await screen.findByRole('heading',{name:'What was done'});
 expect(screen.getByText('Keyboard navigation delivered')).toBeVisible();
 expect(await screen.findByText('Reviewers can navigate without a mouse')).toBeVisible();
 expect(screen.getByText('Safari requires a manual check')).toBeVisible();
 expect(screen.getAllByText(/human:maya|agent:|Contributor/i).length).toBeGreaterThan(0);
 const summary=screen.getByText('Technical details',{selector:'summary'});const details=summary.closest('details')!;
 expect(details).not.toHaveAttribute('open');expect(narrative.compareDocumentPosition(summary)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 summary.focus();expect(summary).toHaveFocus();fireEvent.click(summary);expect(details).toHaveAttribute('open');
 expect(within(details).getAllByText(fixture.submission.contentDigest).length).toBeGreaterThan(0);
 expect(screen.queryByRole('textbox',{name:/digest|submission id/i})).not.toBeInTheDocument();
});

test('canonical guide resolves its exact immutable document and copy stays inert',async()=>{
 const copy=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}});const open=vi.spyOn(window,'open').mockImplementation(()=>null);
 mountAcceptance('canonical');await screen.findByRole('heading',{name:'How to check'});
 expect(await screen.findByText('Open the disposable project')).toBeVisible();expect(screen.getByText('Hub browser')).toBeVisible();expect(screen.getByText('The highlighted result is visible')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Copy instruction'}));
 await waitFor(()=>expect(copy).toHaveBeenCalledWith("printf 'review-only'"));expect(await screen.findByText('Instruction copied',{selector:'[role=status]'})).toBeVisible();
 expect(fixture.requests.some(request=>request.url.includes('/documents/guide-doc/versions/1?digest='+fixture.guideDigest))).toBe(true);
 expect(mutationRequests(fixture)).toHaveLength(0);expect(open).not.toHaveBeenCalled();
});

test.each(['missing-selector','mismatched-artifact','ambiguous-artifact','malformed-envelope'] as const)('canonical %s guide is explicit and never scans another document',async(mode)=>{
 if(mode==='missing-selector')fixture.subject.report='Contributor plain report';
 if(mode==='mismatched-artifact')fixture.subject.artifacts=fixture.subject.artifacts.filter(artifact=>artifact.kind!=='document');
 if(mode==='ambiguous-artifact')fixture.subject.artifacts.push({kind:'document',reference:fixture.guideRef,proposalId:null});
 if(mode==='malformed-envelope')fixture.subject.report='{"format":"review-report/v1","summary":42}';
 mountAcceptance('canonical');await screen.findByRole('heading',{name:'How to check'});
 expect(await screen.findByText(mode==='missing-selector'?'No verification steps were supplied':'Verification guidance is unavailable')).toBeVisible();
 if(mode!=='missing-selector')expect(screen.queryByText(/Criteria without verification steps/)).not.toBeInTheDocument();
 expect(fixture.requests.filter(request=>request.url.includes('/documents/')&&!request.url.includes('/guide-doc/'))).toHaveLength(0);
 expect(mutationRequests(fixture)).toHaveLength(0);
});

test('canonical review lists every pinned criterion with conflicting and missing support instead of the last green report',async()=>{
 addCoverageCases(fixture);mountAcceptance('canonical');await screen.findByRole('heading',{name:'Acceptance criteria',level:2});
 for(const [criterion,status] of [['Passing criterion','Reported pass'],['Failing criterion','Failing support'],['Inconclusive criterion','Inconclusive'],['Missing criterion','Missing support'],['Conflicting criterion','Conflicting support']]){
  expect(within(screen.getByRole('group',{name:criterion})).getByText(status!)).toBeVisible();
 }
 expect(screen.getByRole('button',{name:'Accept result'})).toBeDisabled();
 expect(screen.getByRole('group',{name:'Conflicting criterion'})).toHaveTextContent('Evidence for ci-conflict: fail');
});

test('review provenance distinguishes contributor agent human and observed CI without trusting method names',async()=>{
 const template=recordOf(fixture.records,'evidence','ev-agent')!;
 template.method='Verified by CI (contributor text)';
 const extra=[{id:'independent-agent',source:'machine-observation' as const,createdBy:'agent:independent',sourceRunId:'independent-run',report:'Independent agent check'},{id:'human-check',source:'human-review' as const,createdBy:'human:reviewer',sourceRunId:null,report:'Human review check'},{id:'observed-ci',source:'ci-observation' as const,createdBy:'server:ci-observer',sourceRunId:null,sourceObservationId:'ci-observation-1',report:'Provider-observed CI result'}];
 fixture.records.push(...extra.map(record=>({...template,...record})));fixture.submission.evidenceIds.push(...extra.map(record=>record.id));fixture.submission.coverage[0]!.evidenceIds.push(...extra.map(record=>record.id));
 mountAcceptance('canonical');await screen.findByRole('heading',{name:'Acceptance criteria',level:2});
 expect(screen.getByText('Contributor report')).toBeVisible();expect(screen.getByText('Agent report')).toBeVisible();expect(screen.getByText('Human review')).toBeVisible();expect(screen.getByText('Observed CI')).toBeVisible();
 const independent=screen.getByText('Agent report').closest('[role=group]')!;expect(independent).toHaveTextContent('Independent agent check');expect(independent).not.toHaveTextContent('Observed CI');
});

test('canonical accept confirms the Intent effect and preserves exact command pins without accepting the Flow',async()=>{
 mountAcceptance('canonical');const accept=await screen.findByRole('button',{name:'Accept result'});await waitFor(()=>expect(accept).toBeEnabled());fireEvent.click(accept);
 expect(screen.getAllByText(/accept.*deliverable|Intent.*accept/i).length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'Confirm acceptance'}));
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));const request=mutationRequests(fixture)[0]!;
 expect(request.body).toMatchObject({command:'review.decide',expectedVersions:{'flow-demo':1,i1:1,'a-agent':1},payload:{targetType:'intent-review',targetId:'i1',submissionId:fixture.submission.id,submissionDigest:fixture.submission.contentDigest,decision:'accept'}});
 expect(request.headers.get('Idempotency-Key')).toBe(request.body!.operationId);expect(JSON.stringify(request.body)).not.toContain('flow-review');
});

test('canonical return composes selected criterion IDs and comment within the existing4000character reason budget',async()=>{
 mountAcceptance('canonical');const comment=await openReturn();
 fireEvent.change(comment,{target:{value:'x'.repeat(4000)}});fireEvent.click(screen.getByRole('checkbox',{name:'Relate to: Arrow keys and focus verified'}));
 expect(screen.getByRole('button',{name:'Confirm return'})).toBeDisabled();expect(screen.getByText(/4000|remaining/i)).toBeVisible();
 fireEvent.change(comment,{target:{value:'Keyboard focus disappears in Safari'}});confirmReturn();
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));const body=mutationRequests(fixture)[0]!.body!;
 expect(body).toMatchObject({command:'review.decide',payload:{targetType:'intent-review',targetId:'i1',submissionId:fixture.submission.id,submissionDigest:fixture.submission.contentDigest,decision:'request-changes'}});
 const reason=(body.payload as {reason:string}).reason;expect(reason).toContain('Keyboard focus disappears in Safari');expect(reason).toContain('ci1');expect(reason.length).toBeLessThanOrEqual(4000);
});

test('canonical selection and server eligibility remain separate from reviewer scratch notes',async()=>{
 fixture.intent.selectedSubmissionId=null;mountAcceptance('canonical');await screen.findByRole('heading',{name:'Decision'});
 expect(screen.getByRole('button',{name:'Accept result'})).toBeDisabled();expect(screen.getByText(/select.*attempt.*before.*accept/i)).toBeVisible();
 const note=screen.getByRole('textbox',{name:'Personal review notes'});fireEvent.change(note,{target:{value:'Looks ready to me'}});
 expect(screen.getByRole('button',{name:'Accept result'})).toBeDisabled();expect(mutationRequests(fixture)).toHaveLength(0);
});

test.each(['en','ru'] as const)('legacy no-guide review in %s keeps unmapped reports honest and exposes plain decisions',async(language)=>{
 fixture=await acceptanceFixture(language);fixture.legacyResult.files=[];mountAcceptance('legacy');
 await screen.findByRole('heading',{name:language==='en'?'What was done':'Что сделано'});
 expect(await screen.findByText(language==='en'?'No verification steps were supplied':'Шаги проверки не предоставлены')).toBeVisible();
 expect(screen.getByText(language==='en'?'Reports without criterion mapping':'Отчёты без привязки к критериям')).toBeVisible();
 expect(screen.getByText('Keyboard focus remains visible')).toBeVisible();expect(screen.getByText('Screen reader labels are clear')).toBeVisible();
 expect(screen.queryByText(language==='en'?'Observed CI':'Наблюдаемый CI')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:language==='en'?'Accept result':'Принять результат'})).toBeEnabled();
 expect(screen.getByRole('button',{name:language==='en'?'Return for changes':'Вернуть на доработку'})).toBeEnabled();
});

test('legacy designated guide renders bounded instructions without publishing its review-only bundle',async()=>{
 mountAcceptance('legacy');await screen.findByRole('heading',{name:'How to check'});
 expect(await screen.findByText('The highlighted result is visible')).toBeVisible();expect(await screen.findByText('Reviewers can navigate without a mouse')).toBeVisible();
 expect(screen.getByText(/contributor.*guide|guide.*contributor/i)).toBeVisible();expect(screen.queryByRole('button',{name:/publish|merge|deploy/i})).not.toBeInTheDocument();
 expect(mutationRequests(fixture)).toHaveLength(0);
});

test('legacy acceptance confirmation captures existing exact-result acknowledgment in plain language',async()=>{
 mountAcceptance('legacy');fireEvent.click(await screen.findByRole('button',{name:'Accept result'}));
 const confirm=screen.getByRole('button',{name:'Confirm acceptance'});expect(confirm).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:/self.reported|supplied reports/i}));fireEvent.click(confirm);
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));expect(mutationRequests(fixture)[0]!.body).toEqual({expectedVersion:4,subjectRevisionId:'legacy-result',acknowledgeSelfReportedEvidence:true});
 expect(mutationRequests(fixture)[0]!.url).toContain('/flows/legacy-flow/accept');
});

test.each(['','   ','x'.repeat(4001)])('legacy return rejects a blank or oversized comment before sending',async(value)=>{
 mountAcceptance('legacy');const comment=await openReturn();comment.focus();fireEvent.change(comment,{target:{value}});confirmReturn();
 expect(await screen.findByRole('alert')).toHaveTextContent(/comment|required|4000/i);expect(comment).toHaveFocus();expect(mutationRequests(fixture)).toHaveLength(0);
});

test('legacy return sends exact positional criterion references and shows persisted contributor feedback',async()=>{
 const decision=returnedDecision(fixture);fixture.respond=request=>{
  if(request.method==='POST'&&request.url.endsWith('/request-changes')){fixture.legacyFlow.status='in-progress';fixture.legacyFlow.version=5;fixture.legacyFlow.subjectRevisionId=null;fixture.legacyFlow.lastReturnDecisionId=decision.id;fixture.legacyFlow.reviewFeedback=decision;return Response.json({status:'committed',operationId:request.headers.get('Idempotency-Key'),flowVersion:5,flowState:'in-progress',decision});}
 };
 mountAcceptance('legacy');fireEvent.change(await openReturn(),{target:{value:'  Please verify keyboard focus in Safari  '}});fireEvent.click(screen.getByRole('checkbox',{name:'Relate to: Keyboard focus remains visible'}));confirmReturn();
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));expect(mutationRequests(fixture)[0]!.body).toEqual({expectedVersion:4,subjectRevisionId:'legacy-result',comment:decision.comment,criterionRefs:[{specContentDigest:fixture.spec.contentDigest,position:1}]});
 expect(await screen.findByRole('status')).toHaveTextContent(/returned|changes requested/i);expect(screen.getByText(decision.comment)).toBeVisible();
});

test('stale legacy return keeps the typed comment and requires an explicitly re-reviewed target',async()=>{
 fixture.respond=request=>request.method==='POST'?Response.json({error:{code:'subject-changed',message:'Reviewed result changed'}},{status:409}):undefined;
 const view=mountAcceptance('legacy');const comment=await openReturn();fireEvent.change(comment,{target:{value:'Keep this exact return comment'}});confirmReturn();
 expect(await screen.findByRole('alert')).toHaveTextContent(/result.*changed|review.*again/i);expect(comment).toHaveValue('Keep this exact return comment');
 act(()=>view.cache.setQueryData([73,'p','flow','legacy-flow'],{...fixture.legacyFlow,version:5,subjectRevisionId:'new-result'}));
 expect(screen.getByRole('button',{name:'Confirm return'})).toBeDisabled();expect(mutationRequests(fixture)).toHaveLength(1);
});

test('lost legacy return response keeps its key and reconciles404 as unknown without another mutation',async()=>{
 fixture.respond=request=>{
  if(request.method==='POST'&&request.url.endsWith('/request-changes'))throw new TypeError('Connection lost');
  if(request.url.includes('/review-operations/'))return Response.json({error:{code:'operation-not-found',message:'Not yet observed'}},{status:404});
 };
 mountAcceptance('legacy');fireEvent.change(await openReturn(),{target:{value:'Return exactly this candidate'}});confirmReturn();
 fireEvent.click(await screen.findByRole('button',{name:'Check decision status'}));
 await waitFor(()=>expect(fixture.requests.some(request=>request.url.includes('/review-operations/'))).toBe(true));
 const original=mutationRequests(fixture)[0]!;expect(fixture.requests.find(request=>request.url.includes('/review-operations/'))!.url).toContain('/review-operations/'+original.headers.get('Idempotency-Key'));
 expect(screen.getByRole('textbox',{name:'Return comment'})).toHaveValue('Return exactly this candidate');expect(screen.getByText(/outcome.*unknown|decision.*unknown/i)).toBeVisible();expect(mutationRequests(fixture)).toHaveLength(1);
});

test('return drafts are private to project and reviewer and survive a language change',async()=>{
 const view=mountAcceptance('legacy');fireEvent.change(await openReturn(),{target:{value:'Private draft for project P'}});
 view.scope({projectId:'q',location:{projectId:'q',tab:'flows',flowId:'legacy-flow'}});expect(await openReturn()).toHaveValue('');fireEvent.change(screen.getByRole('textbox',{name:'Return comment'}),{target:{value:'Other project draft'}});
 view.scope({projectId:'p',location:{projectId:'p',tab:'flows',flowId:'legacy-flow'}});expect(await openReturn()).toHaveValue('Private draft for project P');
 view.scope({principal:{id:'human:other',kind:'human',role:'operator'}});expect(await openReturn()).toHaveValue('');
 view.scope({principal:{id:'human:reviewer',kind:'human',role:'operator'}});expect(await openReturn()).toHaveValue('Private draft for project P');
 await act(async()=>{await i18n.changeLanguage('ru');});expect(screen.getByRole('textbox',{name:'Комментарий для доработки'})).toHaveValue('Private draft for project P');
});

test('historical completed legacy results are readable but never reopened or returned',async()=>{
 fixture.legacyFlow.status='done';fixture.legacyFlow.acceptedBy='human:reviewer';fixture.legacyResult.files=[];mountAcceptance('legacy');await screen.findByRole('heading',{name:'What was done'});
 expect(screen.getByText(/completed result.*read.only/i)).toBeVisible();expect(screen.queryByRole('button',{name:'Accept result'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Return for changes'})).not.toBeInTheDocument();expect(mutationRequests(fixture)).toHaveLength(0);
});

test('legacy return feedback appears in project Overview without inventing an assignee',async()=>{
 const decision=returnedDecision(fixture);fixture.legacyFlow.status='in-progress';fixture.legacyFlow.reviewFeedback=decision;fixture.legacyFlow.lastReturnDecisionId=decision.id;
 mountAcceptance('overview');expect(await screen.findByText(decision.comment)).toBeVisible();expect(screen.getAllByText(/returned for changes|changes requested/i).length).toBeGreaterThan(0);expect(screen.queryByText('Assigned to human:reviewer')).not.toBeInTheDocument();
});

test.each([403,404])('unavailable canonical guide (%s) stays explicit without inventing steps or granting authority',async(status)=>{
 fixture.documentStatus=status;mountAcceptance('canonical');await screen.findByRole('heading',{name:'How to check'});
 expect(await screen.findByText('Verification guidance is unavailable')).toBeVisible();expect(screen.queryByText('The highlighted result is visible')).not.toBeInTheDocument();expect(mutationRequests(fixture)).toHaveLength(0);
 expect(screen.queryByText(/Criteria without verification steps/)).not.toBeInTheDocument();
});

test('an agent cannot accept or return through permissive canonical command hints',async()=>{
 mountAcceptance('canonical',{principal:{id:'agent:contributor',kind:'agent',role:'agent'}});await screen.findByRole('heading',{name:'Decision'});
 expect(screen.getByText(/authorized human|human reviewer/i)).toBeVisible();
 for(const name of ['Accept result','Return for changes']){const button=screen.queryByRole('button',{name});if(button)expect(button).toBeDisabled();}
 expect(mutationRequests(fixture)).toHaveLength(0);
});

test('unknown canonical execution outcome remains a visible acceptance block despite passing support',async()=>{
 fixture.attempt.executionOutcome='unknown';mountAcceptance('canonical');await screen.findByRole('heading',{name:'Decision'});
 expect(screen.getByText(/execution.*unknown|unknown.*execution/i)).toBeVisible();expect(screen.getByRole('button',{name:'Accept result'})).toBeDisabled();expect(mutationRequests(fixture)).toHaveLength(0);
});

test('an accepted canonical Intent is read-only and a return cannot reset its accepted decision',async()=>{
 fixture.intent.state='accepted';fixture.intent.acceptanceDecisionId='accepted-decision';fixture.attempt.state='accepted';mountAcceptance('canonical');await screen.findByRole('heading',{name:'What was done'});
 expect(screen.getByText(/accepted result.*read.only/i)).toBeVisible();expect(screen.queryByRole('button',{name:'Return for changes'})).not.toBeInTheDocument();expect(mutationRequests(fixture)).toHaveLength(0);
});

test('canonical aggregate confirmation names required accepted deliverables and binds only its Flow submission',async()=>{
 const flow=recordOf(fixture.records,'flow','flow-demo')!;flow.state='in-review';
 const intents=fixture.records.filter(record=>record.kind==='intent');for(const intent of intents){intent.state='accepted';intent.acceptanceDecisionId='accepted-'+intent.id;}
 fixture.records.push({kind:'flow-submission',id:'aggregate-submission',projectId:'p',createdBy:'human:reviewer',createdAt:'2026-11-03T08:00:00Z',flowId:flow.id,flowRevisionId:flow.approvedRevisionId!,acceptedIntents:intents.map(intent=>({intentId:intent.id,intentRevisionId:intent.approvedRevisionId!,decisionId:intent.acceptanceDecisionId!,submissionId:'accepted-submission-'+intent.id,subjectDigest:'a'.repeat(64)})),knowledgeProposalIds:[],contentDigest:'c'.repeat(64),criterionCoverage:[{flowCriterionId:'fc1',intentId:'i1',intentCriterionId:'ci1',submissionId:'accepted-submission-i1',decisionId:'accepted-i1'},{flowCriterionId:'fc2',intentId:'i2',intentCriterionId:'ci2',submissionId:'accepted-submission-i2',decisionId:'accepted-i2'}]});
 mountAcceptance('canonical',{location:{projectId:'p',tab:'work',flowId:'flow-demo'}});await screen.findByRole('heading',{name:'Decision'});
 const composition=screen.getByRole('list',{name:'Flow composition'});expect(within(composition).getByText('Navigation and focus')).toBeVisible();expect(within(composition).getByText('Integration verification')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Accept result'}));fireEvent.click(screen.getByRole('button',{name:'Confirm acceptance'}));
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));expect(mutationRequests(fixture)[0]!.body).toMatchObject({command:'review.decide',payload:{targetType:'flow-review',targetId:flow.id,submissionId:'aggregate-submission',submissionDigest:'c'.repeat(64),decision:'accept'}});
});

test('legacy decision success is announced and focused for keyboard reviewers',async()=>{
 fixture.respond=request=>{if(request.method==='POST'&&request.url.endsWith('/accept')){fixture.legacyFlow.status='done';fixture.legacyFlow.version=5;fixture.legacyFlow.acceptedBy='human:reviewer';return Response.json({...fixture.legacyFlow,receipt:{id:'accept-receipt',actorId:'human:reviewer',actorKind:'human',createdAt:'2026-11-03T08:10:00Z'}});}};
 mountAcceptance('legacy');const accept=await screen.findByRole('button',{name:'Accept result'});accept.focus();expect(accept).toHaveFocus();fireEvent.click(accept);
 const confirm=screen.getByRole('button',{name:'Confirm acceptance'});fireEvent.click(screen.getByRole('checkbox',{name:/self.reported|supplied reports/i}));confirm.focus();fireEvent.click(confirm);
 const status=await screen.findByRole('status');expect(status).toHaveTextContent(/accepted/i);expect(status).toHaveFocus();
});

test('legacy resubmission names the durable return decision and a new immutable result',async()=>{
 const decision=returnedDecision(fixture);fixture.legacyFlow.status='in-progress';fixture.legacyFlow.version=5;fixture.legacyFlow.subjectRevisionId=null;fixture.legacyFlow.lastReturnDecisionId=decision.id;fixture.legacyFlow.reviewFeedback=decision;
 fixture.respond=request=>request.method==='GET'&&request.url.includes('/revisions?summary=1')?Response.json({revisions:[{...fixture.legacyResult,id:'new-result',message:'Safari focus correction',fileCount:1}]}):undefined;
 mountAcceptance('legacy');expect(await screen.findByText(decision.comment)).toBeVisible();
 fireEvent.change(await screen.findByRole('combobox',{name:'Candidate revision'}),{target:{value:'new-result'}});fireEvent.click(screen.getByRole('button',{name:'Submit for review'}));
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));expect(mutationRequests(fixture)[0]!.body).toEqual({expectedVersion:5,subjectRevisionId:'new-result',afterReturnDecisionId:'return-1'});
 expect(fixture.legacyResult.id).toBe('legacy-result');expect(fixture.legacyEvidence[0]!.subjectRevisionId).toBe('legacy-result');
});

test('an existing human waiver stays visible as a reasoned decision rather than a passing check',async()=>{
 fixture.revision.criteria[0]!.waivable=true;fixture.submission.coverage[0]!.result='inconclusive';recordOf(fixture.records,'evidence','ev-agent')!.result='inconclusive';
 fixture.records.push({id:'human-waiver',kind:'decision',projectId:'p',createdBy:'human:reviewer',createdAt:'2026-11-03T08:00:00Z',targetType:'criterion-waiver',targetId:'ci1',targetDigest:fixture.submission.contentDigest,decision:'waive',reason:'Manual Safari validation recorded separately',actorKind:'human',operationId:'waiver-op',contentDigest:'d'.repeat(64)});
 mountAcceptance('canonical');await screen.findByRole('heading',{name:'Acceptance criteria',level:2});const row=screen.getByRole('group',{name:'Arrow keys and focus verified'});
 expect(within(row).getByText('Human waiver')).toBeVisible();expect(row).toHaveTextContent('Manual Safari validation recorded separately');expect(within(row).queryByText('Reported pass')).not.toBeInTheDocument();
});

test('submitted narrative never turns non-HTTP contributor links into active navigation',async()=>{
 fixture.subject.report='[Email instruction](mailto:owner@example.test) [Unsafe action](javascript:alert(1))';mountAcceptance('canonical');await screen.findByRole('heading',{name:'What was done'});
 expect(screen.queryByRole('link',{name:'Email instruction'})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:'Unsafe action'})).not.toBeInTheDocument();expect(mutationRequests(fixture)).toHaveLength(0);
});

test('a different Intent pending operation cannot be reconciled or announced from the current review pane',async()=>{
 const {pendingScope,writePending}=await import('../src/state/pending');const {validCommand}=await import('../src/features/managed-work/operation');
 writePending(pendingScope('work','human:reviewer','p','live'),{command:'review.decide',operationId:'different-intent-operation',expectedVersions:{'flow-demo':1,i2:1},payload:{targetType:'intent-review',targetId:'i2',submissionId:'other-submission',submissionDigest:'a'.repeat(64),decision:'accept',reason:'Original review',waivers:[]}},validCommand);
 mountAcceptance('canonical');await screen.findByRole('heading',{name:'Decision'});
 expect(screen.getByText(/another.*operation.*recovery|another.*operation.*reconciliation/i)).toBeVisible();expect(screen.queryByRole('button',{name:'Check decision status'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Retry identical decision'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Accept result'})).toBeDisabled();
});


test('canonical return for a nonpassing waivable criterion sends request changes without requiring a waiver',async()=>{
 const revision=recordOf(fixture.records,'intent-revision',fixture.submission.intentRevisionId)!;
 revision.criteria[0]!.waivable=true;
 recordOf(fixture.records,'evidence','ev-agent')!.result='inconclusive';
 fixture.submission.coverage[0]!.result='inconclusive';
 mountAcceptance('canonical');const comment=await openReturn();
 fireEvent.change(comment,{target:{value:'Please complete the Safari keyboard check'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Relate to: Arrow keys and focus verified'}));
 expect(screen.queryByRole('textbox',{name:/Waiver reason/})).not.toBeInTheDocument();
 confirmReturn();
 await waitFor(()=>expect(mutationRequests(fixture)).toHaveLength(1));
 expect(mutationRequests(fixture)[0]!.body).toMatchObject({command:'review.decide',payload:{decision:'request-changes',reason:'Please complete the Safari keyboard check\n\nCriteria: ci1',waivers:[]}});
 expect(await screen.findByText('Returned for changes',{selector:'[role=status]'})).toBeVisible();
 expect(screen.queryByRole('button',{name:'Check operation status'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Retry identical operation'})).not.toBeInTheDocument();
});


async function acceptLegacyFixtureResult(){
 fixture.respond=request=>{
  if(request.method==='POST'&&request.url.endsWith('/accept')){
   const accepted={...fixture.legacyFlow,status:'done',version:5,acceptedBy:'human:reviewer',acceptedAt:'2026-11-03T08:10:00Z',receipt:{id:'acceptance-receipt-immutable',actorId:'human:reviewer',actorKind:'human',createdAt:'2026-11-03T08:10:00Z'}};
   Object.assign(fixture.legacyFlow,accepted);return Response.json(accepted);
  }
 };
 mountAcceptance('legacy');fireEvent.click(await screen.findByRole('button',{name:'Accept result'}));
 fireEvent.click(screen.getByRole('checkbox',{name:/self.reported|supplied reports/i}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm acceptance'}));
 const status=await screen.findByText('Result accepted',{selector:'[role=status]'});
 await waitFor(()=>expect(screen.getByText(/Completed result.*read only/i)).toBeVisible());
 return status;
}

test('own legacy acceptance remains focused and read only after its version increment without a stale review action',async()=>{
 const status=await acceptLegacyFixtureResult();
 expect(status).toHaveFocus();
 expect(screen.queryByRole('button',{name:'Review updated result'})).not.toBeInTheDocument();
 expect(screen.queryByText(/The reviewed result changed/)).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Accept result'})).not.toBeInTheDocument();
 expect(mutationRequests(fixture)).toHaveLength(1);
});

test('accepted legacy receipt metadata stays inside a closed accessible technical disclosure',async()=>{
 await acceptLegacyFixtureResult();
 const receipt=screen.getByText('acceptance-receipt-immutable',{selector:'code'});
 const disclosure=receipt.closest('details');expect(disclosure).not.toBeNull();
 expect(disclosure).not.toHaveAttribute('open');expect(receipt).not.toBeVisible();
 const summary=within(disclosure!).getByText('Flow details',{selector:'summary'});
 summary.focus();expect(summary).toHaveFocus();fireEvent.click(summary);
 expect(receipt).toBeVisible();
});


test('own legacy return keeps focused feedback and a read only previous result until a new submission',async()=>{
 const decision=returnedDecision(fixture);
 fixture.respond=request=>{
  if(request.method==='POST'&&request.url.endsWith('/request-changes')){
   Object.assign(fixture.legacyFlow,{status:'in-progress',version:5,subjectRevisionId:null,lastReturnDecisionId:decision.id,reviewFeedback:decision});
   return Response.json({status:'committed',operationId:request.headers.get('Idempotency-Key'),flowVersion:5,flowState:'in-progress',decision});
  }
 };
 mountAcceptance('legacy');fireEvent.change(await openReturn(),{target:{value:decision.comment}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Relate to: Keyboard focus remains visible'}));confirmReturn();
 const status=await screen.findByText('Returned for changes',{selector:'[role=status]'});
 await waitFor(()=>expect(screen.getByText(decision.comment)).toBeVisible());
 expect(status).toHaveFocus();
 expect(screen.queryByRole('button',{name:'Review updated result'})).not.toBeInTheDocument();
 expect(screen.queryByText(/The reviewed result changed/)).not.toBeInTheDocument();
 expect(screen.getByText('Returned result — awaiting a new submission')).toBeVisible();
 expect(screen.queryByText('Completed result — read only')).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Accept result'})).not.toBeInTheDocument();
 expect(mutationRequests(fixture)).toHaveLength(1);
});
