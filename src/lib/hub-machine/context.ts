import path from 'node:path';
import {readContext} from '../../hub/context-sync';
import{HubConnector,type HubBinding}from'../../hub/connector';
import{MachineError}from'./errors';import type{CheckoutMapping}from'./config';
class ExplicitMachineConnector extends HubConnector{
 constructor(private readonly local:CheckoutMapping,private readonly url:string,token:string,cacheRoot:string){super({cwd:local.cwd,token,cacheRoot});}
 override async binding():Promise<HubBinding>{return {url:this.url,projectId:this.local.projectId,checkoutId:this.local.checkoutId,tokenEnv:'KERYX_MACHINE_NOT_AN_ENV_TOKEN'};}
 override async status(){return {ok:true as const,connection:{url:this.url,projectId:this.local.projectId,checkoutId:this.local.checkoutId}};}
}
/** One event-driven coordinator per Hub/project, sharing the existing validated incremental sync. */
export class MachineContextSync{
 private readonly projects=new Map<string,{connectors:ExplicitMachineConnector[];revision:number;target:number;cacheDir?:string;running?:Promise<void>}>();
 constructor(options:{hubUrl:string;token:string;cacheRoot:string;mappings:readonly CheckoutMapping[]}){
  for(const mapping of options.mappings){let project=this.projects.get(mapping.projectId);if(!project){project={connectors:[],revision:-1,target:-1};this.projects.set(mapping.projectId,project);}project.connectors.push(new ExplicitMachineConnector(mapping,options.hubUrl,options.token,options.cacheRoot));}
 }
 async invalidate(projectId:string,revision:number):Promise<void>{
  const project=this.projects.get(projectId);if(!project)throw new MachineError('scope-denied');if(!Number.isSafeInteger(revision)||revision<0)throw new MachineError('invalid-frame');project.target=Math.max(project.target,revision);
  if(project.running)return project.running;if(project.revision>=project.target)return;
  const work=(async()=>{while(project.revision<project.target){const result=await project.connectors[0]!.sync();project.revision=result.revision;project.cacheDir=result.cacheDir;await Promise.all(project.connectors.slice(1).map(c=>c.refreshContextIndex()));if(project.revision<project.target)throw new MachineError('stale-reference');}})();
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
