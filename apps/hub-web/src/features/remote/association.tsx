import { useRef,useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../app/hub-context';
import { getJson } from '../../api/client';
import { remoteProject,type Control } from '../../api/remote';
import type { HubFlow } from '../../api/types';
import { Field,Input,Select } from '../../components/ui';
import { Definition,digestCriteria,Feedback } from './shared';
/** Explicit association is separately selected for every replacement or workspace command. */
export function AssociationPicker({projectId,onChange}:{projectId:string;onChange:(association:Control['FlowAssociation']|null)=>void}){const hub=useHub();const{t}=useTranslation('remote');const[mode,setMode]=useState('flow');const[flowId,setFlowId]=useState('');const[consent,setConsent]=useState(false);const[version,setVersion]=useState('1');const[selected,setSelected]=useState<Control['FlowAssociation']|null>(null);const generation=useRef(0);const query=useQuery({queryKey:[hub.scopeKey,projectId,'flows'],queryFn:({signal})=>getJson<{flows:HubFlow[]}>(remoteProject(projectId)+'/flows',signal)});
 function adHoc(checked:boolean,ver:string){setConsent(checked);setVersion(ver);const value=checked&&Number.isSafeInteger(Number(ver))&&Number(ver)>0?{mode:'ad-hoc' as const,profileConsentVersion:Number(ver)}:null;setSelected(value);onChange(value);}
 async function select(id:string){const turn=++generation.current;setFlowId(id);setSelected(null);onChange(null);const flow=query.data?.flows.find(f=>f.id===id&&f.status==='in-progress');if(!flow)return;const digest=await digestCriteria(flow.criteria);if(turn!==generation.current)return;const value={mode:'flow' as const,flowId:id,expectedFlowVersion:flow.version,specDigest:flow.specContentDigest,criteriaDigest:digest};setSelected(value);onChange(value);}
 return <div className="space-y-3"><Field label={t('workMode')}><Select value={mode} onChange={e=>{generation.current++;setMode(e.target.value);setSelected(null);setConsent(false);onChange(null);}}><option value="flow">{t('flow')}</option><option value="ad-hoc">{t('adHoc')}</option></Select></Field>{mode==='flow'?<Field label={t('chooseFlow')}><Select value={flowId} onChange={e=>void select(e.target.value)}><option value="">{t('choose')}</option>{query.data?.flows.filter(f=>f.status==='in-progress').map(f=><option key={f.id} value={f.id}>{f.title} · v{f.version}</option>)}</Select></Field>:<><label className="flex gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e=>adHoc(e.target.checked,version)}/>{t('adHocConsent')}</label><Field label={t('consentVersion')}><Input type="number" min="1" value={version} onChange={e=>adHoc(consent,e.target.value)}/></Field></>}{selected?.mode==='flow'&&<Definition label={t('pins')}>{selected.specDigest}<br/>{selected.criteriaDigest}</Definition>}<Feedback query={query}/></div>;
}
