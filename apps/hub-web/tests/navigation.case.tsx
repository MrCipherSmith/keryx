import { act,render,screen } from '@testing-library/react';
import { beforeEach,expect,test } from 'vitest';
import { navigate,resetNavigation,useLocation } from '../src/app/navigation';
function Probe(){const route=useLocation();return <output>{JSON.stringify(route)}</output>;}
beforeEach(resetNavigation);
test('query parameters preserve project/entity and browser navigation updates the view',()=>{render(<Probe/>);act(()=>navigate({projectId:'p1',tab:'flows',flowId:'f1'}));expect(window.location.search).toContain('project=p1');expect(window.location.search).toContain('flow=f1');expect(screen.getByRole('status')).toHaveTextContent('f1');act(()=>{window.history.replaceState({},'','/?project=p2&view=documents&document=d2');window.dispatchEvent(new PopStateEvent('popstate'));});expect(screen.getByRole('status')).toHaveTextContent('p2');expect(screen.getByRole('status')).toHaveTextContent('d2');});
test('changing projects clears the previous selected entity',()=>{act(()=>navigate({projectId:'p1',tab:'flows'}));act(()=>navigate({flowId:'f1'}));act(()=>navigate({projectId:'p2'}));expect(window.location.search).not.toContain('f1');});

test('a connected shell has a shareable URL and browser history restores the selected chat', () => {
  render(<Probe />);
  act(() => navigate({ projectId: 'p1', tab: 'sessions' }));
  const listUrl = window.location.href;
  act(() => navigate({ liveShellId: 'shell-1' }));
  const chatUrl = window.location.href;
  expect(new URL(chatUrl).searchParams.get('shell')).toBe('shell-1');
  expect(screen.getByRole('status')).toHaveTextContent('"liveShellId":"shell-1"');
  for (const url of [listUrl, chatUrl]) {
    act(() => {
      window.history.replaceState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByRole('status').textContent?.includes('liveShellId')).toBe(url === chatUrl);
  }
  act(() => navigate({ sessionId: 'session-1' }));
  expect(window.location.search).toContain('session=session-1');
  expect(window.location.search).not.toContain('shell=');
  act(() => navigate({ projectId: 'p2' }));
  expect(window.location.search).not.toContain('shell=');
});
