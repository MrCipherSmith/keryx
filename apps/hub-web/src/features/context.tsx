import { useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getJson, postJson, errorMessage } from '../api/client';
import type { CodeRevision, CodeRevisionSummary, Delivery, HubDocument, HubEvent, ImportResponse, Project, Proposal } from '../api/types';
import { useHub } from '../app/hub-context';
import { useDraft } from '../state/drafts';
import { Button, EmptyState, Field, Input, Notice, PageHeading, Panel, Select, StatusBadge, Textarea } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { formatDate } from '../i18n/format';
import { decodeRevisionFile, mergeEvents, parseRevisionChanges, safeExternalUrl } from './context-model';

const projectPath = (id: string | null) => `/projects/${encodeURIComponent(id ?? '')}`;
const codeClass = 'max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-700';

function Value({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs font-medium text-slate-500">{label}</dt><dd className="mt-1 break-all text-sm text-slate-800">{children}</dd></div>;
}

function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation('common');
  return error ? <Notice tone="error">{errorMessage(error, t)}</Notice> : null;
}

function ReadState({ pending, error, retry, children }: { pending: boolean; error: unknown; retry: () => unknown; children: ReactNode }) {
  const { t } = useTranslation('common');
  if (pending) return <EmptyState>{t('loading')}</EmptyState>;
  return <>{error ? <div className="space-y-2"><ErrorNotice error={error} /><Button variant="secondary" onClick={() => void retry()}>{t('retry')}</Button></div> : null}{children}</>;
}

function useResource<T>(resource: string) {
  const { projectId, scopeKey } = useHub();
  return useQuery({ queryKey: [scopeKey, projectId, resource.split('?')[0]], queryFn: ({ signal }) => getJson<T>(`${projectPath(projectId)}${resource === 'project' ? '' : `/${resource}`}`, signal), enabled: Boolean(projectId) });
}

function useWrite<T, D = undefined>(resources: string[], onSaved?: (result: T, submittedDraft: D | undefined) => void) {
  const { projectId, scopeKey } = useHub();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown; submittedDraft?: D }) => postJson<T>(`${projectPath(projectId)}${path}`, body),
    retry: false,
    onSuccess: (result, variables) => {
      onSaved?.(result, variables.submittedDraft);
      for (const resource of resources) void client.invalidateQueries({ queryKey: [scopeKey, projectId, resource] });
    },
  });
}

export function DocumentsView() {
  const { t } = useTranslation('context');
  const { projectId, location, navigate, scopeKey } = useHub();
  const docs = useResource<{ documents: HubDocument[] }>('documents');
  const project = useResource<Project>('project');
  const [search, setSearch] = useState('');
  const documents = docs.data?.documents ?? [];
  const selected = documents.find(item => item.id === location.documentId);
  const filtered = documents.filter(item => `${item.path} ${item.kind} ${item.approval} ${t(item.kind === 'spec' ? 'specification' : 'wiki')} ${t(`common:status.${item.approval}`)}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHeading title={t('documents')} description={t('documentsDescription')} />
    {project.data ? <ImportForm key={`${scopeKey}:${projectId}`} project={project.data} /> : <ErrorNotice error={project.error} />}
    <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]">
      <Panel>
        <Field label={t('searchDocuments')}><Input value={search} onChange={event => setSearch(event.target.value)} type="search" /></Field>
        <ReadState pending={docs.isPending} error={docs.error} retry={docs.refetch}>
          {filtered.length ? <div className="max-h-[38rem] space-y-2 overflow-y-auto">{filtered.map(doc => <button key={doc.id} type="button" aria-pressed={doc.id === selected?.id} onClick={() => navigate({ documentId: doc.id })} className={`w-full rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${doc.id === selected?.id ? 'border-emerald-700 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}><span className="block break-all text-sm font-medium text-slate-900">{doc.path}</span><span className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={doc.approval} /><span className="text-xs text-slate-500">{t(doc.kind === 'spec' ? 'specification' : 'wiki')} · {t('version')} {doc.version}</span></span></button>)}</div> : <EmptyState>{t('noDocuments')}</EmptyState>}
        </ReadState>
      </Panel>
      <div className="min-w-0">{selected ? <DocumentDetail key={`${scopeKey}:${projectId}:${selected.id}`} document={selected} /> : <EmptyState>{t(location.documentId ? 'missingDocument' : 'selectDocument')}</EmptyState>}</div>
    </div>
  </>;
}

function ImportForm({ project }: { project: Project }) {
  const { t } = useTranslation('context');
  const [draft, setDraft, clear] = useDraft(`import:${project.id}`, { path: '', kind: 'spec' as 'spec' | 'wiki', sourceRevision: '', content: '', expectedVersion: project.version });
  const [validation, setValidation] = useState(false);
  const [saved, setSaved] = useState<{ documents: number; proposals: number }>();
  const [draftKept, setDraftKept] = useState(false);
  const mutation = useWrite<ImportResponse, typeof draft>(['project', 'documents', 'proposals'], (result, submitted) => { if (submitted) setDraftKept(!clear(submitted)); setSaved({ documents: result.documents.length, proposals: result.proposals.length }); });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.path.trim() || !draft.sourceRevision.trim() || !draft.content.trim()) { setValidation(true); return; }
    setValidation(false); setSaved(undefined);
    mutation.mutate({ submittedDraft: draft, path: '/import', body: { expectedVersion: draft.expectedVersion, sourceRevision: draft.sourceRevision.trim(), documents: [{ path: draft.path.trim(), kind: draft.kind, content: draft.content }] } });
  }
  return <details className="group rounded-2xl border border-slate-200 bg-white"><summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-emerald-900 focus-visible:outline-2 focus-visible:outline-emerald-700">{t('importDocument')}</summary><form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-100 p-5">
    <div className="grid gap-4 md:grid-cols-2"><Field label={t('path')}><Input required value={draft.path} onChange={event => setDraft({ ...draft, path: event.target.value })} /></Field><Field label={t('kind')}><Select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value === 'wiki' ? 'wiki' : 'spec' })}><option value="spec">{t('specification')}</option><option value="wiki">{t('wiki')}</option></Select></Field></div>
    <Field label={t('sourceRevision')} hint={t('sourceRevisionHint')}><Input required value={draft.sourceRevision} onChange={event => setDraft({ ...draft, sourceRevision: event.target.value })} /></Field>
    <Field label={t('markdownSource')}><Textarea required rows={8} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} /></Field>
    <p className="text-xs text-slate-500">{t('baseVersion')}: {draft.expectedVersion} · {t('currentVersion')}: {project.version}</p>
    {draft.expectedVersion !== project.version ? <div className="space-y-2"><Notice>{t('reconcileHint')}</Notice><Button variant="secondary" disabled={mutation.isPending} onClick={() => setDraft({ ...draft, expectedVersion: project.version })}>{t('useCurrentVersion')}</Button></div> : null}
    {draftKept ? <Notice tone="success">{t('common:draftPreserved')}</Notice> : null}{validation ? <Notice tone="error">{t('requiredFields')}</Notice> : null}<ErrorNotice error={mutation.error} />{saved ? <Notice tone="success">{t('importSaved', saved)}</Notice> : null}
    <Button type="submit" disabled={mutation.isPending}>{t('import')}</Button><p className="text-xs leading-relaxed text-slate-500">{t('importHint')}</p>
  </form></details>;
}

function DocumentDetail({ document: doc }: { document: HubDocument }) {
  const { t, i18n } = useTranslation('context');
  const [raw, setRaw] = useState(false);
  return <div className="space-y-5"><Panel title={<span className="break-all">{doc.path}</span>}>
    <div className="flex flex-wrap items-center gap-2"><StatusBadge status={doc.approval} /><span className="text-xs text-slate-500">{t(doc.kind === 'spec' ? 'specification' : 'wiki')} · {t('version')} {doc.version}</span></div>
    <dl className="grid gap-4 sm:grid-cols-2"><Value label={t('sourceRevision')}>{doc.sourceRevision}</Value><Value label={t('digest')}><code>{doc.contentDigest}</code></Value>{doc.acceptedBy ? <Value label={t('acceptedBy')}>{doc.acceptedBy}{doc.acceptedAt ? ` · ${formatDate(doc.acceptedAt, i18n.language)}` : ''}</Value> : null}</dl>
    <div className="flex gap-2"><Button variant={raw ? 'secondary' : 'primary'} onClick={() => setRaw(false)}>{t('preview')}</Button><Button variant={raw ? 'primary' : 'secondary'} onClick={() => setRaw(true)}>{t('rawSource')}</Button></div>
    {raw ? <pre className={`${codeClass} whitespace-pre-wrap break-words`}>{doc.content}</pre> : <Markdown content={doc.content} />}
  </Panel><ProposalForm document={doc} /></div>;
}

function ProposalForm({ document: doc }: { document: HubDocument }) {
  const { t } = useTranslation('context');
  const { projectId } = useHub();
  const [draft, setDraft, clear] = useDraft(`proposal:${projectId}:${doc.id}`, { content: doc.content, reason: '', baseVersion: doc.version });
  const [validation, setValidation] = useState(false);
  const [draftKept, setDraftKept] = useState(false);
  const mutation = useWrite<Proposal, typeof draft>(['proposals'], (_result, submitted) => { if (submitted) setDraftKept(!clear(submitted)); });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.content.trim() || !draft.reason.trim()) { setValidation(true); return; }
    setValidation(false);
    mutation.mutate({ submittedDraft: draft, path: '/proposals', body: { documentId: doc.id, baseVersion: draft.baseVersion, content: draft.content, reason: draft.reason.trim() } });
  }
  return <details className="rounded-2xl border border-slate-200 bg-white"><summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-emerald-900">{t('proposeEdit')}</summary><form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-100 p-5">
    <Field label={t('proposedContent')}><Textarea required rows={10} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} /></Field>
    <Field label={t('reason')}><Input required value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></Field>
    <p className="text-xs text-slate-500">{t('baseVersion')}: {draft.baseVersion} · {t('currentVersion')}: {doc.version}</p>
    {draft.baseVersion !== doc.version ? <div className="space-y-2"><Notice>{t('reconcileHint')}</Notice><Button variant="secondary" disabled={mutation.isPending} onClick={() => setDraft({ ...draft, baseVersion: doc.version })}>{t('useCurrentVersion')}</Button></div> : null}
    {draftKept ? <Notice tone="success">{t('common:draftPreserved')}</Notice> : null}{validation ? <Notice tone="error">{t('requiredFields')}</Notice> : null}<ErrorNotice error={mutation.error} />{mutation.isSuccess ? <Notice tone="success">{t('saved')}</Notice> : null}<Button type="submit" disabled={mutation.isPending}>{t('submitProposal')}</Button>
  </form></details>;
}

export function ProposalsView() {
  const { t } = useTranslation('context');
  const proposals = useResource<{ proposals: Proposal[] }>('proposals');
  const documents = useResource<{ documents: HubDocument[] }>('documents');
  const [filter, setFilter] = useState('pending');
  const filtered = (proposals.data?.proposals ?? []).filter(item => filter === 'all' || item.status === filter);
  return <><PageHeading title={t('proposals')} description={t('proposalsDescription')} />
    <div className="mb-5 max-w-xs"><Field label={t('proposals')}><Select value={filter} onChange={event => setFilter(event.target.value)}>{['all', 'pending', 'accepted', 'rejected'].map(value => <option key={value} value={value}>{t(value)}</option>)}</Select></Field></div>
    <ReadState pending={proposals.isPending || documents.isPending} error={proposals.error || documents.error} retry={() => { void proposals.refetch(); void documents.refetch(); }}>
      <div className="space-y-5">{filtered.length ? filtered.map(proposal => <ProposalCard key={`${proposal.id}:${proposal.version}:${proposal.contentDigest}`} proposal={proposal} document={documents.data?.documents.find(doc => doc.id === proposal.documentId)} />) : <EmptyState>{t('noProposals')}</EmptyState>}</div>
    </ReadState></>;
}

function ProposalCard({ proposal, document: doc }: { proposal: Proposal; document: HubDocument | undefined }) {
  const { t } = useTranslation('context');
  const { principal } = useHub();
  const [acknowledged, setAcknowledged] = useState(false);
  const [review] = useState({ expectedVersion: proposal.version, contentDigest: proposal.contentDigest });
  const mutation = useWrite<Proposal>(['proposals', 'documents', 'project']);
  function decide(decision: 'accepted' | 'rejected') {
    mutation.mutate({ path: `/proposals/${encodeURIComponent(proposal.id)}/review`, body: { decision, ...review } });
  }
  return <Panel title={<span className="break-all">{doc?.path ?? proposal.documentId}</span>}>
    <div className="flex flex-wrap items-center gap-3"><StatusBadge status={proposal.status} /><span className="text-xs text-slate-500">{t('version')} {proposal.version} · {t('baseVersion')} {proposal.baseVersion}</span></div>
    <p className="text-sm leading-relaxed text-slate-700">{proposal.reason}</p>
    <dl className="grid gap-4 sm:grid-cols-2"><Value label={t('digest')}><code>{proposal.contentDigest}</code></Value><Value label={t('createdBy')}>{proposal.createdBy}</Value>{proposal.reviewedBy ? <Value label={t('reviewedBy')}>{proposal.reviewedBy}</Value> : null}</dl>
    <details><summary className="cursor-pointer text-sm font-semibold text-emerald-800">{t('reviewProposal')}</summary><div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2"><div className="min-w-0"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('canonicalSource')}</h3><pre className={`${codeClass} max-h-[32rem] whitespace-pre-wrap break-words`}>{doc?.content ?? t('missingDocument')}</pre></div><div className="min-w-0"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('proposedSource')}</h3><pre className={`${codeClass} max-h-[32rem] whitespace-pre-wrap break-words`}>{proposal.content}</pre></div></div></details>
    {proposal.status === 'pending' ? principal.kind === 'human' ? <div className="space-y-3 border-t border-slate-100 pt-4">
      {doc && doc.version !== proposal.baseVersion ? <Notice tone="error">{t('proposalBaseChanged')}</Notice> : null}
      <label className="flex items-start gap-3 text-sm leading-relaxed text-slate-700"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-emerald-800" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t('proposalAcknowledgment')}</label>
      <div className="flex flex-wrap gap-2"><Button disabled={!acknowledged || mutation.isPending || !doc || doc.version !== proposal.baseVersion} onClick={() => decide('accepted')}>{t('acceptProposal')}</Button><Button variant="danger" disabled={!acknowledged || mutation.isPending} onClick={() => decide('rejected')}>{t('rejectProposal')}</Button></div>
    </div> : <Notice>{t('humanRequired')}</Notice> : null}
    <ErrorNotice error={mutation.error} />{mutation.isSuccess ? <Notice tone="success">{t('saved')}</Notice> : null}
  </Panel>;
}

export function RevisionsView() {
  const { t } = useTranslation('context');
  const { scopeKey, projectId, location, navigate } = useHub();
  const revisions = useResource<{ revisions: CodeRevisionSummary[] }>('revisions?summary=1');
  const project = useResource<Project>('project');
  const selected = revisions.data?.revisions.find(item => item.id === location.revisionId);
  return <><PageHeading title={t('revisions')} description={t('revisionsDescription')} />
    {revisions.data && project.data ? <RevisionForm key={`${scopeKey}:${projectId}`} revisions={revisions.data.revisions} /> : null}
    <ReadState pending={revisions.isPending || project.isPending} error={revisions.error || project.error} retry={() => { void revisions.refetch(); void project.refetch(); }}>
      <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]"><Panel>
        {(revisions.data?.revisions.length ?? 0) > 0 ? <div className="space-y-2">{revisions.data?.revisions.map(revision => <button key={revision.id} type="button" className={`w-full rounded-xl border p-3 text-left focus-visible:outline-2 focus-visible:outline-emerald-700 ${selected?.id === revision.id ? 'border-emerald-700 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`} onClick={() => navigate({ revisionId: revision.id })}><span className="block break-words text-sm font-semibold text-slate-900">{revision.message}</span><span className="mt-1 block break-all font-mono text-xs text-slate-500">{revision.id}</span><span className="mt-1 block text-xs text-slate-500">{t('files')}: {revision.fileCount}</span><span className={`mt-2 inline-block rounded px-2 py-1 text-[11px] font-medium ${revision.purpose === 'review-bundle' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>{t(revision.purpose === 'review-bundle' ? 'reviewBundle' : 'snapshot')}</span></button>)}</div> : <EmptyState>{t('noRevisions')}</EmptyState>}
      </Panel><div className="min-w-0">{selected && project.data ? <RevisionDetail key={`${scopeKey}:${projectId}:${selected.id}`} revision={selected} project={project.data} /> : <EmptyState>{t('selectRevision')}</EmptyState>}</div></div>
    </ReadState></>;
}

function RevisionForm({ revisions }: { revisions: CodeRevisionSummary[] }) {
  const { t } = useTranslation('context');
  const { projectId } = useHub();
  const [draft, setDraft, clear] = useDraft(`revision:${projectId}`, { baseRevisionId: '', gitBaseSha: '', message: '', changes: '[\n  {"path":"README.md","content":""}\n]' });
  const [validation, setValidation] = useState<'requiredFields' | 'invalidChanges' | 'invalidSha'>();
  const [draftKept, setDraftKept] = useState(false);
  const mutation = useWrite<CodeRevision, typeof draft>(['revisions'], (_result, submitted) => { if (submitted) setDraftKept(!clear(submitted)); });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.message.trim() || !draft.gitBaseSha.trim()) { setValidation('requiredFields'); return; }
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(draft.gitBaseSha.trim())) { setValidation('invalidSha'); return; }
    let changes;
    try { changes = parseRevisionChanges(draft.changes); } catch { setValidation('invalidChanges'); return; }
    setValidation(undefined);
    mutation.mutate({ submittedDraft: draft, path: '/revisions', body: { baseRevisionId: draft.baseRevisionId || null, gitBaseSha: draft.gitBaseSha.trim(), message: draft.message.trim(), changes } });
  }
  return <details className="rounded-2xl border border-slate-200 bg-white"><summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-emerald-900">{t('createRevision')}</summary><form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-100 p-5">
    <Field label={t('revisionMessage')}><Input required value={draft.message} onChange={event => setDraft({ ...draft, message: event.target.value })} /></Field>
    <div className="grid gap-4 md:grid-cols-2"><Field label={t('gitBaseSha')}><Input required value={draft.gitBaseSha} onChange={event => setDraft({ ...draft, gitBaseSha: event.target.value })} /></Field><Field label={t('baseRevision')}><Select value={draft.baseRevisionId} onChange={event => setDraft({ ...draft, baseRevisionId: event.target.value })}><option value="">{t('noBase')}</option>{revisions.filter(item => item.purpose !== 'review-bundle').map(item => <option key={item.id} value={item.id}>{item.message} · {item.id.slice(0, 8)}</option>)}</Select></Field></div>
    <Field label={t('changes')} hint={t('changesHint')}><Textarea required rows={8} value={draft.changes} onChange={event => setDraft({ ...draft, changes: event.target.value })} className="font-mono" /></Field>
    {draftKept ? <Notice tone="success">{t('common:draftPreserved')}</Notice> : null}{validation ? <Notice tone="error">{t(validation)}</Notice> : null}<ErrorNotice error={mutation.error} />{mutation.isSuccess ? <Notice tone="success">{t('saved')}</Notice> : null}<Button type="submit" disabled={mutation.isPending}>{t('createSnapshot')}</Button>
  </form></details>;
}

function RevisionDetail({ revision: summary, project }: { revision: CodeRevisionSummary; project: Project }) {
  const { projectId, scopeKey } = useHub();
  const detail = useQuery({ queryKey: [scopeKey, projectId, 'revision', summary.id], queryFn: ({ signal }) => getJson<CodeRevision>(`${projectPath(projectId)}/revisions/${encodeURIComponent(summary.id)}`, signal) });
  return <ReadState pending={detail.isPending} error={detail.error} retry={detail.refetch}>{detail.data ? <RevisionFiles key={`${scopeKey}:${summary.id}`} revision={detail.data} project={project} /> : null}</ReadState>;
}

function RevisionFiles({ revision, project }: { revision: CodeRevision; project: Project }) {
  const { t, i18n } = useTranslation('context');
  const { principal } = useHub();
  const [filePath, setFilePath] = useState(revision.files[0]?.path ?? '');
  const [acknowledged, setAcknowledged] = useState(false);
  const [lineVersion, setLineVersion] = useState(project.lineVersion);
  const mutation = useWrite<Project>(['project']);
  const file = revision.files.find(item => item.path === filePath);
  const preview = file ? decodeRevisionFile(file.contentBase64) : undefined;
  return <div className="space-y-5"><Panel title={revision.message}>
    {revision.purpose === 'review-bundle' ? <Notice>{t('reviewBundleHint')}</Notice> : <StatusBadge status={project.lineRevisionId === revision.id ? 'accepted' : 'unreviewed'} />}
    <dl className="grid gap-4 sm:grid-cols-2"><Value label={t('revisionId')}><code>{revision.id}</code></Value><Value label={t('gitBaseSha')}><code>{revision.gitBaseSha}</code></Value><Value label={t('treeDigest')}><code>{revision.treeDigest}</code></Value><Value label={t('createdBy')}>{revision.createdBy} · {formatDate(revision.createdAt, i18n.language)}</Value></dl>
    {revision.purpose !== 'review-bundle' ? principal.kind === 'human' ? <div className="space-y-3 border-t border-slate-100 pt-4">
      <p className="break-all text-xs text-slate-500">{t('selectedLine')}: {project.lineRevisionId ?? t('noLine')} · {t('lineVersion')}: {project.lineVersion}</p>
      <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-emerald-800" checked={acknowledged} onChange={event => { setAcknowledged(event.target.checked); if (event.target.checked) setLineVersion(project.lineVersion); }} />{t('selectionAcknowledgment')}</label>
      <Button disabled={!acknowledged || mutation.isPending} onClick={() => mutation.mutate({ path: '/line', body: { revisionId: revision.id, expectedVersion: lineVersion } })}>{t('selectForIntegration')}</Button>
      <ErrorNotice error={mutation.error} />{mutation.isSuccess ? <Notice tone="success">{t('selectionSaved')}</Notice> : null}
    </div> : <Notice>{t('humanRequired')}</Notice> : null}
  </Panel><Panel title={t('files')}>
    {revision.files.length ? <Field label={t('selectFile')}><Select value={filePath} onChange={event => setFilePath(event.target.value)}>{revision.files.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</Select></Field> : <EmptyState>{t('selectFile')}</EmptyState>}
    {file ? <p className="break-all font-mono text-xs text-slate-500">{file.mode} · {file.contentDigest}</p> : null}
    {preview?.kind === 'binary' ? <Notice>{t('binaryFile', { size: preview.size })}</Notice> : preview ? <>{preview.truncated ? <Notice>{t('truncated')}</Notice> : null}<pre className={`${codeClass} max-h-[36rem]`}>{preview.text}</pre></> : null}
  </Panel></div>;
}

export function DeliveryView() {
  const { t, i18n } = useTranslation('context');
  const { principal } = useHub();
  const project = useResource<Project>('project');
  const deliveries = useResource<{ deliveries: Delivery[] }>('deliveries');
  const revisions = useResource<{ revisions: CodeRevisionSummary[] }>('revisions?summary=1');
  const selected = revisions.data?.revisions.find(item => item.id === project.data?.lineRevisionId);
  return <><PageHeading title={t('delivery')} description={t('deliveryDescription')} />
    <ReadState pending={project.isPending || revisions.isPending || deliveries.isPending} error={project.error || revisions.error || deliveries.error} retry={() => { void project.refetch(); void revisions.refetch(); void deliveries.refetch(); }}>
      {project.data ? <Panel title={t('selectedLine')}><p className="break-all font-mono text-sm text-slate-700">{project.data.lineRevisionId ?? t('noLine')}</p><p className="text-xs text-slate-500">{t('lineVersion')}: {project.data.lineVersion}</p></Panel> : null}
      <div className="my-5">{principal.kind !== 'human' ? <Notice>{t('humanRequired')}</Notice> : project.data && selected && selected.purpose !== 'review-bundle' ? <DeliveryForm project={project.data} /> : <Notice>{t('deliveryUnavailable')}</Notice>}</div>
      <div className="space-y-4">{deliveries.data?.deliveries.length ? [...deliveries.data.deliveries].reverse().map(delivery => <Panel key={delivery.id} title={<span className="break-all">{delivery.baseBranch} · {delivery.revisionId.slice(0, 12)}</span>}>
        <StatusBadge status={delivery.status} /><p className="break-all text-sm text-slate-600">{delivery.remoteUrl}</p>
        {delivery.error ? <Notice tone="error"><code>{delivery.error}</code></Notice> : null}
        <dl className="grid gap-4 sm:grid-cols-2">{delivery.branch ? <Value label={t('branch')}><code>{delivery.branch}</code></Value> : null}{delivery.commitSha ? <Value label={t('commit')}><code>{delivery.commitSha}</code></Value> : null}{delivery.treeSha ? <Value label={t('tree')}><code>{delivery.treeSha}</code></Value> : null}<Value label={t('receipt')}><code>{delivery.receipt.id}</code><span className="block text-xs text-slate-500">{delivery.receipt.actorId} · {formatDate(delivery.receipt.createdAt, i18n.language)}</span></Value></dl>
        {safeExternalUrl(delivery.prUrl) ? <a className="text-sm font-semibold text-emerald-800 underline" href={safeExternalUrl(delivery.prUrl)} target="_blank" rel="noopener noreferrer">{t('viewPullRequest')}</a> : null}
      </Panel>) : <EmptyState>{t('noDeliveries')}</EmptyState>}</div>
    </ReadState></>;
}

function DeliveryForm({ project }: { project: Project }) {
  const { t } = useTranslation('context');
  const [draft, setDraft, clear] = useDraft(`delivery:${project.id}`, { remoteUrl: '', baseBranch: 'main', revisionId: project.lineRevisionId ?? '', expectedLineVersion: project.lineVersion });
  const [acknowledged, setAcknowledged] = useState(false);
  const [validation, setValidation] = useState(false);
  const [draftKept, setDraftKept] = useState(false);
  const mutation = useWrite<Delivery, typeof draft>(['deliveries'], (_result, submitted) => { if (submitted) setDraftKept(!clear(submitted)); setAcknowledged(false); });
  const stale = draft.expectedLineVersion !== project.lineVersion || draft.revisionId !== project.lineRevisionId;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.remoteUrl.trim() || !draft.baseBranch.trim() || !draft.revisionId || !acknowledged) { setValidation(true); return; }
    setValidation(false);
    mutation.mutate({ submittedDraft: draft, path: '/deliveries', body: { revisionId: draft.revisionId, remoteUrl: draft.remoteUrl.trim(), baseBranch: draft.baseBranch.trim(), expectedLineVersion: draft.expectedLineVersion } });
  }
  return <Panel title={t('publish')}><form noValidate onSubmit={submit} className="space-y-4">
    <p className="break-all font-mono text-xs text-slate-500">{draft.revisionId} · {t('lineVersion')}: {draft.expectedLineVersion}</p>
    <Field label={t('remoteUrl')}><Input required value={draft.remoteUrl} onChange={event => setDraft({ ...draft, remoteUrl: event.target.value })} /></Field>
    <Field label={t('baseBranch')}><Input required value={draft.baseBranch} onChange={event => setDraft({ ...draft, baseBranch: event.target.value })} /></Field>
    {stale ? <div className="space-y-2"><Notice>{t('reconcileHint')}</Notice><Button variant="secondary" disabled={mutation.isPending} onClick={() => { setDraft({ ...draft, revisionId: project.lineRevisionId ?? '', expectedLineVersion: project.lineVersion }); setAcknowledged(false); }}>{t('useCurrentVersion')}</Button></div> : null}
    <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" checked={acknowledged} className="mt-1 size-4 shrink-0 accent-emerald-800" onChange={event => setAcknowledged(event.target.checked)} />{t('publishAcknowledgment')}</label>
    {draftKept ? <Notice tone="success">{t('common:draftPreserved')}</Notice> : null}{validation ? <Notice tone="error">{t('requiredFields')}</Notice> : null}<ErrorNotice error={mutation.error} />{mutation.isSuccess ? <Notice tone="success">{t('deliveryResult')}</Notice> : null}<Button type="submit" disabled={!acknowledged || mutation.isPending || stale}>{t('publish')}</Button>
  </form></Panel>;
}

export function HistoryView() {
  const { t, i18n } = useTranslation('context');
  const { projectId, scopeKey } = useHub();
  const events = useInfiniteQuery({
    queryKey: [scopeKey, projectId, 'events'], initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => getJson<{ events: HubEvent[]; cursor: number }>(`${projectPath(projectId)}/events?after=${pageParam}`, signal),
    getNextPageParam: (last, _pages, previousCursor) => last.events.length === 500 && last.cursor > previousCursor ? last.cursor : undefined,
    enabled: Boolean(projectId),
  });
  const items = mergeEvents(events.data?.pages.map(page => page.events) ?? []);
  return <><PageHeading title={t('history')} description={t('historyDescription')} />
    <ReadState pending={events.isPending} error={events.error} retry={events.refetch}>
      {items.length ? <Panel><ol className="space-y-0">{items.map(event => <li key={event.sequence} className="relative min-w-0 border-b border-slate-100 py-5 first:pt-0 last:border-0 last:pb-0"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-900">{t(`event.${event.type}`, { defaultValue: event.type })}</h2><time dateTime={event.createdAt} className="text-xs text-slate-500">{formatDate(event.createdAt, i18n.language)}</time></div><div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500"><span>#{event.sequence}</span><span className="break-all">{t('actor')}: {event.actorId}</span><span>{t('role')}: {event.actorRole ? t(`common:${event.actorRole}`, { defaultValue: event.actorRole }) : t('unknownRole')}</span></div><p className="mt-2 break-all font-mono text-xs text-slate-600">{event.entityId}</p></li>)}</ol></Panel> : <EmptyState>{t('noHistory')}</EmptyState>}
      <div className="mt-5">{events.hasNextPage ? <Button variant="secondary" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>{t('loadMore')}</Button> : items.length ? <p className="text-center text-xs text-slate-500">{t('endOfHistory')}</p> : null}</div>
    </ReadState></>;
}
