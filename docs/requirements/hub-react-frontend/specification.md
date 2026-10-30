# React Frontend for Keryx Team Hub

## Problem

The prototype browser interface is a single embedded JavaScript application. As Hub gains real projects and workflows, this structure makes UI changes, reusable components, state isolation, localization and regression testing difficult. The owner needs a usable React application with Russian and English interfaces while retaining the working backend and approval boundaries.

## Expected Outcome

Replace the current browser implementation with a typed React application styled with Tailwind CSS. TanStack Query owns server state. Small client-only state uses Zustand where useful. All application-owned UI messages are available in Russian and English. Existing Cloudflare SSO and Hub workflows remain usable on the deployed test server.

## Outcome Criteria

- The owner can perform the existing project, document, proposal, Flow, Evidence, revision and delivery workflows in either language.
- Project and entity navigation are understandable and usable on desktop and mobile.
- Project switching, stale updates and authentication expiry do not leak another project's state or lose unsent form input within the current session.
- The frontend can be built, tested and deployed reproducibly without changing the CLI's shared dependency installation.

## Scope

### Application shell

Provide a project selector, clearly labeled navigation, current verified identity and role, RU/EN switcher, session/error state, refresh and sign-out. Use a restrained light theme with consistent typography, spacing, borders, status colors and focus states. UI changes must be functional, rather than static demonstration screens.

Use navigable URL state for project, section and selected document/Flow where applicable. Reload and browser Back/Forward must restore the selection without requiring unsupported backend routes. Invalid or deleted selections display an actionable state rather than crashing.

### Screens

1. Projects and overview: existing project creation, project selection, counts and current integration line.
2. Flows: status board, create form, specification association, frozen criteria and digest, exact subject revision, Evidence, supported lifecycle actions and explicit human acceptance acknowledgment. Status moves are API actions, not optimistic drag-and-drop state setters.
3. Documents: searchable document list, type/review/version metadata, safe content preview, source provenance, import form and proposal creation. Source revision remains required by the current API.
4. Proposals: pending/accepted/rejected states, proposed content versus canonical content, reason, exact digest and supported human review actions.
5. Code: immutable revision list/details, file inspection, review-bundle indication, existing snapshot creation, integration selection and Evidence subject selection. Avoid fetching large revision payloads for unrelated screens.
6. Delivery: existing delivery creation and published/conflict/failed results with branch/commit receipts. Review bundles must not appear as deliverable snapshots. Do not invent automatic PR creation.
7. History: server events and available cursor-based pagination, preserving actor identities and technical values.

Preserve the backend's actual capabilities. The current Flow create API exposes title, specification and acceptance criteria; this migration does not silently add the fields from another pending Flow.

### State and requests

Use typed API DTOs aligned with the current Hub contract. TanStack Query keys include the project/entity and authenticated session scope. Pass cancellation signals to GET requests, load screen data on demand and invalidate only affected resources after successful mutations. Clear private caches and stale in-flight results on logout or authentication loss.

Authentication errors 401 and revoked-role 403 access-denied clear authenticated identity and private project data. Ordinary permission or origin errors must not falsely sign the user out. Refresh reloads the effective principal as well as visible project data.

Mutation retries are disabled by default. Preserve a bounded Idempotency-Key for an identical operation whose response is lost; do not create a fresh operation automatically. Use expectedVersion or expectedLineVersion as required by each endpoint. Show 409 conflicts explicitly and retain the unsent draft, including the base version originally shown to the editor. Background refetch must not silently advance a dirty draft to a newer base version. Never silently overwrite newer state or replay approval actions after reauthentication.

Draft input remains in memory, isolated by project and entity, and survives refresh/refetch and failed mutation within the same authenticated session. It is cleared on logout or identity loss. Only non-sensitive preferences such as locale may be persisted in browser storage; tokens, documents, proposals, revisions, Evidence output and private drafts must not be persisted there.

### Localization

Support Russian and English for navigation, headings, labels, help, buttons, validation, empty/loading/error states, statuses, confirmation text and accessibility labels. Russian is the initial fallback; the user's explicit choice persists and updates document language. Format dates and numbers with the selected locale.

Do not translate source documents, project names, user-authored criteria, code, paths, IDs, hashes or command output. Translate known server error codes through the UI catalog and provide a localized fallback for unknown errors without hiding the technical error code.

### Authentication and security

Preserve the working Cloudflare Access SSO exchange, verified email/effective role display, same-origin cookie session and fixed Access logout path. Disabled-SSO deployments retain existing human token sign-in. Do not expose an SSO-mode browser recovery form that cannot work through the configured public origin.

Keep agent Bearer API access and server human-only guards unchanged. Human approval controls must use the current server principal and exact version/digest/subject, with clear acknowledgment of self-reported Evidence. Never bypass freeze, proposal acceptance, Flow acceptance, integration selection or delivery restrictions in client state.

Render Markdown and diffs without executing user-supplied HTML or scripts; reject unsafe link schemes. Preserve the current CSP and avoid runtime third-party scripts, CDNs, fonts or required external asset services. Review bundles remain technically blocked from selection, delivery and checkout application.

### Accessibility and responsive behavior

Forms have associated labels, keyboard-operable controls, visible focus, readable validation messages and clear disabled/pending states. Dialogs, if used, manage focus and support keyboard dismissal. Board lanes and large code/command content may scroll within their own regions; normal pages and forms must remain usable at 375px width without whole-page horizontal overflow.

### Build and deployment

Keep the frontend in an isolated package with its own exact lockfile. Pin compatible installed versions during implementation and document them. The existing root dependency symlink must not be replaced or used as the frontend installation target.

Integrate the built assets with Bun Hub, the source/compiled distribution and the existing Docker deployment. Builds must include all required assets, correct content types and supported navigation fallback without exposing arbitrary filesystem files. Keep API paths and authentication behavior unchanged. Document local development, frontend checks, release packaging, backup and rollback on the new runtime so review-bundle guards are retained.

## Acceptance Criteria

1. The deployed Hub browser application uses React and TypeScript, Tailwind CSS and TanStack Query, with isolated frontend dependencies and a reproducible lockfile; the root shared dependency installation remains intact.
2. Cloudflare SSO enters Hub without a second token and displays the verified email and effective role; disabled-SSO token login, same-origin protection, safe logout and agent API compatibility remain functional.
3. Project selection and section/entity navigation survive reload and browser Back/Forward; invalid selections and loading, empty, error and retry states are handled without crashes or stale cross-project content.
4. Projects/overview and Flow workflows retain existing supported creation, freeze/start/submit, exact specification/criteria/subject display, Evidence inspection and explicit human-only acceptance acknowledgment, without adding unsupported Flow fields or arbitrary status setters.
5. Documents and proposals support the existing import and proposal/review workflows with required source revision, readable content/diff, provenance, exact digests, versions and safe Markdown rendering.
6. Code, delivery and history screens retain supported revision creation/inspection, integration selection, delivery receipts/conflicts and event pagination; review bundles remain visibly review-only and blocked from integration and delivery.
7. Russian and English cover application-owned messages, validation, statuses and accessibility labels; language switching persists, updates document language and localized formatting, while user content and technical identifiers remain unchanged.
8. Project/session-scoped Query keys, request cancellation and cache clearing prevent stale responses or private cached data surviving project identity changes, logout, 401 or revoked-role 403; ordinary authorization errors preserve the valid session and Refresh reloads the effective role.
9. Mutations preserve exact version/digest/subject and operation idempotency, disable automatic unsafe retries, retain in-memory drafts on 409/network failure and avoid persisting private drafts or credentials in browser storage.
10. Core screens and forms work with keyboard navigation and at 375px mobile width and desktop sizes, with associated labels, visible focus and contained overflow for boards and code.
11. Frontend typecheck, lint, component/integration tests, existing Hub backend regression tests and build pass; browser smoke tests exercise both languages and representative real API workflows, including auth loss, conflicts and review-bundle guards.
12. The verified candidate is deployed to the existing geekom test Hub after backup, with local/SSH and public access checks, reproducible release and rollback instructions, immutable Evidence attached to the exact review candidate, and final Flow acceptance left to the owner.

## Out of Scope

- New backend business workflows, first-class Attempt, users/passwords or new roles.
- Implementing the separate pending Flow-model enhancement.
- Collaborative editing, realtime sockets, automatic agent execution or automatic GitHub PR creation.
- Changing canonical project documents, historical authorship, existing Flow criteria or project integration lines as part of migration.
- Production business environments, a new hosting platform, or additional Cloudflare policies.
