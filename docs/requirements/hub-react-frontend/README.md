# Team Hub React frontend

Status: implementation and independent local verification complete; geekom deployment and public browser verification passed. Final owner acceptance remains pending.

- [Specification and acceptance criteria](specification.md)
- [Implementation plan](plan.md)
- [Existing behavior inventory](parity.md)
- [Architecture and build integration](architecture.md)

The existing Hub API and authenticated project data remain authoritative. This work replaces the browser implementation, preserving the established authorization, document review, Flow lifecycle, revision, Evidence, and delivery semantics. It does not implement unrelated pending Flows.

## Chosen stack

- React and TypeScript for components and typed UI logic.
- Tailwind CSS for the responsive design system.
- TanStack Query for remote state, cancellation, invalidation and request status.
- Zustand for small non-server UI state; component state for transient form input.
- i18next and react-i18next for Russian and English application messages.
- Vite for development and reproducible frontend builds.
- No Ant Design initially; semantic controls and a small shared component set suffice.

Frontend dependencies have their own package, lockfile and installation directory. The existing shared root node_modules symlink is not an installation target.

## Workflow

The specification is imported into the real keryx Hub project and linked to a new Flow. The owner freezes the proposed criteria; an agent may then start work. Code Revision represents the prototype attempt, using a technically non-deliverable review bundle if the repository exceeds snapshot limits. Checks and independent review attach immutable self-reported Evidence to the exact candidate. After deployment verification, the agent submits for review and the owner performs final acceptance.

## Hub record

- Project: `fcb56bb6-6eb6-4c2e-b154-1d682432a778` (keryx).
- Flow: `a13d1ce5-720c-444e-b2d0-2b6ee320a77e`.
- Title: Rebuild Team Hub frontend with React, Tailwind and bilingual UI.
- Specification: `specs/hub-react-frontend.md`.
- Pinned specification digest: `36466dff01cee8503cfe6f3d76e4aec14d970729fe3bf281248352835e85179a`.
- Hub plan document: `plans/hub-react-frontend.md`.
- Twelve proposed acceptance criteria. Initial status: initializing, awaiting owner freeze.

Independent planning review: APPROVE. Minor mobile-width alignment was corrected to the specification's 375px minimum. The architecture uses Russian as fallback consistently with the specification, and disables Vite data-URL asset inlining to retain the existing CSP. The owner subsequently authorized Freeze; the browser performed it and the agent started the Flow. See the implementation journal and verification report for the executed work.


[Frontend development](../../../apps/hub-web/README.md) · [Verification report](report.md) · [Deployment and rollback](deployment.md) · [Execution journal](implementation.md)
