import { act,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,describe,expect,test,vi } from 'vitest';
import '../src/i18n';
import i18n from '../src/i18n';
import { App,queryClient } from '../src/app/App';
import { resetClient,setAuthLossHandler } from '../src/api/client';
import { navigate } from '../src/app/navigation';
import { useDraftStore } from '../src/state/drafts';
const principal={id:'cloudflare:owner',kind:'human',role:'operator',email:'owner@example.test',issuer:'https://team.cloudflareaccess.com',subject:'owner-subject'};
function reply(value:unknown,status=200){return Response.json(value,{status});}
const unauthorized=()=>reply({error:{code:'unauthorized',message:'No session'}},401);
function authenticated(url:string){if(url.endsWith('/session'))return reply({principal});if(url.endsWith('/projects'))return reply({projects:[]});return reply({});}
async function locale(language:string){await act(()=>i18n.changeLanguage(language));}
beforeEach(async()=>{vi.restoreAllMocks();setAuthLossHandler(()=>undefined);resetClient();queryClient.clear();useDraftStore.getState().clearAll();navigate({projectId:null,tab:'overview'},true);await locale('en');});
describe('React authentication and locale',()=>{
 test('SSO exchanges once and renders verified identity without token input',async()=>{
  let exchanges=0;vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const path=String(input);if(path.endsWith('/session')&&init?.method==='GET')return unauthorized();if(path.endsWith('/auth/config'))return reply({cloudflareAccessEnabled:true});if(path.endsWith('/session/cloudflare')){exchanges++;return reply({principal});}return authenticated(path);});
  render(<App/>);expect(await screen.findByText(principal.email)).toBeInTheDocument();expect(exchanges).toBe(1);expect(screen.queryByLabelText('Human access token')).not.toBeInTheDocument();
 });
 test('disabled SSO keeps token sign in and never persists the entered token',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const path=String(input);if(path.endsWith('/session'))return init?.method==='POST'?reply({principal}):unauthorized();if(path.endsWith('/auth/config'))return reply({cloudflareAccessEnabled:false});return authenticated(path);});
  render(<App/>);fireEvent.change(await screen.findByLabelText('Human access token'),{target:{value:'secret-for-test'}});fireEvent.click(screen.getByRole('button',{name:'Sign in'}));expect(await screen.findByText(principal.email)).toBeInTheDocument();expect(JSON.stringify({...localStorage})).not.toContain('secret-for-test');
 });
 test('failed SSO waits for explicit retry, then can recover',async()=>{
  let allowed=false,exchanges=0;vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{const path=String(input);if(path.endsWith('/session'))return unauthorized();if(path.endsWith('/auth/config'))return reply({cloudflareAccessEnabled:true});if(path.endsWith('/session/cloudflare')){exchanges++;return allowed?reply({principal}):reply({error:{code:'access-denied',message:'No'}},403);}return authenticated(path);});
  render(<App/>);expect(await screen.findByRole('alert')).toHaveTextContent('no longer has access');expect(exchanges).toBe(1);allowed=true;fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(await screen.findByText(principal.email)).toBeInTheDocument();expect(exchanges).toBe(2);
 });
 test('revocation clears identity and private drafts on Refresh',async()=>{
  let revoked=false;vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>String(input).endsWith('/session')&&revoked?reply({error:{code:'access-denied',message:'Denied'}},403):authenticated(String(input)));
  render(<App/>);await screen.findByText(principal.email);useDraftStore.getState().put('private',{secret:'draft'});revoked=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await waitFor(()=>expect(screen.queryByText(principal.email)).not.toBeInTheDocument());expect(useDraftStore.getState().drafts).toEqual({});expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
 });
 test('ordinary permission error preserves identity',async()=>{
  let denied=false;vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>String(input).endsWith('/session')&&denied?reply({error:{code:'human-required',message:'Denied'}},403):authenticated(String(input)));
  render(<App/>);await screen.findByText(principal.email);denied=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await screen.findByRole('alert');expect(screen.getByText(principal.email)).toBeInTheDocument();
 });
 test('language changes labels without altering identity or private draft',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>authenticated(String(input)));render(<App/>);await screen.findByText(principal.email);useDraftStore.getState().put('draft',{content:'Original user content'});fireEvent.click(screen.getAllByRole('button',{name:'RU'})[0]!);expect(await screen.findByText('Подтверждённая учётная запись')).toBeInTheDocument();expect(document.documentElement.lang).toBe('ru');expect(useDraftStore.getState().drafts.draft).toEqual({content:'Original user content'});
 });
 test('legacy shared token principal is not presented as a verified personal identity',async()=>{
  const legacy={id:'human:operator',kind:'human',role:'operator'};vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>String(input).endsWith('/session')?reply({principal:legacy}):authenticated(String(input)));
  render(<App/>);expect(await screen.findByText('human:operator')).toBeInTheDocument();expect(screen.getByText('Token access · shared principal')).toBeInTheDocument();expect(screen.queryByText('Verified identity')).not.toBeInTheDocument();
 });
 test('project selector has an exact label without project option names',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>String(input).endsWith('/projects')?reply({projects:[{id:'alpha',name:'Alpha project'},{id:'beta',name:'Beta project'}]}):authenticated(String(input)));
  render(<App/>);await screen.findByText(principal.email);const select=screen.getByLabelText('Project',{exact:true});expect(select).toHaveAccessibleName('Project');expect((select as HTMLSelectElement).labels?.[0]?.textContent).toBe('Project');expect(screen.getByRole('button',{name:'Refresh'})).toHaveAttribute('aria-label','Refresh');
 });
 test('unsafe logout URL clears session but never navigates to external destination',async()=>{
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>init?.method==='DELETE'?reply({ok:true,logoutUrl:'https://evil.example/'}):authenticated(String(input)));render(<App/>);await screen.findByText(principal.email);fireEvent.click(screen.getByRole('button',{name:'Sign out'}));await waitFor(()=>expect(screen.queryByText(principal.email)).not.toBeInTheDocument());expect(window.location.hostname).not.toBe('evil.example');
 });
});
