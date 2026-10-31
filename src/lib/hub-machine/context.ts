import path from 'node:path';
import {readContext} from '../../hub/context-sync';
import{HubConnector,type HubBinding}from'../../hub/connector';
import{MachineError}from'./errors';import type{CheckoutMapping}from'./config';import{hubAccessHeaders}from'./access';
/**
 * The machine's sync of one project's shared context into its own keryx-managed cache. It never writes the checkout: a hosted session
 * reads canonical context through hub_context from this cache, and a rewritten tracked index would dirty the owned baseline.
 */
class ExplicitMachineConnector extends HubConnector{
 constructor(private readonly local:CheckoutMapping,private readonly url:string,token:string,cacheRoot:string,accessHeaders:Record<string,string>){super({cwd:local.cwd,token,cacheRoot,checkoutIndex:false,accessHeaders});}
 override async binding():Promise<HubBinding>{return {url:this.url,projectId:this.local.projectId,checkoutId:this.local.checkoutId,tokenEnv:'KERYX_MACHINE_NOT_AN_ENV_TOKEN'};}
 override async status(){return {ok:true as const,connection:{url:this.url,projectId:this.local.projectId,checkoutId:this.local.checkoutId}};}
}
/** One event-driven coordinator per Hub/project, sharing the existing validated incremental sync: every mapped checkout of a project reads the one cache. */
export class MachineContextSync{
 private readonly projects=new Map<string,{connector:ExplicitMachineConnector;revision:number;target:number;cacheDir?:string;running?:Promise<void>}>();
 constructor(options:{hubUrl:string;token:string;cacheRoot:string;mappings:readonly CheckoutMapping[]}){
  const access=hubAccessHeaders(options.hubUrl);
  for(const mapping of options.mappings)if(!this.projects.has(mapping.projectId))this.projects.set(mapping.projectId,{connector:new ExplicitMachineConnector(mapping,options.hubUrl,options.token,options.cacheRoot,access),revision:-1,target:-1});
 }
 async invalidate(projectId:string,revision:number):Promise<void>{
  const project=this.projects.get(projectId);if(!project)throw new MachineError('scope-denied');if(!Number.isSafeInteger(revision)||revision<0)throw new MachineError('invalid-frame');project.target=Math.max(project.target,revision);
  if(project.running)return project.running;if(project.revision>=project.target)return;
  const work=(async()=>{while(project.revision<project.target){const result=await project.connector.sync();project.revision=result.revision;project.cacheDir=result.cacheDir;if(project.revision<project.target)throw new MachineError('stale-reference');}})();
  project.running=work;try{await work;}finally{delete project.running;}
 }
 async read(projectId:string,documentId?:string):Promise<unknown>{
  const project=this.projects.get(projectId);if(!project)throw new MachineError('scope-denied');if(project.running)await project.running;if(!project.cacheDir||project.revision<project.target)throw new MachineError('context-setup-required');
  const cached=await readContext(path.join(project.cacheDir,'context.json'),projectId);if(!cached.value||cached.value.revision<project.revision)throw new MachineError('invalid-cache');
  const document=documentId===undefined?undefined:cached.value.documents.find(d=>d.id===documentId);if(documentId!==undefined&&!document)throw new MachineError('not-found');
  const value={source:'hub-canonical',projectId,revision:cached.value.revision,...(document?{document}:{manifest:cached.value.manifest})};if(Buffer.byteLength(JSON.stringify(value))>32768)throw new MachineError('quota-exceeded');return value;
 }
 hasProject(projectId:string):boolean{return this.projects.has(projectId);}
 async initialize():Promise<void>{for(const id of this.projects.keys())await this.invalidate(id,0);}
}
