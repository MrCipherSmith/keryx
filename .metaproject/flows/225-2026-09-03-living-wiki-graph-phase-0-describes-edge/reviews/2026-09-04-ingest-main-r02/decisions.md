# Decisions

- F-NEW-001: acted-on — Fixed on branch fix/lwg-phase-0-review: the duplicate parseDescribesPatterns is deleted from src/wiki/provenance.ts, which now imports parseDescribesField from src/wiki/describes.ts. typecheck clean; 231 gdgraph+wiki tests green after the change. (valid_followup, post_flow_feedback).
- F-NEW-002: acted-on — Fixed on the same branch: src/gdgraph/wiki-layer.ts filters `node.kind === "file"` instead of `!== "asset"`, with the reason written at the site. 231 tests green. (valid_followup, post_flow_feedback).
- F-NEW-003: dismissed-wont-fix — Deliberate and consistent with the tree-sitter symbol layer's identical defensive import immediately above it (src/gdgraph/build.ts:155): a failed graph build is a worse outcome than a missing optional layer. Recorded in flow 225's journal as work for phase 1, whose freshness report already has a `limitations` channel built for exactly this signal. (valid_followup, post_flow_feedback).
