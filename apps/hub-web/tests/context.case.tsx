import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/context.en';
import { useDraftStore } from '../src/state/drafts';
import ru from '../src/i18n/context.ru';
import { mergeEvents } from '../src/features/context-model';
import { DocumentsView, ProposalsView, RevisionsView, DeliveryView, HistoryView } from '../src/features/context';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), navigate: vi.fn(), location: { projectId: 'p', tab: 'documents', documentId: 'd' as string | undefined, revisionId: 'r' }, principal: { id: 'human:owner', kind: 'human', role: 'operator' } }));
vi.mock('../src/app/hub-context', () => ({ useHub: () => ({ projectId: 'p', principal: mocks.principal, scopeKey: 1, location: mocks.location, navigate: mocks.navigate, refresh: vi.fn() }) }));
vi.mock('../src/features/context-model', async importOriginal => { const actual = await importOriginal<typeof import('../src/features/context-model')>(); return { ...actual, mergeEvents: vi.fn(actual.mergeEvents) }; });
vi.mock('../src/api/client', () => ({ getJson: mocks.get, postJson: mocks.post, errorMessage: (error: Error) => error.message }));

const project = { id: 'p', name: 'Keryx', version: 2, contextRevision: 1, lineVersion: 0, lineRevisionId: null };
const document = { id: 'd', projectId: 'p', path: 'specs/example.md', kind: 'spec', content: '# Exact source', contentDigest: 'digest', version: 4, approval: 'unreviewed', sourceRevision: 'manual:v1' };
const revision = { id: 'r', projectId: 'p', baseRevisionId: null, gitBaseSha: 'a'.repeat(40), message: 'Review candidate', files: [], createdBy: 'agent:connector', createdAt: '2026-10-26T00:00:00Z', treeDigest: 'tree', purpose: 'review-bundle' };

async function mount(component: React.ReactNode) {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { context: en, common: { loading: 'Loading', retry: 'Retry', empty: 'Empty', refresh: 'Refresh', error: 'Error' } }, ru: { context: ru } }, interpolation: { escapeValue: false } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, i18n, ...render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}>{component}</QueryClientProvider></I18nextProvider>) };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDraftStore.getState().clearAll();
  mocks.principal = { id: 'human:owner', kind: 'human', role: 'operator' };
  mocks.location = { projectId: 'p', tab: 'documents', documentId: 'd', revisionId: 'r' };
  mocks.get.mockImplementation((path: string) => {
    if (path.endsWith('/documents')) return Promise.resolve({ documents: [document] });
    if (path.endsWith('/proposals')) return Promise.resolve({ proposals: [] });
    if (path.endsWith('/revisions?summary=1')) { const { files, ...metadata } = revision; return Promise.resolve({ revisions: [{ ...metadata, fileCount: files.length }] }); }
    if (path.endsWith('/revisions/r')) return Promise.resolve(revision);
    if (path === '/projects/p') return Promise.resolve(project);
    return Promise.resolve({ events: [], cursor: 0 });
  });
});

describe('document provenance and draft version', () => {
  it('requires Source revision and sends the exact import version and source text', async () => {
  mocks.location.documentId = undefined;
    mocks.post.mockResolvedValue({ documents: [document], proposals: [] });
    await mount(<DocumentsView />);
    const toggle = await screen.findByText(en.importDocument);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(en.path), { target: { value: 'specs/new.md' } });
    fireEvent.change(screen.getByLabelText(en.markdownSource), { target: { value: '# New exact source' } });
    fireEvent.click(screen.getByRole('button', { name: en.import }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(en.requiredFields);
    fireEvent.change(screen.getByLabelText(new RegExp(en.sourceRevision)), { target: { value: 'manual:new-v1' } });
    fireEvent.click(screen.getByRole('button', { name: en.import }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/projects/p/import', { expectedVersion: 2, sourceRevision: 'manual:new-v1', documents: [{ path: 'specs/new.md', kind: 'spec', content: '# New exact source' }] }));
  });
  it('keeps a proposal draft and its original document version on conflict and refetch', async () => {
    mocks.post.mockRejectedValue(Object.assign(new Error('version conflict'), { status: 409, code: 'version-conflict' }));
    const { client } = await mount(<DocumentsView />);
    fireEvent.click(await screen.findByText(en.proposeEdit));
    fireEvent.change(screen.getByLabelText(en.proposedContent), { target: { value: '# Unsent draft' } });
    fireEvent.change(screen.getByLabelText(en.reason), { target: { value: 'Correct the behavior' } });
    client.setQueryData([1, 'p', 'documents'], { documents: [{ ...document, version: 5, content: '# Updated elsewhere' }] });
    fireEvent.click(screen.getByRole('button', { name: en.submitProposal }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/projects/p/proposals', { documentId: 'd', baseVersion: 4, content: '# Unsent draft', reason: 'Correct the behavior' }));
    await waitFor(() => expect(screen.getByLabelText(en.proposedContent)).toHaveValue('# Unsent draft'));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});

it.each([
  { source: '    # code, not a heading', visible: '# code, not a heading', selector: 'code' },
  { source: '---\n---\nTitle: Keep this paragraph\n\n---', visible: 'Title: Keep this paragraph' },
  { source: String.raw`---
Title: "Review \"copy\""
Summary: "Use the \"real\" example"
---
# Review "copy"

Content.`, visible: 'Use the "real" example' },
])('keeps document content readable in preview: $visible', async ({ source, visible, selector }) => {
  mocks.get.mockImplementation((path: string) => Promise.resolve(
    path.endsWith('/documents') ? { documents: [{ ...document, content: source }] } : project,
  ));
  await mount(<DocumentsView />);
  expect(await within(await screen.findByRole('article')).findByText(visible, { selector })).toBeVisible();
});

it('keeps a link in the first Markdown heading usable in preview', async () => {
  const content = '# [Open runbook](https://example.com/runbook)';
  mocks.get.mockImplementation((path: string) => Promise.resolve(
    path.endsWith('/documents') ? { documents: [{ ...document, content }] } : project,
  ));
  await mount(<DocumentsView />);
  expect(await screen.findByRole('link', { name: 'Open runbook' })).toHaveAttribute('href', 'https://example.com/runbook');
});

it('keeps specification search and returns focus to the same card after reading a document', async () => {
  const wiki = { ...document, id: 'wiki', path: 'wiki/example.md', kind: 'wiki' };
  mocks.get.mockImplementation((path: string) => Promise.resolve(
    path.endsWith('/documents') ? { documents: [document, wiki] } : project,
  ));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  function TestRoute() {
    const [documentId, setDocumentId] = useState<string>();
    mocks.location.documentId = documentId;
    mocks.navigate.mockImplementation((patch: { documentId?: string }) => setDocumentId(patch.documentId));
    return <DocumentsView />;
  }
  try {
    await mount(<TestRoute />);
    fireEvent.click(await screen.findByRole('button', { name: en.specifications }));
    const search = screen.getByLabelText(en.searchDocuments);
    fireEvent.change(search, { target: { value: 'example' } });
    expect(screen.queryByRole('button', { name: /wiki\/example/ })).not.toBeInTheDocument();
    const card = await screen.findByRole('button', { name: /specs\/example/ });
    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: 'Exact source' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Back to list/ }));
    expect(card).toHaveFocus();
    expect(scrollTo).toHaveBeenCalled();
    expect(search).toHaveValue('example');
    expect(screen.getByRole('button', { name: en.specifications })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('renders highlighted, numbered source safely and copies the complete revision text', async () => {
  const source = '\uFEFFconst text = "<img src=x onerror=alert(1)>";\r\n// ' + 'x'.repeat(128_000);
  const file = {
    path: 'src/example.ts', mode: '100644', contentDigest: 'content-digest',
    contentBase64: btoa(String.fromCharCode(0xef, 0xbb, 0xbf) + source.slice(1)),
  };
  const readme = { ...file, path: 'README.md', contentBase64: btoa('Text from the README') };
  mocks.get.mockImplementation((path: string) => Promise.resolve(
    path.endsWith('/revisions?summary=1') ? { revisions: [{ ...revision, fileCount: 2 }] }
      : path.endsWith('/revisions/r') ? { ...revision, files: [file, readme] } : project,
  ));
  const writeText = vi.fn().mockResolvedValue(undefined);
  const oldClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    await mount(<RevisionsView />);
    const code = await screen.findByRole('region', { name: file.path });
    expect(code.querySelector('.hljs-keyword')).toHaveTextContent('const');
    expect(code.querySelector('img')).toBeNull();
    expect(code).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect([...code.querySelectorAll('.revision-code-number')].map(row => row.textContent)).toEqual(['1', '2']);
    const wrap = screen.getByRole('button', { name: en.wrapLines });
    expect(wrap).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: en.copyCode }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
    expect(await screen.findByText(en.codeCopied)).toBeVisible();
    fireEvent.change(screen.getByLabelText(en.fileType), { target: { value: 'md' } });
    expect(screen.queryByRole('button', { name: en.copyCode })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(en.selectFile), { target: { value: readme.path } });
    expect(await screen.findByRole('region', { name: readme.path })).toHaveTextContent('Text from the README');
  } finally {
    if (oldClipboard) Object.defineProperty(navigator, 'clipboard', oldClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('shows review bundles but never offers integration selection or a snapshot base option', async () => {
  await mount(<RevisionsView />);
  expect(await screen.findByText(en.reviewBundleHint)).toBeVisible();
  expect(screen.queryByRole('button', { name: en.selectForIntegration })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(en.createRevision));
  expect(screen.getByLabelText(en.baseRevision).querySelectorAll('option')).toHaveLength(1);
});

it('labels the immutable revision UUID as Revision ID rather than a content digest', async () => {
  const revisionId = '3f7a68ab-44ce-4b95-8ed8-2c6a6dc620aa';
  mocks.location.revisionId = revisionId;
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/revisions?summary=1') ? { revisions: [{ ...revision, id: revisionId, fileCount: 0 }] } : path.endsWith(`/revisions/${revisionId}`) ? { ...revision, id: revisionId } : project));
  await mount(<RevisionsView />);
  const label = await screen.findByText(en.revisionId);
  expect(within(label.parentElement!).getByText(revisionId)).toBeVisible();
  expect(screen.queryByText(en.digest)).not.toBeInTheDocument();
});

it('does not enable human proposal review for an agent principal', async () => {
  mocks.principal = { id: 'agent:connector', kind: 'agent', role: 'agent' };
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/documents') ? { documents: [document] } : path.endsWith('/proposals') ? { proposals: [{ id: 'proposal', projectId: 'p', documentId: 'd', baseVersion: 4, version: 1, content: '# Proposed', contentDigest: 'proposal-digest', status: 'pending', reason: 'Reason', createdBy: 'agent:connector' }] } : project));
  await mount(<ProposalsView />);
  expect(await screen.findByText(en.humanRequired)).toBeVisible();
  expect(screen.queryByRole('button', { name: en.acceptProposal })).not.toBeInTheDocument();
});

it('human proposal approval requires acknowledgment and preserves the exact digest and version', async () => {
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/documents') ? { documents: [document] } : { proposals: [{ id: 'proposal', projectId: 'p', documentId: 'd', baseVersion: 4, version: 3, content: '# Proposed', contentDigest: 'proposal-digest', status: 'pending', reason: 'Reason', createdBy: 'agent:connector' }] }));
  mocks.post.mockResolvedValue({});
  await mount(<ProposalsView />);
  const button = await screen.findByRole('button', { name: en.acceptProposal });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: en.proposalAcknowledgment }));
  fireEvent.click(button);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/projects/p/proposals/proposal/review', { decision: 'accepted', expectedVersion: 3, contentDigest: 'proposal-digest' }));
});

it('publishes only an explicitly acknowledged selected snapshot with the captured line version', async () => {
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/revisions?summary=1') ? { revisions: [{ ...revision, purpose: 'snapshot' }] } : path.endsWith('/deliveries') ? { deliveries: [] } : { ...project, lineRevisionId: 'r', lineVersion: 7 }));
  mocks.post.mockResolvedValue({});
  await mount(<DeliveryView />);
  const publish = await screen.findByRole('button', { name: en.publish });
  expect(publish).toBeDisabled();
  fireEvent.change(screen.getByLabelText(en.remoteUrl), { target: { value: 'git@example.com:org/repo.git' } });
  fireEvent.change(screen.getByLabelText(en.baseBranch), { target: { value: 'develop' } });
  fireEvent.click(screen.getByRole('checkbox', { name: en.publishAcknowledgment }));
  fireEvent.click(publish);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/projects/p/deliveries', { revisionId: 'r', remoteUrl: 'git@example.com:org/repo.git', baseBranch: 'develop', expectedLineVersion: 7 }));
});

it('offers delivery of the selected line even when it is not on the first revision page', async () => {
  const newest = { ...revision, id: 'r-newest', purpose: 'snapshot', fileCount: 0 };
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('/revisions?summary=1') ? { revisions: [newest], nextCursor: 'r-newest' } : path.endsWith('/deliveries') ? { deliveries: [] } : path.endsWith('/revisions/r-old?summary=1') ? { ...newest, id: 'r-old' } : { ...project, lineRevisionId: 'r-old', lineVersion: 3 }));
  await mount(<DeliveryView />);
  expect(await screen.findByRole('button', { name: en.publish })).toBeVisible();
  expect(screen.queryByText(en.deliveryUnavailable)).not.toBeInTheDocument();
});

it('pages older revisions behind the newest page and opens a deep-linked revision outside it', async () => {
  const newest = { ...revision, id: 'r-newest', message: 'Newest snapshot', purpose: 'snapshot', fileCount: 0 };
  const older = { ...revision, id: 'r-old', message: 'Older snapshot', purpose: 'snapshot', fileCount: 0 };
  mocks.location.revisionId = 'r-old';
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/revisions?summary=1') ? { revisions: [newest], nextCursor: 'r-newest' } : path.endsWith('/revisions?summary=1&afterId=r-newest') ? { revisions: [older] } : path.endsWith('/revisions/r-old?summary=1') ? older : path.endsWith('/revisions/r-old') ? { ...revision, ...older, files: [] } : project));
  await mount(<RevisionsView />);
  expect(await screen.findByText('Newest snapshot')).toBeVisible();
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/projects/p/revisions/r-old', expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button', { name: en.loadMoreRevisions }));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/projects/p/revisions?summary=1&afterId=r-newest', expect.any(AbortSignal)));
  expect(await screen.findByRole('button', { name: /Older snapshot/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: en.loadMoreRevisions })).not.toBeInTheDocument();
});

it('switches application copy to Russian while preserving private draft content', async () => {
  mocks.location.documentId = undefined;
  const { i18n } = await mount(<DocumentsView />);
  fireEvent.click(await screen.findByText(en.importDocument));
  fireEvent.change(screen.getByLabelText(en.markdownSource), { target: { value: '# User content stays exact' } });
  await i18n.changeLanguage('ru');
  expect(await screen.findByText(ru.importDocument)).toBeVisible();
  expect(screen.getByLabelText(ru.markdownSource)).toHaveValue('# User content stays exact');
});

it('keeps complete matching Russian and English context catalogs', () => {
  expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  expect(Object.values(ru).every(value => value.trim().length > 0)).toBe(true);
});

it('loads cursor pages without duplicate events', async () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ sequence: i + 1, projectId: 'p', type: 'flow-created', actorId: 'agent:connector', entityId: `flow-${i}`, createdAt: '2026-10-26T00:00:00Z' }));
  mocks.get.mockImplementation((path: string) => {
    if (path.endsWith('/flows')) return Promise.resolve({flows: [{id:'flow-501',title:'Follow-up flow'}]});
    if (path.endsWith('/documents')) return Promise.resolve({documents: []});
    return Promise.resolve(path.endsWith('after=0') ? { events, cursor: 500 } : { events: [{ ...events[499], sequence: 501, entityId: 'flow-501' }], cursor: 501 });
  });
  await mount(<HistoryView />);
  fireEvent.click(await screen.findByRole('button', { name: en.loadMore }));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/projects/p/events?after=500', expect.any(AbortSignal)));
  expect(await screen.findByRole('button', {name:'Follow-up flow'})).toBeVisible();
  // The recorded actor stays visible outside the collapsed Identifiers block, even without an actorRole.
  const actors = screen.getAllByText(/^Actor:/);
  expect(actors.length).toBeGreaterThan(0);
  for (const actor of actors) { expect(actor).toHaveTextContent('Actor: agent:connector'); expect(actor).not.toHaveTextContent(en.unknownRole); }
});

it('tells apart different actors who share a role in History', async () => {
  const base = { projectId: 'p', type: 'flow-created', entityId: 'x', createdAt: '2026-10-26T00:00:00Z', actorRole: 'operator' };
  const events = [{ ...base, sequence: 1, actorId: 'human:alice' }, { ...base, sequence: 2, actorId: 'human:bob' }];
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/flows') ? { flows: [] } : path.endsWith('/documents') ? { documents: [] } : { events, cursor: 2 }));
  await mount(<HistoryView />);
  expect(await screen.findByText('Actor: human:alice')).toBeVisible();
  expect(screen.getByText('Actor: human:bob')).toBeVisible();
});

it('lets History flow titles and document paths break instead of widening the panel', async () => {
  const longPath = 'docs/requirements/' + 'a-very-long-unbreakable-document-name-'.repeat(2) + 'end.md';
  const base = { projectId: 'p', type: 'document-imported', actorId: 'human:alice', createdAt: '2026-10-26T00:00:00Z' };
  const events = [{ ...base, sequence: 1, entityId: 'doc-1' }, { ...base, sequence: 2, entityId: 'flow-1' }];
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/flows') ? { flows: [{ id: 'flow-1', title: 'Flow-title-without-any-break-opportunity' }] } : path.endsWith('/documents') ? { documents: [{ id: 'doc-1', path: longPath }] } : { events, cursor: 2 }));
  await mount(<HistoryView />);
  for (const name of [longPath, 'Flow-title-without-any-break-opportunity']) {
    const button = await screen.findByRole('button', { name });
    expect(button.className).toContain('max-w-full');
    expect(within(button).getByText(name).className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'break-all']));
  }
});

it('does not re-derive History events when only the type filter changes', async () => {
  const events = [{ sequence: 1, projectId: 'p', type: 'flow-created', actorId: 'a', entityId: 'x', createdAt: '2026-10-26T00:00:00Z' }, { sequence: 2, projectId: 'p', type: 'document-imported', actorId: 'a', entityId: 'y', createdAt: '2026-10-26T00:00:00Z' }];
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/flows') ? { flows: [] } : path.endsWith('/documents') ? { documents: [] } : { events, cursor: 2 }));
  await mount(<HistoryView />);
  const select = await screen.findByLabelText(en.historyEventType);
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  await new Promise(resolve => setTimeout(resolve, 20));
  const before = vi.mocked(mergeEvents).mock.calls.length;
  fireEvent.change(select, { target: { value: 'flow-created' } });
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
  expect(vi.mocked(mergeEvents).mock.calls.length).toBe(before);
});

it('loads revision metadata without full trees and fetches only the selected immutable revision', async () => {
  mocks.location.revisionId = '';
  const { client, i18n, rerender } = await mount(<RevisionsView />);
  expect(await screen.findByText(revision.message)).toBeVisible();
  expect(mocks.get).toHaveBeenCalledWith('/projects/p/revisions?summary=1', expect.any(AbortSignal));
  expect(mocks.get.mock.calls.some(([path]) => /\/revisions\/[^?]+$/.test(path))).toBe(false);
  mocks.location.revisionId = 'r';
  rerender(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RevisionsView /></QueryClientProvider></I18nextProvider>);
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/projects/p/revisions/r', expect.any(AbortSignal)));
  expect(mocks.get.mock.calls.filter(([path]) => path === '/projects/p/revisions/r')).toHaveLength(1);
  expect(mocks.get.mock.calls.some(([path]) => path === '/projects/p/revisions')).toBe(false);
});

it('keeps a newer import draft after leaving, reopening and receiving the earlier success', async () => {
  mocks.location.documentId = undefined;
  let resolve!: (value: unknown) => void;
  mocks.post.mockImplementation(() => new Promise(done => { resolve = done; }));
  const mounted = await mount(<DocumentsView />);
  fireEvent.click(await screen.findByText(en.importDocument));
  fireEvent.change(screen.getByLabelText(en.path), { target: { value: 'specs/a.md' } });
  fireEvent.change(screen.getByLabelText(new RegExp(en.sourceRevision)), { target: { value: 'manual:a' } });
  fireEvent.change(screen.getByLabelText(en.markdownSource), { target: { value: '# Submitted A' } });
  fireEvent.click(screen.getByRole('button', { name: en.import }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  mounted.unmount();
  await mount(<DocumentsView />);
  fireEvent.click(await screen.findByText(en.importDocument));
  fireEvent.change(screen.getByLabelText(en.markdownSource), { target: { value: '# New unsent B' } });
  resolve({ documents: [document], proposals: [] });
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0));
  expect(screen.getByLabelText(en.markdownSource)).toHaveValue('# New unsent B');
});
