# Specification: understandable Hub Flow acceptance
Version: 0.1.1

Status: planned, pending owner review. Identity: `hub-flow-acceptance`. Hub document path: `specs/hub-flow-acceptance.md`. This document is self-contained for an implementation agent; the related package provides the PRD and delivery plan.

## 1. Baseline and boundaries

The inspected v0.4.5 baseline has legacy Flow detail in `apps/hub-web/src/features/workflow.tsx`, plus the canonical Work model and UI under `src/hub/work/` and `apps/hub-web/src/features/managed-work/`. Legacy acceptance binds a CodeRevision and acknowledges self-reported Evidence. Canonical ReviewSubmission/Decision already bind exact subjects, requirement/context pins and coverage. This package plans UX and bounded metadata additions; it does not claim the new screen or a legacy return endpoint already exists.

Hub owns context, history and acceptance; Git/GitHub own code and merge. Do not add code exchange, remote execution, automatic deploy, automatic verification or automatic human decisions. Preserve contributor/human/machine authorization boundaries.

## 2. Entry points and screen

Overview review cards, a Flow/Intent awaiting review and a submission deep link open the same review presentation with an explicit model and project scope. A Flow page can summarize pending Intent reviews but must identify which result a decision affects.

Primary reading order:

1. **What was done / Что сделано**: concise delivery summary, expected user effect, limitations, author and submitted time using existing identity provenance.
2. **How to check / Как проверить**: prerequisites and ordered reproducible steps. Each step names where it runs, the command/action, and the expected result. Copy copies text only and announces success/failure.
3. **Acceptance criteria / Критерии приёмки**: all pinned criteria, supporting observations and provenance, with links to bounded evidence excerpts.
4. **Decision / Решение**: Accept result / Принять результат and Return for changes / Вернуть на доработку, with effect-specific confirmation.
5. **Technical details / Технические подробности**: collapsed by default; IDs, digests, revision graph, raw reports, command/exit code, Git/PR refs, trust metadata and audit history remain accessible.

Names, human-readable revision labels, author and freshness warnings remain visible. Opaque IDs and digests are not required reading or text the reviewer must type. The server still checks every exact ID/digest/version. Deep links expand the relevant technical item when explicitly requested.

## 3. Narrative and review-guide artifact

Use an optional immutable `review-guide/v1` artifact, validated by the package schema `docs/requirements/hub-flow-acceptance/schemas/review-guide.schema.json`. It contains `summary`, `userImpact`, `limitations`, `prerequisites` and ordered `steps` with stable criterion IDs, location, instruction and expected result. It contains no pass/fail claims or authority. The guide is authored by a contributor and is always labeled accordingly.

Canonical submissions use the optional `review-report/v1` envelope, serialized into the existing ResultSubject.report string and validated against `docs/requirements/hub-flow-acceptance/schemas/review-report.schema.json`. Its explicit reviewGuide documentId/version/contentDigest selector must exactly match one document artifact in the same immutable ResultSubject manifest. Ordinary document artifacts are never discovered as guides by scanning content or file names; no new artifact kind or authority field is added. A missing selector uses the ordinary report fallback. Invalid envelopes or mismatches are explicit; they do not select another document. Canonical submissions include a Hub document reference to the guide in their immutable ResultSubject artifact manifest. A guide is supplied before the subject/submission is sealed; its exact document version/digest is part of the reviewed result. Legacy submissions may include `attempt/review-guide.json` in their immutable CodeRevision bundle. Do not scan arbitrary repository files or silently pick a newer guide. At most one valid guide per submitted subject; malformed, ambiguous, oversized, cross-project or missing guide produces an explicit fallback, never an invented guide.

Existing `ResultSubject.report` and legacy report files may be shown as submitted text, with their provenance. Missing guidance says “No verification steps were supplied / Шаги проверки не предоставлены”; the reviewer can request them in a return comment. The old hub-status packet has no guide and must remain honestly recognizable as such. Do not retrofit it with fabricated criteria mappings or change its accepted record.

Bounds: guide at most32KiB UTF-8, at most30steps; schema field limits apply before persistence/rendering. Semantic validation also requires unique stepId values, nonblank trimmed summary/location/instruction/expectedResult and prerequisite/limitation items, and criterion IDs belonging to the pinned revision (maximum200characters, matching the canonical domain). At most one designated guide resolves; schema validation alone is insufficient. Markdown is sanitized, code is inert, links permit only safe HTTP(S)/project navigation. Never render credentials, hidden reasoning, cookies or environment dumps; retain existing redaction. Copyable commands are contributor instructions, not permission to execute them or grant machine access.

## 4. Criterion rows and verification provenance

Every row uses stable criterion ID and text from the pinned requirement revision. Canonical coverage comes from the immutable ReviewSubmission and the existing acceptance preview; the UI does not recompute domain eligibility from its own badge state. Resolve evidence only from the same project, Attempt, exact subject/submission and criterion scope.

Visible support states: passing support, failing support, inconclusive, missing and conflicting. A contributor's successful check is labeled “Reported pass / Исполнитель сообщил об успехе”, not “Verified by CI”. Conflicting relevant reports remain visible and follow existing server conflict/policy gates; do not pick the last green report. An explicit existing human waiver is shown separately with reason and decision provenance, never relabeled as a passing test.

Legacy Evidence has no reliable per-criterion mapping. Show it under “Reports without criterion mapping / Отчёты без привязки к критериям”; the rows show unknown/missing mapped coverage and explanatory text. This warning does not invent a new automatic block on previously permissible human legacy acceptance. A reviewer can judge the supplied reports and confirm the existing legacy acknowledgment.

Reviewer scratch checkboxes/notes are local, scoped by origin+project+model+target+submission digest+reviewer, and are explicitly personal notes, not Evidence or waivers. They do not override domain gates. Do not require a new technical checkbox merely to expose an accept action. Approved manual-review requirements still follow existing human/policy gates.

Unavailable/expired logs, unknown CI observations, drift and missing inputs stay explicit. An independent agent report remains an agent report. A genuine observed CI result must come from the existing validated observation path.

## 5. Accept result

Show a short confirmation with result title, human-readable revision, criteria summary, outstanding warnings and exact effect. The confirmation includes the existing self-reported-evidence acknowledgment in plain language where applicable. Technical binding values are supplied from the loaded target, never entered manually.

Canonical Intent review uses existing selection and `review.decide` semantics. If selection is needed, explain that the chosen Attempt is being selected separately; any combined UI action retains separate audit records and transactional guards. Intent acceptance does not silently accept its Flow. Canonical Flow acceptance targets the current aggregate acceptance manifest, checks all required Intent decisions and shows the composition being accepted.

Legacy acceptance reuses the current exact-result acceptance command and records. Existing done Flows stay read-only. Accepting work never publishes a review-only packet, merges a PR, updates code or approves a session tool request.

Server revalidates current human authority, project, state, expected versions, exact subject/submission/digest, selection, coverage, waivers, active/unknown execution and any knowledge-followup gates under existing policy. UI support badges and personal notes cannot authorize acceptance.

## 6. Return for changes

Require a trimmed nonempty comment (at most4000characters) before submission. Optional criterion references must belong to the exact pinned requirement revision. Explain the effect before confirmation. Store the comment, criterion references, actor and server time durably with the exact reviewed target. The contributor sees the comment on the Attempt/Flow and from the corresponding Overview attention entry.

Canonical uses `review.decide` with `request-changes`, preserving its reason and immutable ReviewSubmission. An Intent returns to the existing in-progress path; follow-up work is a new Attempt/submission with explicit supersession. For a Flow aggregate, accepted Intents are not reset or rewritten: the UI points to the existing amendment/remediation process if a required deliverable must change. Terminal rejection, cancellation and requirement amendment remain distinct actions.

Legacy uses these **planned** additive contracts, validated by `docs/requirements/hub-flow-acceptance/schemas/legacy-review.schema.json` (definitions requestChanges, receipt, resubmitAfterReturn). Existing APIs are unchanged until this feature is implemented.

| Operation | Contract |
|---|---|
| POST `/hub/v1/projects/{projectId}/flows/{flowId}/request-changes` | Mandatory existing `Idempotency-Key` header(1–200characters, no controls). Body requestChanges: expectedVersion, subjectRevisionId, comment, criterionRefs. Empty refs array is valid. Legacy refs are frozen specContentDigest +1-based criterion position. |
| Success | HTTP200 receipt: status committed, operationId equal to the header key, flowVersion after the change, flowState in-progress, and the immutable decision including its ID, previous subjectRevisionId, frozen spec digest, trimmed comment, refs, server-stamped human actor and time. The receipt describes this operation, not later current state. |
| GET `/hub/v1/projects/{projectId}/flows/{flowId}/review-operations/{operationId}` | Current authorized human and the same actor/project/Flow as the original request. Returns HTTP200 with the identical committed receipt or404 operation-not-found. This MVP does not invent a pending record. A404 after response loss does not prove failure; retry only the exact original key/payload. |
| POST existing `/hub/v1/projects/{projectId}/flows/{flowId}/submit-for-review` after return | Body resubmitAfterReturn adds afterReturnDecisionId to existing expectedVersion/subjectRevisionId. It is required only when an unresolved last return exists and must name that exact return. The new immutable subjectRevisionId must differ from the returned one. Existing first submissions remain compatible without this field. |

Return is valid only in implemented (awaiting review), with the exact current subjectRevisionId and version. Completing is an internal transient acceptance step, not a returnable state; done is read-only. Operator/reviewer humans only; agents, machine identities, wrong projects and revoked reviewers are refused server-side. Validate trimmed nonblank comment, total request size, refs against the frozen spec digest and valid criterion positions, without promoting them to Evidence.

HTTP errors use the existing Hub envelope:400 invalid-comment/invalid-criterion-ref or invalid-request,403 human/permission refusal,404 scoped-not-found/operation-not-found,409 stale-version/subject-changed/invalid-transition/idempotency-conflict/return-decision-required,413 request-too-large. No raw SQL/parser errors or comments in logs. UI maps them to localized actionable messages.

The legacy transaction appends an immutable decision, moves the Flow to in-progress, clears only current subjectRevisionId, stores lastReturnDecisionId, increments version and commits the existing event/operation receipt atomically. Previous CodeRevision and Evidence remain immutable. Flow detail exposes the unresolved return as an additive nullable reviewFeedback projection with the decision fields; old records get null, never fabricated history. Contributor API/UI readers can see it under existing project access. Overview shows unresolved returned work in project-scoped attention, without inventing an assignee or sending external messages. A later successful resubmission resolves the attention item but retains decision history.

Persist new legacy decision facts in additive project-scoped hub_legacy_review_decisions, indexed by(project,Flow,subject revision); reuse the existing authenticated Idempotency-Key operation infrastructure and canonical body fingerprint. Current authority is checked before replay, replay before current version/state gates. Same actor+project+method/path+key and identical original payload returns the same stored receipt; a changed payload conflicts. A pending/in-progress UI operation reconciles lookup or identical retry, never a fresh-key request. Concurrent accept/return transactions cannot both commit.

Preserve a durable last-return guard. Migrating/replaying old state cannot discard it. Before enabling the new guard, increment the existing checked database minimum-writer marker to a value rejected by every earlier writer, and demonstrate old0.4.5 refusal on copied data. If an older writer does not enforce that marker, activation is blocked until an enforceable guard is delivered; a new unrecognized flag alone is not a safeguard. Document the exact minimum compatible release at delivery. Rehearse backup/trial/restore and downgrade refusal; do not change Work wire protocol version1 solely for this legacy storage guard.

Canonical criterion-specific return notes compose one bounded existing Decision reason, including all selected criterion IDs and formatting. The UI counter and server validation enforce the existing combined reason limit (4000characters in the baseline); never budget comment and refs independently or silently truncate. The4000character comment limit is an upper bound, and remaining space shrinks with attached references. No typed reason extension is claimed to exist.

## 7. Concurrency, errors and drafts

Loading/offline/revoked/unknown-state views disable decisions and say why. Saving blocks duplicate clicks. Expected-version or submission conflicts preserve the comment and explain that the reviewed result changed; reload and require explicit reconfirmation, never silently retarget. Scope local drafts to exact origin/project/model/entity/submission/reviewer and do not clear them when a late receipt belongs to another page.

A lost response retains operation ID and exact payload; reconcile using the existing receipt path, never send a fresh operation to “try again”. Canonical uses current Work operation receipts. Legacy uses the exact committed-receipt-or404 lookup above; after unknown outcome the UI queries it or retries the identical original request. Cross-project reads and revoked authority refuse. Acceptance, return and audit views converge through existing event/query invalidation paths. Logs do not contain the comment text or secrets by default.

## 8. Compatibility, localization and accessibility

Cover canonical review, current legacy pending review and historical completed legacy Flows. No bulk conversion, history rewriting or automatic reopening. No guide is a supported legacy state. Preserve review-only publication restrictions.

RU and EN cover every label, error, warning, empty state and confirmation. Use native/accessible disclosures, keyboard focus and visible focus rings. After success announce the persisted outcome and focus its status; after validation failure focus the comment field. At375px, criteria become stacked rows and the decision controls remain reachable without page-wide horizontal scroll. Color is not the only status cue. Preserve the existing Hub palette and theme support.

## 9. Acceptance criteria

Every criterion is human judged, backed by executable regression evidence; “judged” is not permission to omit tests.

- AC1: The primary screen explains delivered change, user effect, limitations and the exact decision target without requiring IDs/digests. Verification: judged.
- AC2: A valid immutable guide renders ordered prerequisites/actions/expected results with inert copy controls; missing/invalid/ambiguous guidance is explicit. Verification: judged.
- AC3: Every pinned criterion is shown with correct passing/failing/inconclusive/missing/conflicting support, exact evidence links and visible waivers. Verification: judged.
- AC4: Contributor, independent-agent, human and observed-CI provenance remain distinct; legacy unmapped evidence never invents coverage or trusted CI. Verification: judged.
- AC5: IDs, hashes and raw reports are in collapsed accessible technical details while server exact-target checks remain intact. Verification: judged.
- AC6: Authorized acceptance preserves canonical selection/Intent/Flow boundaries and legacy exact-result acknowledgment; agents, machines and cross-project/revoked actors are refused. Verification: judged.
- AC7: Return rejects blank/oversized comments, persists reason and relevant criterion refs, and makes the feedback visible to the contributor. Verification: judged.
- AC8: Return/resubmission preserves old artifacts and decisions, requires a new immutable result, and never resets accepted canonical Intents or reopens historical done Flows. Verification: judged.
- AC9: Concurrent/stale decisions fail visibly; repeated identical operations and lost responses produce one decision, with comment drafts retained under their exact scope. Verification: judged.
- AC10: Loading, offline, missing evidence, drift, revoked access and server errors have actionable states without false success or stale action enablement. Verification: judged.
- AC11: Existing no-guide legacy pending/completed Flows remain readable and compatible, with no fabricated coverage and review-only Git publication still blocked. Verification: judged.
- AC12: RU/EN,375px layout, keyboard/disclosure/focus/announcements and non-color status cues pass browser checks with the existing palette. Verification: judged.
- AC13: A disposable end-to-end journey accepts a supported result; another returns failing work with a comment, resubmits and accepts the new result while history remains visible. Verification: judged.
- AC14: Exact candidate API/schema/migration-on-copy, regression and independent-review evidence is supplied; no real project is accepted/reopened or deployed by the implementation agent. Verification: judged.

## Appendix: implementation artifacts included for Hub readers

These are planned schemas, not already deployed endpoints. Runtime validation includes the semantic rules above.

### review-guide.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:keryx:hub:review-guide:v1",
  "title": "Contributor-authored immutable review guide",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "format",
    "summary",
    "userImpact",
    "limitations",
    "prerequisites",
    "steps"
  ],
  "properties": {
    "format": {
      "const": "review-guide/v1"
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "userImpact": {
      "type": "string",
      "maxLength": 2000
    },
    "limitations": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000
      }
    },
    "prerequisites": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000
      }
    },
    "steps": {
      "type": "array",
      "maxItems": 30,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "stepId",
          "criterionIds",
          "location",
          "instruction",
          "expectedResult"
        ],
        "properties": {
          "stepId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "criterionIds": {
            "type": "array",
            "uniqueItems": true,
            "maxItems": 200,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            }
          },
          "location": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "instruction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 3000
          },
          "expectedResult": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          }
        }
      }
    }
  }
}
```

### review-report.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:keryx:hub:review-report:v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "format",
    "summary",
    "body",
    "reviewGuide"
  ],
  "properties": {
    "format": {
      "const": "review-report/v1"
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "body": {
      "type": "string",
      "maxLength": 30000
    },
    "reviewGuide": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "documentId",
            "version",
            "contentDigest"
          ],
          "properties": {
            "documentId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "version": {
              "type": "integer",
              "minimum": 1
            },
            "contentDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          }
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

### legacy-review.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:keryx:hub:legacy-review:v1",
  "$ref": "#/$defs/requestChanges",
  "$defs": {
    "requestChanges": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expectedVersion",
        "subjectRevisionId",
        "comment",
        "criterionRefs"
      ],
      "properties": {
        "expectedVersion": {
          "type": "integer",
          "minimum": 1
        },
        "subjectRevisionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "comment": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4000
        },
        "criterionRefs": {
          "type": "array",
          "maxItems": 20,
          "uniqueItems": true,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "specContentDigest",
              "position"
            ],
            "properties": {
              "specContentDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "position": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200
              }
            }
          }
        }
      }
    },
    "receipt": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "operationId",
        "flowVersion",
        "flowState",
        "decision"
      ],
      "properties": {
        "status": {
          "const": "committed"
        },
        "operationId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "flowVersion": {
          "type": "integer",
          "minimum": 1
        },
        "flowState": {
          "const": "in-progress"
        },
        "decision": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "flowId",
            "subjectRevisionId",
            "specContentDigest",
            "comment",
            "criterionRefs",
            "actorId",
            "actorKind",
            "createdAt"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "flowId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "subjectRevisionId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "specContentDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "comment": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000
            },
            "criterionRefs": {
              "type": "array",
              "maxItems": 20,
              "uniqueItems": true,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "specContentDigest",
                  "position"
                ],
                "properties": {
                  "specContentDigest": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "position": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200
                  }
                }
              }
            },
            "actorId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "actorKind": {
              "const": "human"
            },
            "createdAt": {
              "type": "string",
              "format": "date-time"
            }
          }
        }
      }
    },
    "resubmitAfterReturn": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expectedVersion",
        "subjectRevisionId",
        "afterReturnDecisionId"
      ],
      "properties": {
        "expectedVersion": {
          "type": "integer",
          "minimum": 1
        },
        "subjectRevisionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "afterReturnDecisionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      }
    }
  }
}
```

## Delivery order

1. Disposable canonical/legacy/no-guide/returned fixtures and failing contract checks.
2. Immutable guide/report validation and provenance.
3. Legacy return/receipt/resubmit/storage migration and old-writer guards.
4. Shared screen with distinct canonical and legacy adapters.
5. RU/EN,375px and keyboard/focus verification.
6. Real HTTP/component/browser journeys, exact-candidate independent review, then owner acceptance. No automatic deployment or real project decisions.
