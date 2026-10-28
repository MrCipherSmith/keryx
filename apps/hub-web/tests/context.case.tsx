import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/context.en';
import { useDraftStore } from '../src/state/drafts';
import ru from '../src/i18n/context.ru';
import { DocumentsView, ProposalsView, RevisionsView, DeliveryView, HistoryView } from '../src/features/context';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), navigate: vi.fn(), location: { projectId: 'p', tab: 'documents', documentId: 'd', revisionId: 'r' }, principal: { id: 'human:owner', kind: 'human', role: 'operator' } }));
vi.mock('../src/app/hub-context', () => ({ useHub: () => ({ projectId: 'p', principal: mocks.principal, scopeKey: 1, location: mocks.location, navigate: mocks.navigate, refresh: vi.fn() }) }));
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

it('switches application copy to Russian while preserving private draft content', async () => {
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
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('after=0') ? { events, cursor: 500 } : { events: [{ ...events[499], sequence: 501, entityId: 'flow-501' }], cursor: 501 }));
  await mount(<HistoryView />);
  fireEvent.click(await screen.findByRole('button', { name: en.loadMore }));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/projects/p/events?after=500', expect.any(AbortSignal)));
  expect(await screen.findByText('flow-501')).toBeVisible();
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
