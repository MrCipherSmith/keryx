# Decisions

- F-NEW-001: acted-on — Fixed in commit ff390934 (PR #449): the duplicate parseDescribesPatterns is deleted from src/wiki/provenance.ts, which now imports parseDescribesField from src/wiki/describes.ts. typecheck clean; 231 gdgraph+wiki tests green. (valid_followup, post_flow_feedback).
- F-NEW-002: acted-on — Fixed in commit ff390934 (PR #449): src/gdgraph/wiki-layer.ts filters node.kind === "file" instead of !== "asset", with the reason recorded at the site. 231 tests green. (valid_followup, post_flow_feedback).
- F-NEW-003: dismissed-wont-fix — Decided in commit ff390934 (PR #449) and recorded in flow 225's journal: kept deliberately, consistent with the tree-sitter symbol layer's identical defensive import at src/gdgraph/build.ts:155. A failed graph build is a worse outcome than a missing optional layer; phase 1's freshness report carries the limitations channel built for this signal. (valid_followup, post_flow_feedback).
