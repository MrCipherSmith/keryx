import { act,render,screen } from '@testing-library/react';
import { beforeEach,expect,test } from 'vitest';
import { navigate,useLocation } from '../src/app/navigation';
function Probe(){const route=useLocation();return <output>{JSON.stringify(route)}</output>;}
beforeEach(()=>navigate({projectId:null,tab:'overview',documentId:undefined,flowId:undefined,revisionId:undefined},true));
test('query parameters preserve project/entity and browser navigation updates the view',()=>{render(<Probe/>);act(()=>navigate({projectId:'p1',tab:'flows',flowId:'f1'}));expect(window.location.search).toContain('project=p1');expect(window.location.search).toContain('flow=f1');expect(screen.getByRole('status')).toHaveTextContent('f1');act(()=>{window.history.replaceState({},'','/?project=p2&view=documents&document=d2');window.dispatchEvent(new PopStateEvent('popstate'));});expect(screen.getByRole('status')).toHaveTextContent('p2');expect(screen.getByRole('status')).toHaveTextContent('d2');});
test('changing projects clears the previous selected entity',()=>{act(()=>navigate({projectId:'p1',tab:'flows'}));act(()=>navigate({flowId:'f1'}));act(()=>navigate({projectId:'p2'}));expect(window.location.search).not.toContain('f1');});
