import { LegacyAcceptance, LegacyReturnFeedback } from "./acceptance/legacy";
import { useRevisionPages, MoreRevisions } from "./revisions-query";
import {ManagedAttentionOverview} from "./managed-work/overview-attention";
import { ProjectOverview } from './project-overview';
export { GlobalFlowsView } from './global-flows';
import { FlowRows } from './global-flows';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getJson, postJson } from '../api/client';
import type { CodeRevisionSummary, Evidence, HubDocument, HubFlow, Project } from '../api/types';
import { useHub } from '../app/hub-context';
import { useDraft } from '../state/drafts';
import { Button, EmptyState, Field, Notice, PageHeading, Panel, StatusBadge } from '../components/ui';
import { formatDate } from '../i18n/format';

const inputClass = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-teal-600 focus:ring-2 focus:ring-teal-100 disabled:bg-slate-100';
const monoClass = 'break-all font-mono text-xs text-slate-600';
const flowStatuses: HubFlow['status'][] = ['initializing', 'ready', 'in-progress', 'implemented', 'completing', 'done'];
const statusKeys = { initializing: 'statusInitializing', ready: 'statusReady', 'in-progress': 'statusInProgress', implemented: 'statusImplemented', completing: 'statusCompleting', done: 'statusDone' } as const;
const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation('workflow');
  const detail = typeof error === 'object' && error !== null ? error as { status?: number; code?: string } : {};
  const message = detail.status === 409 ? t('conflict') : detail.status === 403 ? t('permissionError') : detail.status === undefined || detail.status === 0 || detail.status >= 500 ? t('networkError') : t('unknownError', { code: detail.code ?? detail.status });
  return <Notice tone="error"><span role="alert">{message}{detail.code && <span className="mt-1 block font-mono text-xs">{detail.code}</span>}</span></Notice>;
}
function QueryFeedback({ query }: { query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown } }) {
  const { t } = useTranslation('workflow');
  if (query.isPending) return <p role="status" className="py-6 text-sm text-slate-500">{t('loading')}</p>;
  if (query.isError) return <div className="space-y-3"><ErrorNotice error={query.error} /><Button variant="secondary" onClick={() => { void query.refetch(); }}>{t('retry')}</Button></div>;
  return null;
}
function Definition({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 space-y-1"><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt><dd className="min-w-0 text-sm text-slate-900">{children}</dd></div>;
}

// Mutation completion may outlive its view. Cache invalidation is safe, presentation is scoped.
function usePresentationGuard(key: string) {
  const current = useRef<string | null>(key);
  useEffect(() => { current.current = key; return () => { current.current = null; }; }, [key]);
  return () => current.current === key;
}

export function ProjectsView() {
  const hub = useHub(); const { t } = useTranslation('workflow'); const client = useQueryClient();
  const [draft, setDraft, clearDraft] = useDraft('create-project', { name: '' });
  const [validation, setValidation] = useState('');
  const [creating, setCreating] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [draftKept, setDraftKept] = useState(false);
  const isCurrent = usePresentationGuard(`${hub.scopeKey}:${hub.projectId}:${hub.location.tab}`);
  const projects = useQuery({ queryKey: [hub.scopeKey, 'projects'], queryFn: ({ signal }) => getJson<{ projects: Project[] }>('/projects', signal) });
  const create = useMutation({ mutationFn: (context: { isCurrent: () => boolean; draft: typeof draft }) => postJson<Project>('/projects', { name: context.draft.name.trim() }), onSuccess: (project, context) => {
    void client.invalidateQueries({ queryKey: [hub.scopeKey, 'projects'] }); const cleared = clearDraft(context.draft); if (!context.isCurrent()) return; setDraftKept(!cleared); if (!cleared) return; hub.navigate({ projectId: project.id, tab: 'overview' });
  } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.name.trim()) { setValidation(t('projectNameRequired')); nameInput.current?.focus(); return; } create.mutate({ isCurrent, draft: draft }); }
  return <div className="space-y-5">
    <PageHeading title={t('projectsTitle')} action={<Button variant={creating ? 'secondary' : 'primary'} aria-expanded={creating} onClick={() => setCreating(!creating)}>{t(creating ? 'cancel' : 'createProject')}</Button>} />
    <QueryFeedback query={projects} />
    {projects.data && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{projects.data.projects.map(project => <button key={project.id} type="button" onClick={() => hub.navigate({ projectId: project.id, tab: 'overview' })} className="hub-project-card">
      <span className="flex size-10 items-center justify-center rounded-xl bg-teal-50 text-lg font-semibold text-teal-800">{project.name.slice(0, 1).toUpperCase()}</span>
      <span className="min-w-0 break-words font-semibold">{project.name}</span><span aria-hidden="true">→</span>
    </button>)}</div>}
    {projects.data?.projects.length === 0 && <EmptyState>{t('noProjects')}</EmptyState>}
    {creating && <Panel title={t('createProject')}><form noValidate onSubmit={submit} className="max-w-xl space-y-3">
      <Field label={t('projectName')}><input ref={nameInput} className={inputClass} value={draft.name} onChange={event => { setValidation(''); setDraft({ name: event.target.value }); }} aria-invalid={!!validation} aria-errormessage={validation ? errorId : undefined} maxLength={200} required /></Field>
      {validation && <p id={errorId} role="alert" className="text-sm text-red-700">{validation}</p>}
      {draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{create.isError && <ErrorNotice error={create.error} />}
      <Button type="submit" disabled={create.isPending}>{create.isPending ? t('loading') : t('createProject')}</Button>
    </form></Panel>}
    {projects.data && <ManagedAttentionOverview projects={projects.data.projects}/>}
  </div>;
}

export function OverviewView() {
 const hub = useHub();
 return hub.projectId ? <ProjectOverview key={hub.scopeKey + ':' + hub.projectId} /> : <ProjectsView />;
}
export function FlowsView() {
  const hub = useHub(); const { t } = useTranslation('workflow');
  if (!hub.projectId) return <ProjectsView />;
  return <FlowsProject key={`${hub.scopeKey}:${hub.projectId}`} projectId={hub.projectId} title={t('boardTitle')} />;
}

function FlowsProject({ projectId, title }: { projectId: string; title: string }) {
  const hub = useHub(); const { t } = useTranslation('workflow'); const client = useQueryClient(); const prefix = projectPath(projectId);
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [lane, setLane] = useState<HubFlow['status']>('initializing');
  const board = useRef<HTMLDivElement>(null);
  const returnCard = useRef<string | null>(null);
  const selected = hub.location.flowId;
  useLayoutEffect(() => {
    if (selected || !returnCard.current) return;
    const card = board.current?.querySelector<HTMLButtonElement>(`[data-board-flow="${CSS.escape(returnCard.current)}"]`);
    card?.focus();
    returnCard.current = null;
  }, [selected]);
  const [creating, setCreating] = useState(false); const [search, setSearch] = useState(''); const [validation, setValidation] = useState('');
  const [draftKept, setDraftKept] = useState(false);
  const [draft, setDraft, clearDraft] = useDraft(`create-flow:${projectId}`, { title: '', specDocumentId: '', criteria: '' });
  const flows = useQuery({ queryKey: [hub.scopeKey, projectId, 'flows'], queryFn: ({ signal }) => getJson<{ flows: HubFlow[] }>(`${prefix}/flows`, signal) });
  const documents = useQuery({ queryKey: [hub.scopeKey, projectId, 'documents'], queryFn: ({ signal }) => getJson<{ documents: HubDocument[] }>(`${prefix}/documents`, signal) });
  const isCurrent = usePresentationGuard(`${hub.scopeKey}:${projectId}:${hub.location.tab}:${hub.location.flowId ?? ''}`);
  const specs = documents.data?.documents.filter(doc => doc.kind === 'spec') ?? [];
  const create = useMutation({ mutationFn: (context: { isCurrent: () => boolean; draft: typeof draft }) => postJson<HubFlow>(`${prefix}/flows`, { title: context.draft.title.trim(), specDocumentId: context.draft.specDocumentId, criteria: context.draft.criteria.split('\n').map(line => line.trim()).filter(Boolean) }), onSuccess: (flow, context) => {
    void client.invalidateQueries({ queryKey: [hub.scopeKey, projectId, 'flows'] }); const cleared = clearDraft(context.draft); if (!context.isCurrent()) return; setDraftKept(!cleared); if (!cleared) return; setCreating(false); hub.navigate({ tab: 'flows', flowId: flow.id });
  } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.title.trim() || !specs.some(spec => spec.id === draft.specDocumentId) || !draft.criteria.trim()) { setValidation(t('required')); return; } create.mutate({ isCurrent, draft: draft }); }
  if (selected) return <FlowDetail key={`${projectId}:${selected}`} projectId={projectId} flowId={selected} documents={documents.data?.documents ?? []} />;
  const filtered = flows.data?.flows.filter(flow => `${flow.title} ${flow.specContentDigest}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  return <div className="space-y-6"><PageHeading title={title} description={t('boardDescription')} action={<Button variant={creating ? 'secondary' : 'primary'} onClick={() => setCreating(!creating)}>{creating ? t('cancel') : t('createFlow')}</Button>} />
    <Notice>
      <p>{t('flowWorkspaceDistinction')}</p>
      <Button variant="secondary" className="mt-2" onClick={() => hub.navigate({tab:'work',flowId:undefined,intentId:undefined,attemptId:undefined})}>{t('openManagedWork')}</Button>
    </Notice>
    {creating && <Panel title={t('createFlow')}><form noValidate onSubmit={submit} className="grid gap-5 lg:grid-cols-2">
      <Field label={t('flowTitle')}><input className={inputClass} value={draft.title} onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} placeholder={t('flowTitlePlaceholder')} maxLength={500} required /></Field>
      <Field label={t('specification')}><select className={inputClass} value={draft.specDocumentId} onChange={event => setDraft(old => ({ ...old, specDocumentId: event.target.value }))} required><option value="">{t('chooseSpecification')}</option>{specs.map(spec => <option key={spec.id} value={spec.id}>{spec.path}</option>)}</select></Field>
      {draft.specDocumentId && <p className="break-all text-sm text-teal-800 lg:col-span-2">{t('selectedSpecification')}: <strong>{specs.find(spec => spec.id === draft.specDocumentId)?.path ?? t('specificationMissing')}</strong></p>}
      <div className="lg:col-span-2"><Field label={t('acceptanceCriteria')} hint={t('criteriaHint')}><textarea className={inputClass} value={draft.criteria} onChange={event => setDraft(old => ({ ...old, criteria: event.target.value }))} rows={5} required /></Field></div>
      {specs.length === 0 && !documents.isPending && <Notice tone="info">{t('noSpecifications')}</Notice>}
      <div className="space-y-3 lg:col-span-2">{draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{create.isError && <ErrorNotice error={create.error} />}<Button type="submit" disabled={create.isPending || specs.length === 0}>{create.isPending ? t('loading') : t('createFlow')}</Button></div>
    </form></Panel>}
    <QueryFeedback query={flows} /><QueryFeedback query={documents} />
    {flows.data && <>
      <div className="flow-list-toolbar">
        <Field label={t('searchFlows')}><input className={inputClass} type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label={t('flowSearchLabel')} /></Field>
        <div className="flex gap-2" role="group" aria-label={t('boardLabel')}><Button variant={layout === 'list' ? 'primary' : 'secondary'} aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>{t('listView')}</Button><Button variant={layout === 'board' ? 'primary' : 'secondary'} aria-pressed={layout === 'board'} onClick={() => setLayout('board')}>{t('boardView')}</Button></div>
      </div>
      {flows.data.flows.length === 0 && <EmptyState>{t('noFlows')}</EmptyState>}
      {layout === 'list' ? <FlowRows rows={filtered.map(flow => ({ flow }))} /> : <>
        <div className="flow-lane-picker" role="group" aria-label={t('flowState')}>
          {flowStatuses.map(status => <Button key={status} variant={lane === status ? 'primary' : 'secondary'} aria-pressed={lane === status} onClick={() => setLane(status)}>
            {t(statusKeys[status])} · {filtered.filter(flow => flow.status === status).length}
          </Button>)}
        </div>
        <div ref={board} className="flow-board-grid" aria-label={t('boardLabel')}>
          {flowStatuses.map(status => {
            const cards = filtered.filter(flow => flow.status === status);
            return <section key={status} data-lane-visible={lane === status}>
              <h2>{t(statusKeys[status])} <span>{cards.length}</span></h2>
              {cards.map(flow => <button key={flow.id} data-board-flow={flow.id} type="button" aria-label={t('openFlow', { title: flow.title })} onClick={() => {
                returnCard.current = flow.id;
                setLane(status);
                hub.navigate({ tab: 'flows', flowId: flow.id });
              }}>
                <strong>{flow.title}</strong>
                <small>{t('criteriaCount', { count: flow.criteria.length })} · v{flow.version}</small>
              </button>)}
              {!cards.length && <p>{t('noLaneItems')}</p>}
            </section>;
          })}
        </div>
      </>}
    </>}
  </div>;
}

function FlowDetail({ projectId, flowId, documents }: { projectId: string; flowId: string; documents: HubDocument[] }) {
  const hub = useHub(); const { t, i18n } = useTranslation('workflow'); const client = useQueryClient(); const prefix = `${projectPath(projectId)}/flows/${encodeURIComponent(flowId)}`;
  const [notice, setNotice] = useState('');
  const flow = useQuery({ queryKey: [hub.scopeKey, projectId, 'flow', flowId], queryFn: ({ signal }) => getJson<HubFlow>(prefix, signal) });
  const evidence = useQuery({ queryKey: [hub.scopeKey, projectId, 'flow', flowId, 'evidence'], queryFn: ({ signal }) => getJson<{ evidence: Evidence[] }>(`${prefix}/evidence`, signal) });
  function changed() { setNotice(t('actionSaved')); void client.invalidateQueries({ queryKey: [hub.scopeKey, projectId, 'flows'] }); void client.invalidateQueries({ queryKey: [hub.scopeKey, projectId, 'flow', flowId] }); }
  const action = useMutation({ mutationFn: ({ action: name, version }: { action: string; version: number }) => postJson<HubFlow>(`${prefix}/${name}`, { expectedVersion: version }), onSuccess: changed });
  const record = flow.data; const spec = documents.find(doc => doc.id === record?.specDocumentId);
  const reviewing=record?.status==='implemented'||record?.status==='done'||!!record?.reviewFeedback;
  return <div className="space-y-6"><Button variant="ghost" onClick={() => hub.navigate({ flowId: undefined })}>← {t('backToBoard')}</Button><QueryFeedback query={flow} />
    {record && <><PageHeading title={record.title} description={`${t('version')} ${record.version}`} action={<StatusBadge status={record.status} />} />
      {notice && <Notice tone="success">{notice}</Notice>}{action.isError && <ErrorNotice error={action.error} />}
      {record.reviewFeedback&&<LegacyReturnFeedback flow={record}/>}
      {reviewing&&<LegacyAcceptance flow={record} evidence={evidence.data?.evidence??[]} evidenceQuery={evidence} refresh={()=>{void client.invalidateQueries({queryKey:[hub.scopeKey,projectId,"flows"]});void client.invalidateQueries({queryKey:[hub.scopeKey,projectId,"flow",flowId]});}}/>}
      <details open={!reviewing}><summary>{t('flowDetails')}</summary>
      <Panel title={t('flowDetails')}><dl className="grid min-w-0 gap-5 lg:grid-cols-2"><Definition label={t('specificationPath')}><span className={monoClass}>{spec?.path ?? t('specificationMissing')}</span>{spec && <div className="mt-2"><Button variant="ghost" onClick={() => hub.navigate({ tab: 'documents', documentId: spec.id })}>{t('readSpecification')}</Button></div>}</Definition><Definition label={t('pinnedDigest')}><code className={monoClass}>{record.specContentDigest}</code></Definition><Definition label={t('subjectRevision')}><code className={monoClass}>{record.subjectRevisionId ?? t('noSubject')}</code></Definition>{spec && <Definition label={t('specificationVersion')}>{spec.version}</Definition>}</dl>
        {spec && spec.contentDigest !== record.specContentDigest && <div className="mt-5"><Notice tone="error">{t('digestChanged')}</Notice></div>}
      </Panel>
      {record.acceptedBy && <Panel><dl className="grid gap-4 lg:grid-cols-3"><Definition label={t('acceptedBy')}>{record.acceptedBy}</Definition><Definition label={t('acceptedAt')}>{record.acceptedAt ? formatDate(record.acceptedAt, i18n.language) : '—'}</Definition><Definition label={t('receipt')}><code className={monoClass}>{record.receipt?.id ?? '—'}</code></Definition></dl></Panel>}
      </details>
      {!reviewing&&<Panel title={t('acceptanceCriteria')}><ol className="list-decimal space-y-4 pl-5 text-sm leading-7 text-slate-700">{record.criteria.map((criterion, index) => <li key={index} className="break-words pl-1">{criterion}</li>)}</ol>{record.status !== 'initializing' && <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">{t('frozenReadOnly')}</p>}</Panel>}
      {record.status === 'initializing' && <Panel description={t('freezeHint')}>{hub.principal.kind === 'human' ? <Button disabled={action.isPending} onClick={() => action.mutate({ action: 'freeze', version: record.version })}>{t('freezeCriteria')}</Button> : <Notice tone="info">{t('humanOnly')}</Notice>}</Panel>}
      {record.status === 'ready' && <Panel description={t('startHint')}><Button disabled={action.isPending} onClick={() => action.mutate({ action: 'start', version: record.version })}>{t('startWork')}</Button></Panel>}
      {record.status === 'in-progress' && hub.principal.kind==='human' && hub.principal.role==='operator' && <Panel><Button onClick={()=>hub.navigate({tab:'sessions',flowId:record.id,sessionId:undefined,runId:undefined})}>{t('remote:startFromFlow')}</Button><p className="mt-3 text-sm text-slate-500">{t('remote:launchHint')}</p></Panel>}
      {record.status === 'in-progress' && <SubmitCandidate flow={record} projectId={projectId} onSaved={changed} />}
      {!reviewing&&<Panel title={t('evidenceTitle')} description={t('evidenceDescription')}><QueryFeedback query={evidence} />{evidence.data?.evidence.length === 0 && <EmptyState>{t('noEvidence')}</EmptyState>}<div className="space-y-3">{evidence.data?.evidence.map(report => <details key={report.id} className="min-w-0 overflow-hidden rounded-xl border border-slate-200"><summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-900 focus-visible:outline-2 focus-visible:outline-teal-600"><span className="break-words">{report.checkId}</span><span className={`ml-3 inline-flex rounded-full px-2 py-0.5 text-xs ${report.exitCode === 0 ? 'bg-teal-50 text-teal-800' : 'bg-rose-50 text-rose-800'}`}>{t('exitCode')}: {report.exitCode}</span></summary><div className="min-w-0 space-y-5 border-t border-slate-100 p-4"><p className="text-xs font-medium text-amber-800">{t('selfReported')}</p><dl className="grid min-w-0 gap-4 lg:grid-cols-2"><Definition label={t('subjectRevision')}><code className={monoClass}>{report.subjectRevisionId}</code></Definition><Definition label={t('reportedBy')}>{report.actorId}</Definition><Definition label={t('reportedAt')}>{formatDate(report.createdAt, i18n.language)}</Definition></dl><div><h3 className="mb-2 text-xs font-medium text-slate-500">{t('command')}</h3><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100">{report.command}</pre></div><div><h3 className="mb-2 text-xs font-medium text-slate-500">{t('output')}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-4 text-xs leading-6 text-slate-700">{report.output || '—'}</pre></div></div></details>)}</div></Panel>}
      {record.status === 'in-progress' && <AddEvidence flow={record} projectId={projectId} onSaved={changed} />}
    </>}
  </div>;
}

function RevisionOptions({ revisions }: { revisions: CodeRevisionSummary[] }) {
  const { t } = useTranslation('workflow');
  return <>{revisions.map(revision => <option key={revision.id} value={revision.id}>{revision.message} · {revision.id.slice(0, 12)}{revision.purpose === 'review-bundle' ? ` · ${t('reviewBundle')}` : ''}</option>)}</>;
}
function SubmitCandidate({ flow, projectId, onSaved }: { flow: HubFlow; projectId: string; onSaved: () => void }) {
  const { t } = useTranslation('workflow'); const revisions = useRevisionPages(projectId);
  const [draft, setDraft, clearDraft] = useDraft(`submit-flow:${projectId}:${flow.id}`, { subjectRevisionId: '', expectedVersion: flow.version });
  const [validation, setValidation] = useState('');
  const [draftKept, setDraftKept] = useState(false);
  const mutation = useMutation({ mutationFn: (submitted: typeof draft) => postJson<HubFlow>(`${projectPath(projectId)}/flows/${encodeURIComponent(flow.id)}/submit-for-review`, { expectedVersion: submitted.expectedVersion, subjectRevisionId: submitted.subjectRevisionId, ...(flow.reviewFeedback&&flow.lastReturnDecisionId?{afterReturnDecisionId:flow.lastReturnDecisionId}:{}) }), onSuccess: (_result, submitted) => { setDraftKept(!clearDraft(submitted)); onSaved(); } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.subjectRevisionId || !revisions.data?.revisions.some(revision => revision.id === draft.subjectRevisionId)) { setValidation(t('required')); return; } mutation.mutate(draft); }
  return <Panel title={t('submitTitle')} description={t('submitHint')}><form noValidate onSubmit={submit} className="space-y-4"><QueryFeedback query={revisions} /><MoreRevisions query={revisions} /><Field label={t('candidateRevision')}><select className={inputClass} value={draft.subjectRevisionId} onChange={event => setDraft(old => ({ ...old, subjectRevisionId: event.target.value }))} required><option value="">{t('chooseRevision')}</option><RevisionOptions revisions={revisions.data?.revisions ?? []} /></select></Field><p className="text-xs text-slate-500">{t('preparedVersion', { version: draft.expectedVersion })}</p>
    {draft.expectedVersion !== flow.version && <Notice tone="info"><p>{t('latestVersion', { version: flow.version })}</p><Button type="button" variant="ghost" onClick={() => setDraft(old => ({ ...old, expectedVersion: flow.version }))}>{t('reloadVersion')}</Button></Notice>}
    {draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{mutation.isError && <ErrorNotice error={mutation.error} />}<Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? t('loading') : t('submitForReview')}</Button></form></Panel>;
}
function AddEvidence({ flow, projectId, onSaved }: { flow: HubFlow; projectId: string; onSaved: () => void }) {
  const { t } = useTranslation('workflow'); const revisions = useRevisionPages(projectId); const [open, setOpen] = useState(false); const [validation, setValidation] = useState('');
  const [draftKept, setDraftKept] = useState(false);
  const [draft, setDraft, clearDraft] = useDraft(`evidence:${projectId}:${flow.id}`, { subjectRevisionId: '', checkId: '', command: '', exitCode: '0', output: '' });
  const create = useMutation({ mutationFn: (submitted: typeof draft) => postJson<Evidence>(`${projectPath(projectId)}/flows/${encodeURIComponent(flow.id)}/evidence`, { subjectRevisionId: submitted.subjectRevisionId, checkId: submitted.checkId.trim(), command: submitted.command, exitCode: Number(submitted.exitCode), output: submitted.output }), onSuccess: (_result, submitted) => { const cleared = clearDraft(submitted); setDraftKept(!cleared); if (cleared) setOpen(false); onSaved(); } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.subjectRevisionId || !draft.checkId.trim() || !draft.command.trim() || draft.exitCode.trim() === '') { setValidation(t('required')); return; } if (!Number.isSafeInteger(Number(draft.exitCode)) || Number(draft.exitCode) < 0) { setValidation(t('invalidExit')); return; } create.mutate(draft); }
  return <Panel><Button variant="secondary" onClick={() => setOpen(!open)}>{open ? t('cancel') : t('addEvidence')}</Button>{open && <form noValidate onSubmit={submit} className="mt-6 grid gap-5 lg:grid-cols-2"><div className="lg:col-span-2"><QueryFeedback query={revisions} /><MoreRevisions query={revisions} /><Field label={t('evidenceSubject')}><select className={inputClass} value={draft.subjectRevisionId} onChange={event => setDraft(old => ({ ...old, subjectRevisionId: event.target.value }))} required><option value="">{t('chooseRevision')}</option><RevisionOptions revisions={revisions.data?.revisions ?? []} /></select></Field></div><Field label={t('checkId')}><input className={inputClass} value={draft.checkId} maxLength={200} onChange={event => setDraft(old => ({ ...old, checkId: event.target.value }))} required /></Field><Field label={t('exitCode')}><input className={inputClass} type="number" min="0" step="1" value={draft.exitCode} onChange={event => setDraft(old => ({ ...old, exitCode: event.target.value }))} required /></Field><div className="lg:col-span-2"><Field label={t('command')}><input className={inputClass} value={draft.command} onChange={event => setDraft(old => ({ ...old, command: event.target.value }))} required /></Field></div><div className="lg:col-span-2"><Field label={t('output')}><textarea className={`${inputClass} font-mono`} rows={6} value={draft.output} onChange={event => setDraft(old => ({ ...old, output: event.target.value }))} /></Field></div><div className="space-y-3 lg:col-span-2">{draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{create.isError && <ErrorNotice error={create.error} />}<Button type="submit" disabled={create.isPending}>{create.isPending ? t('loading') : t('save')}</Button></div></form>}</Panel>;
}
