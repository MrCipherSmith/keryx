import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../src/i18n/workflow.en';
import ru from '../src/i18n/workflow.ru';
import { GlobalFlowsView } from '../src/features/global-flows';
const fixture = vi.hoisted(() => ({ get: vi.fn(), navigate: vi.fn(), scopeKey: 4 }));
vi.mock('../src/app/hub-context', () => ({ useHub: () => ({ scopeKey: fixture.scopeKey, navigate: fixture.navigate }) }));
vi.mock('../src/api/client', () => ({ getJson: (...args: unknown[]) => fixture.get(...args), errorMessage: () => 'Request failed' }));
const flow = { id: 'shared', projectId: 'atlas', title: 'Atlas navigation', status: 'done', version: 2, criteria: ['Keyboard', 'Focus'], specContentDigest: 'abc123' };
async function mount() {
 const i18n = createInstance();
 await i18n.init({ lng: 'en', resources: { en: { workflow: en, common: { status: { done: 'Done', 'in-progress': 'Working' } } }, ru: { workflow: ru } }, interpolation: { escapeValue: false } });
 const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
 render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GlobalFlowsView /></QueryClientProvider></I18nextProvider>);
 return client;
}
beforeEach(() => {
 fixture.get.mockReset(); fixture.navigate.mockReset();
 fixture.get.mockImplementation(async (path: string) => path === '/projects' ? { projects: [{ id: 'atlas', name: 'Atlas' }, { id: 'beacon', name: 'Beacon' }] } : path === '/projects/atlas/flows' ? { flows: [flow] } : { flows: [{ ...flow, projectId: 'beacon', title: 'Beacon context', status: 'in-progress', acceptedBy: 'human:maya', acceptedAt: '2026-10-31T12:00:00Z' }] });
});
it('opens the exact project Flow and keeps acceptance independent of status and criteria count', async () => {
 const client = await mount();
 const atlas = await screen.findByRole('button', { name: 'Atlas navigation' });
 expect(within(atlas.closest('[role="row"]')!).getByText('Not accepted yet')).toBeVisible();
 expect(within(atlas.closest('[role="row"]')!).getByText('2 criteria')).toBeVisible();
 expect(within(atlas.closest('[role="row"]')!).getByText('Criterion coverage is not reported')).toBeVisible();
 const beacon = await screen.findByRole('button', { name: 'Beacon context' });
 expect(within(beacon.closest('[role="row"]')!).getByText('Accepted by: human:maya')).toBeVisible();
 fireEvent.click(beacon);
 expect(fixture.navigate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'beacon', flowId: 'shared', tab: 'flows' }));
 expect(client.getQueryData([4, 'beacon', 'flows'])).toBeTruthy();
});
it('retains successful projects when one project fails and retries only that project', async () => {
 fixture.get.mockImplementation(async (path: string) => path === '/projects' ? { projects: [{ id: 'atlas', name: 'Atlas' }, { id: 'beacon', name: 'Beacon' }] } : path === '/projects/atlas/flows' ? { flows: [flow] } : Promise.reject(new Error('unavailable')));
 await mount();
 expect(await screen.findByRole('button', { name: 'Atlas navigation' })).toBeVisible();
 expect(await screen.findByRole('alert')).toHaveTextContent('Beacon');
 const before = fixture.get.mock.calls.filter(([path]) => path === '/projects/atlas/flows').length;
 fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
 await waitFor(() => expect(fixture.get.mock.calls.filter(([path]) => path === '/projects/beacon/flows').length).toBe(2));
 expect(fixture.get.mock.calls.filter(([path]) => path === '/projects/atlas/flows').length).toBe(before);
});
it('filters the authorized project results by project and exact status', async () => {
 await mount();
 await screen.findByRole('button', { name: 'Beacon context' });
 fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Beacon' } });
 expect(screen.queryByRole('button', { name: 'Atlas navigation' })).toBeNull();
 expect(screen.getByRole('button', { name: 'Beacon context' })).toBeVisible();
 fireEvent.change(screen.getByLabelText('State'), { target: { value: 'done' } });
 expect(screen.queryByRole('button', { name: 'Beacon context' })).toBeNull();
 expect(screen.getByText('No Flows match this view.')).toBeVisible();
});
