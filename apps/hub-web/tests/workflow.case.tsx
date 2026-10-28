import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../src/i18n/workflow.en';
import ru from '../src/i18n/workflow.ru';
import { FlowsView, ProjectsView, OverviewView } from '../src/features/workflow';
import { useDraftStore } from '../src/state/drafts';

const fixture = vi.hoisted(() => ({
  hub: { projectId: 'p', principal: { id: 'human:owner', kind: 'human', role: 'operator' }, scopeKey: 1, location: { projectId: 'p', tab: 'flows', flowId: undefined as string | undefined }, navigate: vi.fn(), refresh: vi.fn() },
  get: vi.fn(), post: vi.fn(),
}));
vi.mock('../src/app/hub-context', () => ({ useHub: () => fixture.hub }));
vi.mock('../src/api/client', () => ({
  getJson: (...args: unknown[]) => fixture.get(...args), postJson: (...args: unknown[]) => fixture.post(...args),
}));
const flow = { id: 'f', projectId: 'p', title: 'Exact candidate', status: 'in-progress', version: 3, criteria: ['Keep the exact subject'], specDocumentId: 's', specContentDigest: 'abc', subjectRevisionId: null };
const spec = { id: 's', projectId: 'p', path: 'specs/real.md', kind: 'spec', contentDigest: 'abc', version: 1, approval: 'unreviewed', content: '# Source', sourceRevision: 'manual:v1' };
const revision = { id: 'r', projectId: 'p', message: 'Candidate', purpose: 'review-bundle', files: [] };

async function mount(view: React.ReactNode) {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { workflow: en, common: { loading: 'Loading', retry: 'Retry', 'status.implemented': 'For review' } }, ru: { workflow: ru } }, interpolation: { escapeValue: false } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}>{view}</QueryClientProvider></I18nextProvider>);
  return { client, i18n, ...rendered };
}

beforeEach(() => {
  useDraftStore.getState().clearAll();
  fixture.hub.projectId = 'p'; fixture.hub.principal.kind = 'human'; fixture.hub.location.flowId = undefined;
  fixture.hub.navigate.mockReset(); fixture.hub.refresh.mockReset(); fixture.post.mockReset(); fixture.get.mockReset();
  fixture.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/proposals')) return { proposals: [] };
    if (path.endsWith('/documents')) return { documents: [spec] };
    if (path.endsWith('/flows')) return { flows: [flow] };
    if (path.endsWith('/flows/f')) return flow;
    if (path.endsWith('/evidence')) return { evidence: [] };
    if (path.endsWith('/revisions?summary=1')) return { revisions: [(({ files, ...metadata }) => ({ ...metadata, fileCount: files.length }))(revision)] };
    if (path === '/projects') return { projects: [] };
    return { id: 'p', name: 'Project', lineVersion: 0, lineRevisionId: null };
  });
});
afterEach(cleanup);

describe('workflow screens preserve exact Hub operations', () => {
  it('creates a Flow with the selected actual spec and separate criterion lines', async () => {
    fixture.post.mockResolvedValue({ ...flow, id: 'new-flow' });
    await mount(<FlowsView />);
    fireEvent.click(await screen.findByText('Create Flow'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A real change' } });
    fireEvent.change(screen.getByLabelText('Specification'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'First criterion\n\n Second criterion ' } });
    expect(screen.getAllByText('specs/real.md').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Create Flow' }));
    await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/projects/p/flows', { title: 'A real change', specDocumentId: 's', criteria: ['First criterion', 'Second criterion'] }));
    expect(fixture.hub.navigate).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'new-flow' }));
  });

  it('pins an edited submit draft version across background updates and preserves it after 409', async () => {
    fixture.hub.location.flowId = 'f';
    fixture.post.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409, code: 'version-conflict' }));
    const { client } = await mount(<FlowsView />);
    fireEvent.change(await screen.findByLabelText('Candidate revision'), { target: { value: 'r' } });
    client.setQueryData([1, 'p', 'flow', 'f'], { ...flow, version: 9 });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/projects/p/flows/f/submit-for-review', { expectedVersion: 3, subjectRevisionId: 'r' }));
    expect(screen.getByLabelText('Candidate revision')).toHaveValue('r');
    expect(await screen.findByText(en.conflict)).toBeVisible();
  });

  it('requires fresh explicit human acknowledgment for the exact accepted subject', async () => {
    fixture.hub.location.flowId = 'f';
    fixture.get.mockImplementation(async (path: string) => path.endsWith('/flows/f') ? { ...flow, status: 'implemented', version: 4, subjectRevisionId: 'r' } : path.endsWith('/evidence') ? { evidence: [] } : path.endsWith('/documents') ? { documents: [spec] } : path.endsWith('/revisions?summary=1') ? { revisions: [(({ files, ...metadata }) => ({ ...metadata, fileCount: files.length }))(revision)] } : { flows: [flow] });
    fixture.post.mockResolvedValue({ ...flow, status: 'done' });
    await mount(<FlowsView />);
    const button = await screen.findByRole('button', { name: 'Accept exact revision & finish' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/projects/p/flows/f/accept', { expectedVersion: 4, subjectRevisionId: 'r', acknowledgeSelfReportedEvidence: true }));
  });

  it('does not offer human acceptance to an agent', async () => {
    fixture.hub.principal.kind = 'agent'; fixture.hub.location.flowId = 'f';
    fixture.get.mockImplementation(async (path: string) => path.endsWith('/flows/f') ? { ...flow, status: 'implemented', subjectRevisionId: 'r' } : path.endsWith('/evidence') ? { evidence: [] } : path.endsWith('/documents') ? { documents: [spec] } : { flows: [flow] });
    await mount(<FlowsView />);
    expect(await screen.findByText('This decision requires a human principal.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept exact revision & finish' })).toBeNull();
  });

  it('validates project creation before issuing a mutation', async () => {
    await mount(<ProjectsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));
    expect(fixture.post).not.toHaveBeenCalled();
    expect(screen.getByText(en.required)).toBeVisible();
  });

  it('switches application labels to Russian while preserving user-entered criteria', async () => {
    const { i18n } = await mount(<FlowsView />);
    fireEvent.click(await screen.findByText('Create Flow'));
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'User content must stay exactly as written.' } });
    await i18n.changeLanguage('ru');
    expect(await screen.findByLabelText('Критерии приёмки')).toHaveValue('User content must stay exactly as written.');
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it('attaches Evidence to a review bundle without changing or publishing the candidate', async () => {
    fixture.hub.location.flowId = 'f';
    fixture.post.mockResolvedValue({ id: 'e', subjectRevisionId: 'r' });
    await mount(<FlowsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add self-reported check' }));
    fireEvent.change(screen.getByLabelText('Evidence subject revision'), { target: { value: 'r' } });
    fireEvent.change(screen.getByLabelText('Check identifier'), { target: { value: 'unit-tests' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'bun test' } });
    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'Проверка <script>unsafe()</script>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/projects/p/flows/f/evidence', { subjectRevisionId: 'r', checkId: 'unit-tests', command: 'bun test', exitCode: 0, output: 'Проверка <script>unsafe()</script>' }));
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });
});


it('does not navigate when a project POST completes after the create view unmounts', async () => {
  let resolve!: (value: unknown) => void;
  fixture.post.mockImplementation(() => new Promise(done => { resolve = done; }));
  const mounted = await mount(<ProjectsView />);
  fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: 'Late project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
  await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
  mounted.unmount();
  resolve({ id: 'late', name: 'Late project' });
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0));
  expect(fixture.hub.navigate).not.toHaveBeenCalled();
});

it('does not navigate to a completed old Flow after switching projects', async () => {
  let resolve!: (value: unknown) => void;
  fixture.post.mockImplementation(() => new Promise(done => { resolve = done; }));
  const mounted = await mount(<FlowsView />);
  fireEvent.click(await screen.findByText('Create Flow'));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Old context' } });
  fireEvent.change(screen.getByLabelText('Specification'), { target: { value: 's' } });
  fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Exact criteria' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Flow' }));
  await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
  fixture.hub.projectId = 'other';
  mounted.rerender(<I18nextProvider i18n={mounted.i18n}><QueryClientProvider client={mounted.client}><FlowsView /></QueryClientProvider></I18nextProvider>);
  resolve({ ...flow, id: 'late' });
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0));
  expect(fixture.hub.navigate).not.toHaveBeenCalled();
});


it('uses metadata-only revisions for overview counts without loading a code tree', async () => {
  await mount(<OverviewView />);
  expect(await screen.findByText(en.integrationTitle)).toBeVisible();
  expect(fixture.get).toHaveBeenCalledWith('/projects/p/revisions?summary=1', expect.any(AbortSignal));
  expect(fixture.get.mock.calls.some(([path]) => path === '/projects/p/revisions' || /\/revisions\//.test(path))).toBe(false);
});

it('keeps a newer Flow draft when an earlier submission succeeds', async () => {
  let resolve!: (value: unknown) => void;
  fixture.post.mockImplementation(() => new Promise(done => { resolve = done; }));
  const mounted = await mount(<FlowsView />);
  fireEvent.click(await screen.findByText('Create Flow'));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Submitted A' } });
  fireEvent.change(screen.getByLabelText('Specification'), { target: { value: 's' } });
  fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Criteria A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Flow' }));
  await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New unsent B' } });
  resolve({ ...flow, id: 'created' });
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0));
  expect(screen.getByLabelText('Title')).toHaveValue('New unsent B');
  expect(fixture.hub.navigate).not.toHaveBeenCalled();
});
