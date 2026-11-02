import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useHub } from '../../app/hub-context';
import { ApiError, getJson } from '../../api/client';
import type { HubFlow, LegacyReviewDecision } from '../../api/types';
import { Button } from '../../components/ui';
import { formatDate } from '../../i18n/format';

type ReviewDecisionPage={decisions:LegacyReviewDecision[];nextAfter:string|null};
/** Historical returns are server records, independent from unresolved feedback. */
export function LegacyReviewHistory({flow}:{flow:HubFlow}){
 const hub=useHub();const {t,i18n}=useTranslation('acceptance');
 const history=useInfiniteQuery({
  queryKey:[hub.scopeKey,hub.projectId,'flow',flow.id,'review-decisions',flow.version],
  enabled:hub.projectId===flow.projectId,
  initialPageParam:'',
  queryFn:async({pageParam,signal})=>{
   const page=await getJson<ReviewDecisionPage>(`/projects/${encodeURIComponent(flow.projectId)}/flows/${encodeURIComponent(flow.id)}/review-decisions?limit=20${pageParam?'&after='+encodeURIComponent(pageParam):''}`,signal);
   if(!Array.isArray(page.decisions)||(page.nextAfter!==null&&typeof page.nextAfter!=='string'))throw new ApiError(502,'invalid-response','Review history response is invalid');
   return page;
  },
  getNextPageParam:page=>page.nextAfter??undefined,
  retry:false,
 });
 const decisions=history.data?.pages.flatMap(page=>page.decisions)??[];
 return <section role="region" aria-label={t('historyTitle')}>
  <h3>{t('historyTitle')}</h3>
  {history.isPending&&<p>{t('historyLoading')}</p>}
  {history.isError&&<div><p role="alert">{t('historyUnavailable')}</p><Button variant="secondary" onClick={()=>void(history.isFetchNextPageError?history.fetchNextPage():history.refetch())}>{t('historyRetry')}</Button></div>}
  {!history.isPending&&!history.isError&&decisions.length===0&&<p>{t('historyEmpty')}</p>}
  <ol>{decisions.map(decision=><li key={decision.id}>
   <p>{t('returnedFeedback')} · {decision.actorId} · <time dateTime={decision.createdAt}>{formatDate(decision.createdAt,i18n.language)}</time></p>
   <p className="whitespace-pre-wrap break-words">{decision.comment}</p>
   <dl><dt>{t('historyResult')}</dt><dd><code>{decision.subjectRevisionId}</code></dd><dt>{t('historyDecision')}</dt><dd><code>{decision.id}</code></dd><dt>{t('reference')}</dt><dd><code>{decision.specContentDigest}</code></dd></dl>
   {decision.criterionRefs.length>0&&<ul>{decision.criterionRefs.map(reference=><li key={reference.specContentDigest+':'+reference.position}>{t('historyCriterion',{position:reference.position})} · <code>{reference.specContentDigest}</code></li>)}</ul>}
  </li>)}</ol>
  {history.hasNextPage&&!history.isFetchNextPageError&&<Button variant="secondary" disabled={history.isFetchingNextPage} onClick={()=>void history.fetchNextPage()}>{t(history.isFetchingNextPage?'historyLoading':'historyMore')}</Button>}
 </section>;
}
