import schema from '../../docs/requirements/hub-flow-acceptance/schemas/legacy-review.schema.json';
import type { HubFlow, LegacyCriterionRef, RequestLegacyChanges } from './contracts';
import { fail, object } from './domain';

function rebase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebase);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,key==='$ref' && typeof item==='string' ? item.replace('#/$defs/','#/components/schemas/') : rebase(item)]));
  return value;
}
const definitions = rebase(schema.$defs) as typeof schema.$defs;
const stringId = {type:'string',minLength:1,maxLength:200};
const parameters = ['projectId','flowId'].map(name => ({name,in:'path',required:true,schema:stringId}));
const legacyFlowSchema = {
  type:'object',additionalProperties:false,
  required:['id','projectId','title','specDocumentId','specContentDigest','criteria','status','version','subjectRevisionId','reviewFeedback'],
  properties:{id:stringId,projectId:stringId,title:{type:'string',minLength:1,maxLength:500},specDocumentId:stringId,specContentDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},criteria:{type:'array',minItems:1,maxItems:100,items:{type:'string',minLength:1,maxLength:4096}},status:{enum:['initializing','ready','in-progress','implemented','completing','done']},version:{type:'integer',minimum:1},subjectRevisionId:{anyOf:[stringId,{type:'null'}]},frozenBy:stringId,acceptedBy:stringId,acceptedAt:{type:'string',format:'date-time'},lastReturnDecisionId:stringId,reviewFeedback:{anyOf:[{$ref:'#/components/schemas/ReviewDecision'},{type:'null'}]},receipt:{type:'object',additionalProperties:false,required:['id','actorId','createdAt'],properties:{id:stringId,actorId:stringId,createdAt:{type:'string',format:'date-time'}}}},
};
const response = {description:'Immutable actor-scoped committed receipt',content:{'application/json':{schema:{$ref:'#/components/schemas/receipt'}}}};
const errors = Object.fromEntries([400,401,403,404,409,413,500,503].map(status => [status,{description:'Existing Hub error envelope',content:{'application/json':{schema:{$ref:'#/components/schemas/error'}}}}]));
/** Frozen additive legacy contracts. Managed Work wire protocol and authority stay unchanged. */
export const legacyReviewOpenApi = {
  openapi:'3.1.0',info:{title:'Keryx legacy commented review',version:'0.1.0'},security:[{HubBearer:[]},{HubSession:[]}],
  paths:{
    '/hub/v1/projects/{projectId}/flows/{flowId}/submit-for-review':{post:{operationId:'legacy_submit_for_review',description:'First submission keeps its existing body. After an unresolved return, afterReturnDecisionId and a distinct new result are required.',parameters:[...parameters,{name:'Idempotency-Key',in:'header',required:true,schema:stringId}],requestBody:{required:true,content:{'application/json':{schema:{oneOf:[{$ref:'#/components/schemas/firstSubmission'},{$ref:'#/components/schemas/resubmitAfterReturn'}]}}}},responses:{200:{description:'Current exact legacy Flow, with nullable reviewFeedback',content:{'application/json':{schema:{$ref:'#/components/schemas/LegacyFlow'}}}},...errors}}},
    '/hub/v1/projects/{projectId}/flows/{flowId}/request-changes':{post:{operationId:'legacy_request_changes',parameters:[...parameters,{name:'Idempotency-Key',in:'header',required:true,schema:stringId}],requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/requestChanges'}}}},responses:{200:response,...errors}}},
    '/hub/v1/projects/{projectId}/flows/{flowId}/review-operations':{get:{operationId:'legacy_review_operation_query',description:'Closed query alias for operation identifiers normalized by URL path handling, including dot-only identifiers. Same actor/project/Flow authorization and immutable receipt.',parameters:[...parameters,{name:'operationId',in:'query',required:true,schema:stringId}],responses:{200:response,...errors}}},
    '/hub/v1/projects/{projectId}/flows/{flowId}/review-operations/{operationId}':{get:{operationId:'legacy_review_operation',parameters:[...parameters,{name:'operationId',in:'path',required:true,schema:stringId}],responses:{200:response,...errors}}},
  },
  components:{schemas:{...definitions,LegacyFlow:legacyFlowSchema,ReviewDecision:definitions.receipt.properties.decision,firstSubmission:{type:'object',additionalProperties:false,required:['expectedVersion','subjectRevisionId'],properties:{expectedVersion:{type:'integer',minimum:1},subjectRevisionId:stringId}},error:{type:'object',additionalProperties:false,required:['error'],properties:{error:{type:'object',additionalProperties:false,required:['code','message'],properties:{code:{type:'string'},message:{type:'string'}}}}}},securitySchemes:{HubBearer:{type:'http',scheme:'bearer'},HubSession:{type:'apiKey',in:'cookie',name:'keryx_hub_session'}}},
};
export function parseLegacyReturn(input: unknown, flow: HubFlow): RequestLegacyChanges {
  const body = object(input), required = ['expectedVersion','subjectRevisionId','comment','criterionRefs'];
  if (Object.keys(body).length !== required.length || required.some(key => !Object.hasOwn(body,key))) fail(400,'invalid-request','Expected the closed request-changes body');
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion)<1 || typeof body.subjectRevisionId!=='string' || !body.subjectRevisionId.trim() || body.subjectRevisionId.length>200) fail(400,'invalid-request','Invalid review target');
  if (typeof body.comment!=='string' || !body.comment.trim() || [...body.comment].length>4000) fail(400,'invalid-comment','Enter a nonblank comment of at most 4000 characters');
  if (!Array.isArray(body.criterionRefs) || body.criterionRefs.length>20) fail(400,'invalid-criterion-ref','Invalid criterion references');
  const seen = new Set<number>(), refs: LegacyCriterionRef[]=[];
  for (const raw of body.criterionRefs) {
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) fail(400,'invalid-criterion-ref','Invalid criterion reference');
    const ref = raw as Record<string,unknown>;
    if (Object.keys(ref).length!==2 || ref.specContentDigest!==flow.specContentDigest || typeof ref.position!=='number' || !Number.isSafeInteger(ref.position) || ref.position<1 || ref.position>flow.criteria.length || seen.has(ref.position)) fail(400,'invalid-criterion-ref','References must name distinct pinned criteria');
    seen.add(ref.position); refs.push({specContentDigest:flow.specContentDigest,position:ref.position});
  }
  return {expectedVersion:Number(body.expectedVersion),subjectRevisionId:body.subjectRevisionId,comment:body.comment.trim(),criterionRefs:refs};
}
/** Canonical object-key order, preserving all original values (including whitespace) for exact retry. */
export function legacyReviewFingerprint(value: unknown): string {
  const canonical = (item: unknown, depth=0): unknown => {
    if (depth>16) fail(400,'invalid-request','Review request is nested too deeply');
    if (Array.isArray(item)) return item.map(value => canonical(value,depth+1));
    if (item && typeof item==='object') return Object.fromEntries(Object.keys(item).sort().map(key => [key,canonical((item as Record<string,unknown>)[key],depth+1)]));
    return item;
  };
  return JSON.stringify(canonical(value));
}
