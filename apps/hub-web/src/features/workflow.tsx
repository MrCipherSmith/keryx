import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getJson, postJson } from '../api/client';
import type { CodeRevisionSummary, Evidence, HubDocument, HubFlow, Project, Proposal } from '../api/types';
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
  const [draftKept, setDraftKept] = useState(false);
  const isCurrent = usePresentationGuard(`${hub.scopeKey}:${hub.projectId}:${hub.location.tab}`);
  const projects = useQuery({ queryKey: [hub.scopeKey, 'projects'], queryFn: ({ signal }) => getJson<{ projects: Project[] }>('/projects', signal) });
  const create = useMutation({ mutationFn: (context: { isCurrent: () => boolean; draft: typeof draft }) => postJson<Project>('/projects', { name: context.draft.name.trim() }), onSuccess: (project, context) => {
    void client.invalidateQueries({ queryKey: [hub.scopeKey, 'projects'] }); const cleared = clearDraft(context.draft); if (!context.isCurrent()) return; setDraftKept(!cleared); if (!cleared) return; hub.navigate({ projectId: project.id, tab: 'overview' });
  } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.name.trim()) { setValidation(t('required')); return; } create.mutate({ isCurrent, draft: draft }); }
  return <div className="space-y-8">
    <PageHeading title={t('projectsTitle')} description={t('projectsDescription')} />
    <QueryFeedback query={projects} />
    {projects.data && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{projects.data.projects.map(project => <button key={project.id} type="button" onClick={() => hub.navigate({ projectId: project.id, tab: 'overview' })} className="group min-w-0 rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-teal-400 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600">
      <span className="mb-5 flex size-11 items-center justify-center rounded-xl bg-teal-50 text-lg font-semibold text-teal-800">{project.name.slice(0, 1).toUpperCase()}</span>
      <span className="block break-words text-lg font-semibold text-slate-950">{project.name}</span><span className="mt-2 block text-sm text-slate-500">{t('openProject')} <span aria-hidden="true">→</span></span>
    </button>)}</div>}
    {projects.data?.projects.length === 0 && <EmptyState>{t('noProjects')}</EmptyState>}
    <Panel title={t('createProject')}><form noValidate onSubmit={submit} className="max-w-xl space-y-4">
      <Field label={t('projectName')}><input className={inputClass} value={draft.name} onChange={event => setDraft({ name: event.target.value })} placeholder={t('projectNamePlaceholder')} maxLength={200} required /></Field>
      {draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{create.isError && <ErrorNotice error={create.error} />}
      <Button type="submit" disabled={create.isPending}>{create.isPending ? t('loading') : t('createProject')}</Button>
    </form></Panel>
  </div>;
}

export function OverviewView() {
  const hub = useHub(); const { t } = useTranslation('workflow'); const prefix = hub.projectId ? projectPath(hub.projectId) : null;
  const overview = useQuery({ queryKey: [hub.scopeKey, hub.projectId, 'overview'], enabled: !!prefix, queryFn: async ({ signal }) => {
    const [project, documents, flows, proposals, revisions] = await Promise.all([
      getJson<Project>(prefix!, signal), getJson<{ documents: HubDocument[] }>(`${prefix}/documents`, signal), getJson<{ flows: HubFlow[] }>(`${prefix}/flows`, signal), getJson<{ proposals: Proposal[] }>(`${prefix}/proposals`, signal), getJson<{ revisions: CodeRevisionSummary[] }>(`${prefix}/revisions?summary=1`, signal),
    ]);
    return { project, counts: [documents.documents.length, flows.flows.filter(flow => flow.status !== 'done').length, proposals.proposals.filter(proposal => proposal.status === 'pending').length, revisions.revisions.length] };
  } });
  if (!hub.projectId) return <ProjectsView />;
  const cards = [{ label: t('documents'), tab: 'documents' }, { label: t('activeFlows'), tab: 'flows' }, { label: t('pendingProposals'), tab: 'proposals' }, { label: t('revisions'), tab: 'code' }] as const;
  return <div className="space-y-6"><PageHeading title={overview.data?.project.name ?? t('overviewTitle')} description={t('overviewDescription')} /><QueryFeedback query={overview} />
    {overview.data && <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{cards.map((card, index) => <button type="button" key={card.tab} onClick={() => hub.navigate({ tab: card.tab })} aria-label={t('openSection', { section: card.label })} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-teal-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"><span className="block text-sm text-slate-500">{card.label}</span><span className="mt-3 block text-3xl font-semibold tracking-tight text-slate-950">{overview.data.counts[index]}</span></button>)}</div>
      <div className="grid gap-6 xl:grid-cols-2"><Panel title={t('integrationTitle')} description={t('integrationDescription')}><dl className="space-y-5"><Definition label={t('subjectRevision')}><span className={monoClass}>{overview.data.project.lineRevisionId ?? t('noSelectedRevision')}</span></Definition><Definition label={t('lineVersion')}>{overview.data.project.lineVersion}</Definition></dl></Panel><Panel title={t('approvalTitle')}><p className="text-sm leading-7 text-slate-600">{t('approvalDescription')}</p><p className="mt-4 text-sm leading-6 text-slate-500">{t('localEnvironment')}</p></Panel></div>
      <Panel title={t('nextTitle')} description={t('nextDescription')}><div className="flex flex-wrap gap-3"><Button onClick={() => hub.navigate({ tab: 'documents' })}>{t('nextDocuments')}</Button><Button variant="secondary" onClick={() => hub.navigate({ tab: 'flows' })}>{t('nextFlows')}</Button><Button variant="secondary" onClick={() => hub.navigate({ tab: 'proposals' })}>{t('nextProposals')}</Button></div></Panel>
    </>}
  </div>;
}

export function FlowsView() {
  const hub = useHub(); const { t } = useTranslation('workflow');
  if (!hub.projectId) return <ProjectsView />;
  return <FlowsProject key={`${hub.scopeKey}:${hub.projectId}`} projectId={hub.projectId} title={t('boardTitle')} />;
}

function FlowsProject({ projectId, title }: { projectId: string; title: string }) {
  const hub = useHub(); const { t } = useTranslation('workflow'); const client = useQueryClient(); const prefix = projectPath(projectId);
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
  const selected = hub.location.flowId;
  if (selected) return <FlowDetail key={`${projectId}:${selected}`} projectId={projectId} flowId={selected} documents={documents.data?.documents ?? []} />;
  const filtered = flows.data?.flows.filter(flow => `${flow.title} ${flow.specContentDigest}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  return <div className="space-y-6"><PageHeading title={title} description={t('boardDescription')} action={<Button variant={creating ? 'secondary' : 'primary'} onClick={() => setCreating(!creating)}>{creating ? t('cancel') : t('createFlow')}</Button>} />
    {creating && <Panel title={t('createFlow')}><form noValidate onSubmit={submit} className="grid gap-5 lg:grid-cols-2">
      <Field label={t('flowTitle')}><input className={inputClass} value={draft.title} onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} placeholder={t('flowTitlePlaceholder')} maxLength={500} required /></Field>
      <Field label={t('specification')}><select className={inputClass} value={draft.specDocumentId} onChange={event => setDraft(old => ({ ...old, specDocumentId: event.target.value }))} required><option value="">{t('chooseSpecification')}</option>{specs.map(spec => <option key={spec.id} value={spec.id}>{spec.path}</option>)}</select></Field>
      {draft.specDocumentId && <p className="break-all text-sm text-teal-800 lg:col-span-2">{t('selectedSpecification')}: <strong>{specs.find(spec => spec.id === draft.specDocumentId)?.path ?? t('specificationMissing')}</strong></p>}
      <div className="lg:col-span-2"><Field label={t('acceptanceCriteria')} hint={t('criteriaHint')}><textarea className={inputClass} value={draft.criteria} onChange={event => setDraft(old => ({ ...old, criteria: event.target.value }))} rows={5} required /></Field></div>
      {specs.length === 0 && !documents.isPending && <Notice tone="info">{t('noSpecifications')}</Notice>}
      <div className="space-y-3 lg:col-span-2">{draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{create.isError && <ErrorNotice error={create.error} />}<Button type="submit" disabled={create.isPending || specs.length === 0}>{create.isPending ? t('loading') : t('createFlow')}</Button></div>
    </form></Panel>}
    <QueryFeedback query={flows} /><QueryFeedback query={documents} />
    {flows.data && <><Field label={t('searchFlows')}><input className={inputClass} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('searchFlowsPlaceholder')} aria-label={t('flowSearchLabel')} /></Field>
      {flows.data.flows.length === 0 && <EmptyState>{t('noFlows')}</EmptyState>}
      <div className="min-w-0 overflow-x-auto pb-3" aria-label={t('boardLabel')}><div className="grid min-w-[1320px] grid-cols-6 gap-3">{flowStatuses.map(status => <section key={status} className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/80 p-3"><div className="mb-3 flex items-center justify-between gap-2 px-1"><h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{t(statusKeys[status])}</h2><span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-slate-500">{filtered.filter(flow => flow.status === status).length}</span></div><div className="space-y-3">{filtered.filter(flow => flow.status === status).map(flow => <button key={flow.id} type="button" aria-label={t('openFlow', { title: flow.title })} onClick={() => hub.navigate({ tab: 'flows', flowId: flow.id })} className="block w-full min-w-0 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-teal-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"><span className="block break-words text-sm font-semibold leading-6 text-slate-900">{flow.title}</span><span className="mt-4 block font-mono text-[11px] text-slate-400">{flow.specContentDigest.slice(0, 12)}</span><span className="mt-2 block text-xs text-slate-500">{t('criteriaCount', { count: flow.criteria.length })} · v{flow.version}</span></button>)}{filtered.every(flow => flow.status !== status) && <p className="px-1 py-4 text-xs text-slate-400">{t('noLaneItems')}</p>}</div></section>)}</div></div>
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
  return <div className="space-y-6"><Button variant="ghost" onClick={() => hub.navigate({ flowId: undefined })}>← {t('backToBoard')}</Button><QueryFeedback query={flow} />
    {record && <><PageHeading title={record.title} description={`${t('version')} ${record.version}`} action={<StatusBadge status={record.status} />} />
      {notice && <Notice tone="success">{notice}</Notice>}{action.isError && <ErrorNotice error={action.error} />}
      <Panel title={t('flowDetails')}><dl className="grid min-w-0 gap-5 lg:grid-cols-2"><Definition label={t('specificationPath')}><span className={monoClass}>{spec?.path ?? t('specificationMissing')}</span>{spec && <div className="mt-2"><Button variant="ghost" onClick={() => hub.navigate({ tab: 'documents', documentId: spec.id })}>{t('readSpecification')}</Button></div>}</Definition><Definition label={t('pinnedDigest')}><code className={monoClass}>{record.specContentDigest}</code></Definition><Definition label={t('subjectRevision')}><code className={monoClass}>{record.subjectRevisionId ?? t('noSubject')}</code></Definition>{spec && <Definition label={t('specificationVersion')}>{spec.version}</Definition>}</dl>
        {spec && spec.contentDigest !== record.specContentDigest && <div className="mt-5"><Notice tone="error">{t('digestChanged')}</Notice></div>}
      </Panel>
      <Panel title={t('acceptanceCriteria')}><ol className="list-decimal space-y-4 pl-5 text-sm leading-7 text-slate-700">{record.criteria.map((criterion, index) => <li key={index} className="break-words pl-1">{criterion}</li>)}</ol>{record.status !== 'initializing' && <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">{t('frozenReadOnly')}</p>}</Panel>
      {record.status === 'initializing' && <Panel description={t('freezeHint')}>{hub.principal.kind === 'human' ? <Button disabled={action.isPending} onClick={() => action.mutate({ action: 'freeze', version: record.version })}>{t('freezeCriteria')}</Button> : <Notice tone="info">{t('humanOnly')}</Notice>}</Panel>}
      {record.status === 'ready' && <Panel description={t('startHint')}><Button disabled={action.isPending} onClick={() => action.mutate({ action: 'start', version: record.version })}>{t('startWork')}</Button></Panel>}
      {record.status === 'in-progress' && hub.principal.kind==='human' && hub.principal.role==='operator' && <Panel><Button onClick={()=>hub.navigate({tab:'sessions',flowId:record.id,sessionId:undefined,runId:undefined})}>{t('remote:startFromFlow')}</Button><p className="mt-3 text-sm text-slate-500">{t('remote:launchHint')}</p></Panel>}
      {record.status === 'in-progress' && <SubmitCandidate flow={record} projectId={projectId} onSaved={changed} />}
      {record.status === 'implemented' && <AcceptCandidate key={`${record.id}:${record.subjectRevisionId}:${record.version}`} flow={record} projectId={projectId} onSaved={changed} />}
      {record.acceptedBy && <Panel><dl className="grid gap-4 lg:grid-cols-3"><Definition label={t('acceptedBy')}>{record.acceptedBy}</Definition><Definition label={t('acceptedAt')}>{record.acceptedAt ? formatDate(record.acceptedAt, i18n.language) : '—'}</Definition><Definition label={t('receipt')}><code className={monoClass}>{record.receipt?.id ?? '—'}</code></Definition></dl></Panel>}
      <Panel title={t('evidenceTitle')} description={t('evidenceDescription')}><QueryFeedback query={evidence} />{evidence.data?.evidence.length === 0 && <EmptyState>{t('noEvidence')}</EmptyState>}<div className="space-y-3">{evidence.data?.evidence.map(report => <details key={report.id} className="min-w-0 overflow-hidden rounded-xl border border-slate-200"><summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-900 focus-visible:outline-2 focus-visible:outline-teal-600"><span className="break-words">{report.checkId}</span><span className={`ml-3 inline-flex rounded-full px-2 py-0.5 text-xs ${report.exitCode === 0 ? 'bg-teal-50 text-teal-800' : 'bg-rose-50 text-rose-800'}`}>{t('exitCode')}: {report.exitCode}</span></summary><div className="min-w-0 space-y-5 border-t border-slate-100 p-4"><p className="text-xs font-medium text-amber-800">{t('selfReported')}</p><dl className="grid min-w-0 gap-4 lg:grid-cols-2"><Definition label={t('subjectRevision')}><code className={monoClass}>{report.subjectRevisionId}</code></Definition><Definition label={t('reportedBy')}>{report.actorId}</Definition><Definition label={t('reportedAt')}>{formatDate(report.createdAt, i18n.language)}</Definition></dl><div><h3 className="mb-2 text-xs font-medium text-slate-500">{t('command')}</h3><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100">{report.command}</pre></div><div><h3 className="mb-2 text-xs font-medium text-slate-500">{t('output')}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-4 text-xs leading-6 text-slate-700">{report.output || '—'}</pre></div></div></details>)}</div></Panel>
      {record.status === 'in-progress' && <AddEvidence flow={record} projectId={projectId} onSaved={changed} />}
    </>}
  </div>;
}

function useRevisions(projectId: string) {
  const hub = useHub();
  return useQuery({ queryKey: [hub.scopeKey, projectId, 'revisions'], queryFn: ({ signal }) => getJson<{ revisions: CodeRevisionSummary[] }>(`${projectPath(projectId)}/revisions?summary=1`, signal) });
}
function RevisionOptions({ revisions }: { revisions: CodeRevisionSummary[] }) {
  const { t } = useTranslation('workflow');
  return <>{revisions.map(revision => <option key={revision.id} value={revision.id}>{revision.message} · {revision.id.slice(0, 12)}{revision.purpose === 'review-bundle' ? ` · ${t('reviewBundle')}` : ''}</option>)}</>;
}
function SubmitCandidate({ flow, projectId, onSaved }: { flow: HubFlow; projectId: string; onSaved: () => void }) {
  const { t } = useTranslation('workflow'); const revisions = useRevisions(projectId);
  const [draft, setDraft, clearDraft] = useDraft(`submit-flow:${projectId}:${flow.id}`, { subjectRevisionId: '', expectedVersion: flow.version });
  const [validation, setValidation] = useState('');
  const [draftKept, setDraftKept] = useState(false);
  const mutation = useMutation({ mutationFn: (submitted: typeof draft) => postJson<HubFlow>(`${projectPath(projectId)}/flows/${encodeURIComponent(flow.id)}/submit-for-review`, { expectedVersion: submitted.expectedVersion, subjectRevisionId: submitted.subjectRevisionId }), onSuccess: (_result, submitted) => { setDraftKept(!clearDraft(submitted)); onSaved(); } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.subjectRevisionId || !revisions.data?.revisions.some(revision => revision.id === draft.subjectRevisionId)) { setValidation(t('required')); return; } mutation.mutate(draft); }
  return <Panel title={t('submitTitle')} description={t('submitHint')}><form noValidate onSubmit={submit} className="space-y-4"><QueryFeedback query={revisions} /><Field label={t('candidateRevision')}><select className={inputClass} value={draft.subjectRevisionId} onChange={event => setDraft(old => ({ ...old, subjectRevisionId: event.target.value }))} required><option value="">{t('chooseRevision')}</option><RevisionOptions revisions={revisions.data?.revisions ?? []} /></select></Field><p className="text-xs text-slate-500">{t('preparedVersion', { version: draft.expectedVersion })}</p>
    {draft.expectedVersion !== flow.version && <Notice tone="info"><p>{t('latestVersion', { version: flow.version })}</p><Button type="button" variant="ghost" onClick={() => setDraft(old => ({ ...old, expectedVersion: flow.version }))}>{t('reloadVersion')}</Button></Notice>}
    {draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{mutation.isError && <ErrorNotice error={mutation.error} />}<Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? t('loading') : t('submitForReview')}</Button></form></Panel>;
}
function AcceptCandidate({ flow, projectId, onSaved }: { flow: HubFlow; projectId: string; onSaved: () => void }) {
  const hub = useHub(); const { t } = useTranslation('workflow'); const [acknowledged, setAcknowledged] = useState(false);
  const accept = useMutation({ mutationFn: () => postJson<HubFlow>(`${projectPath(projectId)}/flows/${encodeURIComponent(flow.id)}/accept`, { expectedVersion: flow.version, subjectRevisionId: flow.subjectRevisionId, acknowledgeSelfReportedEvidence: true }), onSuccess: onSaved });
  if (hub.principal.kind !== 'human') return <Notice tone="info">{t('humanOnly')}</Notice>;
  return <Panel title={t('acceptTitle')}><div className="space-y-5"><code className={monoClass}>{flow.subjectRevisionId}</code><label className="flex items-start gap-3 text-sm leading-6 text-slate-700"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 size-4 shrink-0 accent-teal-700" /><span>{t('acknowledgment', { revision: flow.subjectRevisionId })}</span></label>{accept.isError && <ErrorNotice error={accept.error} />}<Button disabled={!acknowledged || !flow.subjectRevisionId || accept.isPending} onClick={() => { if (acknowledged) accept.mutate(); }}>{accept.isPending ? t('loading') : t('acceptExact')}</Button></div></Panel>;
}
function AddEvidence({ flow, projectId, onSaved }: { flow: HubFlow; projectId: string; onSaved: () => void }) {
  const { t } = useTranslation('workflow'); const revisions = useRevisions(projectId); const [open, setOpen] = useState(false); const [validation, setValidation] = useState('');
  const [draftKept, setDraftKept] = useState(false);
  const [draft, setDraft, clearDraft] = useDraft(`evidence:${projectId}:${flow.id}`, { subjectRevisionId: '', checkId: '', command: '', exitCode: '0', output: '' });
  const create = useMutation({ mutationFn: (submitted: typeof draft) => postJson<Evidence>(`${projectPath(projectId)}/flows/${encodeURIComponent(flow.id)}/evidence`, { subjectRevisionId: submitted.subjectRevisionId, checkId: submitted.checkId.trim(), command: submitted.command, exitCode: Number(submitted.exitCode), output: submitted.output }), onSuccess: (_result, submitted) => { const cleared = clearDraft(submitted); setDraftKept(!cleared); if (cleared) setOpen(false); onSaved(); } });
  function submit(event: FormEvent) { event.preventDefault(); setValidation(''); if (!draft.subjectRevisionId || !draft.checkId.trim() || !draft.command.trim() || draft.exitCode.trim() === '') { setValidation(t('required')); return; } if (!Number.isSafeInteger(Number(draft.exitCode)) || Number(draft.exitCode) < 0) { setValidation(t('invalidExit')); return; } create.mutate(draft); }
  return <Panel><Button variant="secondary" onClick={() => setOpen(!open)}>{open ? t('cancel') : t('addEvidence')}</Button>{open && <form noValidate onSubmit={submit} className="mt-6 grid gap-5 lg:grid-cols-2"><div className="lg:col-span-2"><QueryFeedback query={revisions} /><Field label={t('evidenceSubject')}><select className={inputClass} value={draft.subjectRevisionId} onChange={event => setDraft(old => ({ ...old, subjectRevisionId: event.target.value }))} required><option value="">{t('chooseRevision')}</option><RevisionOptions revisions={revisions.data?.revisions ?? []} /></select></Field></div><Field label={t('checkId')}><input className={inputClass} value={draft.checkId} maxLength={200} onChange={event => setDraft(old => ({ ...old, checkId: event.target.value }))} required /></Field><Field label={t('exitCode')}><input className={inputClass} type="number" min="0" step="1" value={draft.exitCode} onChange={event => setDraft(old => ({ ...old, exitCode: event.target.value }))} required /></Field><div className="lg:col-span-2"><Field label={t('command')}><input className={inputClass} value={draft.command} onChange={event => setDraft(old => ({ ...old, command: event.target.value }))} required /></Field></div><div className="lg:col-span-2"><Field label={t('output')}><textarea className={`${inputClass} font-mono`} rows={6} value={draft.output} onChange={event => setDraft(old => ({ ...old, output: event.target.value }))} /></Field></div><div className="space-y-3 lg:col-span-2">{draftKept && <Notice tone="success">{t('common:draftPreserved')}</Notice>}{validation && <Notice tone="error"><span role="alert">{validation}</span></Notice>}{create.isError && <ErrorNotice error={create.error} />}<Button type="submit" disabled={create.isPending}>{create.isPending ? t('loading') : t('save')}</Button></div></form>}</Panel>;
}
