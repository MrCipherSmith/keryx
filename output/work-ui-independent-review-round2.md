STATUS: DONE

# Independent managed-work UI delta review — round 2

Verdict: APPROVE for the second increment reviewed here. No new actionable blocker or major found. Both original major findings are fixed and independently rechecked. Native managed dispatch in the machine-v2 composer is outside this reviewed increment and is not claimed tested.

## Stage 1: requirement and boundary correctness

- UI-001 fixed: Flow/Intent approval renders the complete semantic revision through `RevisionReview`: problem/outcome/scope/exclusions, exact specification reference/version/digest and archived reader, required Intent IDs, Intent approach/exclusions, exact parent revision/digest, explicit criterion mappings, stable criterion IDs and waiver permissions. Draft approval expands the contents. Whole-set amendment approval expands each exact replacement revision.
- UI-002 fixed: canonical location determines selected Flow, route changes discard prepared decisions, rendering requires matching captured Flow, and submit independently guards the captured Flow. The unknown operation lives in its separate project/principal/mode draft key and remains available for reconciliation after route changes.
- Adapted the original independent probes to initialize the canonical Flow location, rather than relying on a no-op navigate mock to update local-only selection. Their original visibility and no-old-form assertions were retained. Both pass: `apps/hub-web/node_modules/.bin/vitest run --config output/work-ui-probe.config.mjs`. Evidence: `.metaproject/data/gdctx/raw/2026-11-01T11-21-04-091Z-f3400a_run.log`.
- Read the entire amendments, observation, legacy, exact revision/document, work events and global attention implementations, relevant current view/model/operation/adapter changes, and actual backend HTTP/domain boundaries.
- Checked waivers are human-only, reference only permitted immutable criterion IDs and exact sealed submission digest, require independent per-criterion reasons, and leave evidence unchanged. Late evidence still prevents acceptance. Backend validates coverage/authority and exact CAS again.
- Checked amendment manifests include every affected Intent version, exact replacement digests and source Flow pin; a Flow change requires all approved dependent Intents. Approval/withdrawal use manifest digest and affected versions. Backend revalidates current replacement revisions/mappings and clears previous acceptance.
- Checked observation refresh targets the immutable subject ID/digest and Attempt CAS, retains operation identity for 202/unknown outcomes, unwraps real operation-result envelopes, and never repeats provider refresh while checking status. History separates availability, moved PR head and CI provenance from immutable contributor results. Current HTTP response shapes match the client decoder.
- Checked legacy source preview/convert payloads against the actual backend: explicit source version, durable dry-run receipt/digest, new deliverable and full legacy criterion mapping; no old acceptance is transferred. Feature/capability/human gates protect the live panel; backend reauthorizes writes.
- Exact document reads bind project/document/version/digest, reject a mismatched response, stay on the archived endpoint, and never substitute latest content. Rendering uses React text rather than HTML interpretation.
- Events use independent opaque cursors, abort on unmount/scope change, bounded retry delays, canonical invalidation and no mutation from event payloads. Global attention fans out to at most eight authorized projects per page with separate project cursors and exact Flow/Intent/Attempt links.
- Backend authorization is re-evaluated inside serialized mutations; UI authority/capability hints do not replace server checks. No demo fallback was introduced for failed live reads.

## Stage 2: UI quality and validation

Scoped forms use accessible labels and ordinary button/select/textarea semantics; operation uncertainty, provider failures, provenance, exact revision pins and archived-content failure have explicit visible states. Source inspection found no newly introduced unsafe HTML rendering or authorization grant in this delta. No full real-browser/screen-reader audit was performed by this reviewer.

`npm --prefix apps/hub-web test -- managed-work`: 21/21 passed across the two managed-work suites. Covers whole-set negative cases, agent denial, waiver reasons/evidence immutability, observation 202 identity, wrong-version document rejection, Overview bounds/deep links, and retry/cleanup. Evidence: `.metaproject/data/gdctx/raw/2026-11-01T11-21-56-912Z-8ef7f7_run.log`.

No product edits, installs, commits, deployment or real credentials. Only independent probe harness adaptation and this report were written under output. The source remains in flight; subsequent native execution changes require their own delta review.

Routing audit: graph_used: yes (initial affected query explicitly stale; not relied upon as current proof); wiki_used: yes (index; no managed-work page); ctx_used: yes; raw_rg_used: no. Local frontend/logic guidance and testing context were read in the first pass and reused.
