import { useState } from 'react';
import { act,fireEvent,render,screen } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { HubContext,type HubContextValue } from '../src/app/hub-context';
import { useController } from '../src/features/remote/shared';
import { MessageComposer } from '../src/features/remote/work';
import { resetClient } from '../src/api/client';
import { useDraftStore } from '../src/state/drafts';
import i18n from '../src/i18n';
import type { Control } from '../src/api/remote';
import { sessionFixture } from './remote-fixtures';
let sessionEvents:Control['SessionEvent'][]=[];let projection=structuredClone(sessionFixture);let update:(r:Control['SessionRecord'])=>void=()=>undefined;const sent:Record<string,unknown>[]=[];
const sendKeys: (string | null)[] = [];
let messageResponse: () => Response | Promise<Response>;
const context:HubContextValue={projectId:'p',principal:{id:'human:test',kind:'human',role:'operator'},scopeKey:1,location:{projectId:'p',tab:'sessions'},navigate:()=>undefined,refresh:async()=>undefined};
function Probe(){const[record,setRecord]=useState(projection);update=setRecord;const control=useController(record);return <><button onClick={control.claim}>claim</button><MessageComposer record={record} control={control}/></>;}
beforeEach(async () => {
  resetClient();
  useDraftStore.getState().clearAll();
  sessionEvents = [];
  projection = structuredClone(sessionFixture);
  projection.controller!.expiresAt = new Date(Date.now() + 60000).toISOString();
  sent.length = 0;
  sendKeys.length = 0;
  messageResponse = () => turnReceipt('queued');
  await i18n.changeLanguage('en');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/chat-consent')) return Response.json({ profileConsentVersion: 1 });
    if (path.endsWith('/flows')) return Response.json({ flows: [] });
    if (path.endsWith('/controller/claim')) return Response.json({ receiptId: 'claim', sessionVersion: projection.version, lease: projection.controller });
    if (path.endsWith('/controller/renew')) {
      const prior = projection;
      projection = { ...projection, version: projection.version + 1, sessionEventCursor: projection.sessionEventCursor + 2,
        controller: { ...projection.controller!, expiresAt: new Date(Date.now() + 60000).toISOString() } };
      const receipt = { receiptId: 'renew-' + projection.version, sessionVersion: projection.version, lease: projection.controller! };
      sessionEvents.push(
        { sessionId: 's', projectId: 'p', checkoutId: 'c', sessionEventSeq: prior.sessionEventCursor + 1, observedAt: new Date().toISOString(), kind: 'controller-changed', receipt },
        { sessionId: 's', projectId: 'p', checkoutId: 'c', sessionEventSeq: prior.sessionEventCursor + 2, observedAt: new Date().toISOString(), kind: 'session-state', session: { ...projection, sessionEventCursor: prior.sessionEventCursor + 1 } },
      );
      update(projection);
      return Response.json(receipt);
    }
    if (path.includes('/events?after=')) {
      const after = Number(path.split('after=')[1]);
      return Response.json({ events: sessionEvents.filter(event => event.sessionEventSeq > after), cursor: projection.sessionEventCursor, hasMore: false, retainedFromCursor: 0, gap: false });
    }
    if (path.endsWith('/sessions/s')) return Response.json(projection);
    if (path.endsWith('/messages')) {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      sendKeys.push(new Headers(init?.headers).get('Idempotency-Key'));
      return messageResponse();
    }
    return Response.json({});
  });
});
afterEach(()=>vi.useRealTimers());
function renderProbe(value = context) {
  return render(<QueryClientProvider client={new QueryClient()}><HubContext.Provider value={value}><Probe/></HubContext.Provider></QueryClientProvider>);
}
async function setup(){vi.useFakeTimers();const view=renderProbe();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'claim'}));await vi.advanceTimersByTimeAsync(100);});fireEvent.change(screen.getByLabelText('Message'),{target:{value:'A long draft stays intact'}});fireEvent.change(screen.getByLabelText('Work mode'),{target:{value:'ad-hoc'}});fireEvent.click(screen.getByLabelText('Send messages in this session without a Flow.'));return view;}
test('long draft survives two own renewals without manual rebase and submits fresh exact version',async()=>{await setup();for(let i=0;i<42;i++)await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(screen.getByLabelText('Message')).toHaveValue('A long draft stays intact');expect(screen.getByRole('button',{name:'Send message'})).toBeEnabled();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Send message'}));await vi.advanceTimersByTimeAsync(50);});expect(sent[0]?.expectedSessionVersion).toBe(projection.version);expect(projection.version).toBeGreaterThanOrEqual(5);});
test('foreign configuration change still requires explicit rebase and preserves text',async()=>{await setup();await act(async()=>{projection={...projection,version:projection.version+1,config:{...projection.config,configVersion:2}};update(projection);await vi.advanceTimersByTimeAsync(21000);});expect(screen.getByLabelText('Message')).toHaveValue('A long draft stays intact');expect(screen.getByRole('button',{name:'Send message'})).toBeDisabled();expect(screen.getByRole('button',{name:'Use current versions'})).toBeVisible();expect(sent).toHaveLength(0);});

function turnReceipt(status: 'admitted' | 'queued', sessionVersion = projection.version) {
  return Response.json({ operationId: 'message-op', messageId: 'human-message', sessionId: 's', sessionVersion,
    queueItemId: null, status, runId: status === 'admitted' ? 'run' : null,
    turnId: status === 'admitted' ? 'turn' : null, turnOrdinal: status === 'admitted' ? 1 : null } satisfies Control['TurnReceipt']);
}

function publishProjection(change: Partial<Control['SessionRecord']>) {
  projection = { ...projection, ...change, sessionEventCursor: projection.sessionEventCursor + 1 };
  sessionEvents.push({ sessionId: 's', projectId: 'p', checkoutId: 'c', sessionEventSeq: projection.sessionEventCursor,
    observedAt: new Date().toISOString(), kind: 'session-state', session: projection });
  update(projection);
}

async function settleProjection(change: Partial<Control['SessionRecord']>) {
  act(() => publishProjection(change));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

async function sendMessage() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await vi.advanceTimersByTimeAsync(50);
  });
}

test('a draft typed during its preceding turn sends after that turn completes', async () => {
  await setup();
  const base = projection.version;
  messageResponse = () => turnReceipt('admitted', base);
  await sendMessage();
  expect(sent[0]).toMatchObject({ expectedSessionVersion: base, text: 'A long draft stays intact' });
  expect(screen.getByLabelText('Message')).toHaveValue('');

  await settleProjection({ state: 'busy', version: base + 1, activeRunId: 'run', activeTurnId: 'turn', nextTurnOrdinal: 2 });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Follow-up while the first turn runs' } });
  await settleProjection({ state: 'idle', version: base + 2, activeRunId: null, activeTurnId: null });

  expect(screen.getByLabelText('Message')).toHaveValue('Follow-up while the first turn runs');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Use current versions' })).not.toBeInTheDocument();
  messageResponse = () => turnReceipt('queued');
  await sendMessage();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ expectedSessionVersion: base + 2, text: 'Follow-up while the first turn runs', association: sent[0].association });
});

test('a draft survives an exact controller renewal during its preceding turn', async () => {
  await setup();
  const base = projection.version;
  messageResponse = () => turnReceipt('admitted', base);
  await sendMessage();
  await settleProjection({ state: 'busy', version: base + 1, activeRunId: 'run', activeTurnId: 'turn', nextTurnOrdinal: 2 });
  const field = screen.getByLabelText('Message');
  fireEvent.change(field, { target: { value: 'Follow-up during a long response' } });

  for (let second = 0; second < 22; second++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  }
  expect(projection.version).toBe(base + 2);
  expect(screen.queryByRole('button', { name: 'Use current versions' })).not.toBeInTheDocument();
  await settleProjection({ state: 'idle', version: base + 3, activeRunId: null, activeTurnId: null });

  expect(field).toHaveValue('Follow-up during a long response');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  messageResponse = () => turnReceipt('queued');
  await sendMessage();
  expect(sent[1]).toMatchObject({ expectedSessionVersion: base + 3, text: 'Follow-up during a long response' });
});

test('another run at the same ordinal leaves the draft for explicit review', async () => {
  await setup();
  const base = projection.version;
  messageResponse = () => turnReceipt('admitted', base);
  await sendMessage();
  await settleProjection({ state: 'busy', version: base + 1, activeRunId: 'other-run', activeTurnId: 'other-turn', nextTurnOrdinal: 2 });
  const field = screen.getByLabelText('Message');
  fireEvent.change(field, { target: { value: 'Draft during another run' } });
  await settleProjection({ state: 'idle', version: base + 2, activeRunId: null, activeTurnId: null });

  expect(field).toHaveValue('Draft during another run');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use current versions' })).toBeVisible();
  expect(sent).toHaveLength(1);
});

test('an ambiguous send retries its original request without replacing a newer draft', async () => {
  await setup();
  let loseResponse!: (error: Error) => void;
  messageResponse = () => new Promise((_, reject) => { loseResponse = reject; });
  await sendMessage();
  expect(sent).toHaveLength(1);
  const field = screen.getByLabelText('Message');
  fireEvent.change(field, { target: { value: 'Edited after the original submission' } });
  await act(async () => {
    loseResponse(new TypeError('Connection reset'));
    await vi.advanceTimersByTimeAsync(50);
  });

  expect(field).toHaveValue('Edited after the original submission');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  const retry = screen.getByRole('button', { name: 'Retry original message' });
  messageResponse = () => turnReceipt('queued');
  await act(async () => {
    fireEvent.click(retry);
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sendKeys[0]).toBeTruthy();
  expect(sendKeys[1]).toBe(sendKeys[0]);
  expect(field).toHaveValue('Edited after the original submission');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('reload recovers only the unresolved request and requires an explicit exact replay', async () => {
  const view = await setup();
  messageResponse = async () => { throw new TypeError('Connection reset'); };
  await sendMessage();
  expect(sent).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Unsent text in memory' } });

  view.unmount();
  resetClient();
  useDraftStore.getState().clearAll();
  const otherUser = renderProbe({ ...context, principal: { ...context.principal, id: 'human:other' } });
  expect(screen.getByLabelText('Message')).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Retry original message' })).not.toBeInTheDocument();
  otherUser.unmount();
  const reloaded = renderProbe();
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(screen.getByLabelText('Message')).toHaveValue('A long draft stays intact');
  expect(sent).toHaveLength(1);

  messageResponse = () => turnReceipt('queued');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry original message' }));
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sendKeys[0]).toBeTruthy();
  expect(sendKeys[1]).toBe(sendKeys[0]);
  expect(screen.getByLabelText('Message')).toHaveValue('');

  reloaded.unmount();
  resetClient();
  useDraftStore.getState().clearAll();
  renderProbe();
  expect(screen.queryByRole('button', { name: 'Retry original message' })).not.toBeInTheDocument();
});

test('an incomplete 2xx receipt does not clear the draft or allow a fresh send', async () => {
  await setup();
  messageResponse = () => Response.json({ status: 'queued' });
  await sendMessage();

  expect(sent).toHaveLength(1);
  expect(screen.getByLabelText('Message')).toHaveValue('A long draft stays intact');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retry original message' })).toBeEnabled();
});

function staleResponse() {
  return Response.json({ error: { code: 'stale-version', message: 'Version changed' } }, { status: 409 });
}

test('a stale response during own turn completion retries once at the new exact version', async () => {
  await setup();
  const base = projection.version;
  messageResponse = () => turnReceipt('admitted', base);
  await sendMessage();
  await settleProjection({ state: 'busy', version: base + 1, activeRunId: 'run', activeTurnId: 'turn', nextTurnOrdinal: 2 });
  fireEvent.click(screen.getByText('Message options'));
  fireEvent.change(screen.getByLabelText('When busy'), { target: { value: 'enqueue' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Follow-up across the completion race' } });

  messageResponse = () => {
    if (sent.length === 2) {
      publishProjection({ state: 'idle', version: base + 2, activeRunId: null, activeTurnId: null });
      return staleResponse();
    }
    return turnReceipt('queued');
  };
  await sendMessage();

  expect(sent).toHaveLength(3);
  expect(sent[1]).toMatchObject({ text: 'Follow-up across the completion race', expectedSessionVersion: base + 1, busyPolicy: 'enqueue' });
  expect(sent[2]).toEqual({ ...sent[1], expectedSessionVersion: base + 2 });
  expect(sendKeys[2]).not.toBe(sendKeys[1]);
  expect(screen.getByLabelText('Message')).toHaveValue('');
});

test('a stale response after a config change leaves the draft for explicit review', async () => {
  await setup();
  messageResponse = () => {
    if (sent.length === 1) publishProjection({ version: projection.version + 1, config: { ...projection.config, configVersion: 2 } });
    return staleResponse();
  };
  await sendMessage();

  expect(sent).toHaveLength(1);
  expect(screen.getByLabelText('Message')).toHaveValue('A long draft stays intact');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use current versions' })).toBeVisible();
});
