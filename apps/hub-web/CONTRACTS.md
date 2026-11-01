# Shared frontend contract

Features: A owns src/features/workflow.tsx exports ProjectsView, OverviewView, FlowsView and src/i18n/workflow.en.ts, workflow.ru.ts (default plain dictionary exports). B owns src/features/context.tsx exports DocumentsView, ProposalsView, RevisionsView, DeliveryView, HistoryView and src/i18n/context.en.ts, context.ru.ts. Views take no required props.

`useHub()` from src/app/hub-context.tsx exports {projectId:string|null,principal:Principal,scopeKey:number,location:{projectId:string|null,tab:Tab,documentId?:string,flowId?:string,revisionId?:string},navigate(partial):void,refresh():Promise<void>}. Tab = overview|flows|documents|proposals|code|delivery|history. query keys features [scopeKey,projectId,...].

`getJson<T>(path:string,signal?:AbortSignal):Promise<T>`, `postJson<T>(path:string,body:unknown):Promise<T>` from src/api/client.ts. Paths relative /hub/v1. ApiError status/code/message. postJson retains operation Idempotency-Key for identical route+payload+session on ambiguous error, drops after success; no automatic retries. Session clearing aborts requests and rejects late result delivery.

`useDraft<T>(key:string,initial:T)` from src/state/drafts.ts returns [T,set(next:T|((old:T)=>T)),clear(expected?:T):boolean]. Memory only, scoped by session via central clear and caller's project/entity key. Capture baseVersion in draft; never silently replace from refetch.

Canonical DTO type exports from src/api/types.ts. `useTranslation('workflow'|'context'|'common')`; namespace-qualified common keys supported. Common statuses key status.<wire-value>, labels loading/retry/refresh/save/cancel/error/empty/required.

Optional shared UI in components/ui.tsx: Button nativebutton props with variant primary|secondary|danger|ghost; Panel {title?,description?,children,className?}; Field {label,children,hint?}; Input/Select/Textarea nativeprops; Notice {children,tone?:error|success|info}; StatusBadge {status:string}; EmptyState {children}; PageHeading {title,description?,action?}. Workers may use Tailwind semantic native controls.

`Markdown` from components/Markdown.tsx {content:string} safe ReactMarkdown without rawHTML, unsafeURLfiltered. `formatDate(value:string,language:string)` from i18n/format.ts.

Native forms noValidate + localized explicitvalidation. Guard human actions principal.kind==='human'; backend retainsauthority. Tailwind utilities are preferred; feature-local CSS is permitted for cohesive layouts such as machine cards and managed work. Such styles must use a feature-specific class prefix and shared theme variables. No inline styles. Onlylocale and non-sensitive appearance preference persistent; privatecache/drafts memory only.

On successful submission pass the mutation variable snapshot to clear(submittedDraft). It returns false if a newer immutable draft object exists; preserve it and show common:draftPreserved. clear() remains unconditional for an explicit user reset.
