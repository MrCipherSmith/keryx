import { ApiError } from "../../api/client";
import type { WorkAdapter } from "./adapter";
import type { WorkRecord, WorkReceipt } from "./types";

const digest = "a".repeat(64);
export function demoWorkAdapter(projectId: string): WorkAdapter {
  const stamp = {
    projectId,
    createdBy: "human:maya",
    createdAt: "2026-11-01T08:00:00Z",
  };
  const mutable = { version: 1, updatedAt: stamp.createdAt };
  let records: WorkRecord[] = [
    {
      ...stamp,
      ...mutable,
      id: "flow-demo",
      kind: "flow",
      title: "Keyboard accessibility",
      ownerId: "human:maya",
      state: "in-progress",
      currentRevisionId: "fr1",
      approvedRevisionId: "fr1",
      acceptanceDecisionId: null,
      legacyFlowId: null,
    },
    {
      ...stamp,
      id: "fr1",
      kind: "flow-revision",
      flowId: "flow-demo",
      revision: 1,
      problem: "Core navigation requires a mouse.",
      expectedOutcome:
        "A complete keyboard journey through projects and sessions.",
      scope: "Navigation and focus management",
      outOfScope: "New product features",
      specification: null,
      criteria: [
        {
          criterionId: "fc1",
          text: "All navigation is usable by keyboard",
          waivable: false,
        },
        {
          criterionId: "fc2",
          text: "Integration journey has been verified",
          waivable: false,
        },
      ],
      requiredIntentIds: ["i1", "i2"],
      contentDigest: digest,
    },
    ...(["i1", "i2"] as const).flatMap((id, index): WorkRecord[] => [
      {
        ...stamp,
        ...mutable,
        id,
        kind: "intent",
        flowId: "flow-demo",
        title: index ? "Integration verification" : "Navigation and focus",
        ownerId: "human:maya",
        required: true,
        state: index ? "ready" : "in-review",
        currentRevisionId: "ir" + id,
        approvedRevisionId: "ir" + id,
        selectedSubmissionId: null,
        acceptanceDecisionId: null,
      },
      {
        ...stamp,
        id: "ir" + id,
        kind: "intent-revision",
        intentId: id,
        revision: 1,
        flowRevisionId: "fr1",
        deliverable: index
          ? "Verify the complete project → Flow → session journey."
          : "Implement arrow keys and visible focus.",
        approach: "Small isolated changes with verification.",
        outOfScope: "Unrelated layout changes",
        criteria: [
          {
            criterionId: "c" + id,
            text: index
              ? "Complete journey verified"
              : "Arrow keys and focus verified",
            waivable: false,
          },
        ],
        flowCriterionIds: ["fc" + (index + 1)],
        criterionMappings: [
          { intentCriterionId: "c" + id, flowCriterionId: "fc" + (index + 1) },
        ],
        contentDigest: digest,
      },
      {
        ...stamp,
        id: "ctx" + id,
        kind: "context",
        flowRevisionId: "fr1",
        intentRevisionId: "ir" + id,
        entries: [],
        gitBases: [],
        contentDigest: digest,
      },
    ]),
    ...(["agent", "manual"] as const).flatMap((method): WorkRecord[] => [
      {
        ...stamp,
        ...mutable,
        id: "a-" + method,
        kind: "attempt",
        flowId: "flow-demo",
        intentId: "i1",
        flowRevisionId: "fr1",
        intentRevisionId: "iri1",
        contextSnapshotId: "ctxi1",
        participantId: method === "agent" ? "agent:claude" : "human:alex",
        method: method === "agent" ? "native-agent" : "human",
        summary:
          method === "agent"
            ? "Roving tabindex with focus restoration"
            : "Manual Git implementation",
        supersedesAttemptId: null,
        state: "submitted",
        executionOutcome: "known-terminal",
        submissionId: "sub-" + method,
      },
      {
        ...stamp,
        id: "subject-" + method,
        kind: "subject",
        attemptId: "a-" + method,
        artifacts: [
          {
            kind: "git",
            repositoryId: "atlas/frontend",
            commitOid: (method === "agent" ? "b" : "c").repeat(40),
            treeOid: null,
            pullRequest: {
              number: method === "agent" ? 42 : 43,
              observedHeadOid: (method === "agent" ? "b" : "c").repeat(40),
            },
            verification: "claimed",
            observedAt: null,
          },
        ],
        report: "Keyboard navigation and focus restoration implemented.",
        contentDigest: digest,
      },
      {
        ...stamp,
        id: "ev-" + method,
        kind: "evidence",
        attemptId: "a-" + method,
        subjectId: "subject-" + method,
        subjectDigest: digest,
        criterionIds: ["ci1"],
        result: method === "agent" ? "pass" : "inconclusive",
        source: "contributor-report",
        method: "Keyboard journey",
        report:
          method === "agent"
            ? "Arrow navigation and focus restoration exercised."
            : "Browser matrix still needs verification.",
        outputDigest: digest,
        sourceRunId: null,
        sourceObservationId: null,
        contentDigest: digest,
      },
      {
        ...stamp,
        id: "sub-" + method,
        kind: "submission",
        attemptId: "a-" + method,
        subjectId: "subject-" + method,
        subjectDigest: digest,
        flowRevisionId: "fr1",
        intentRevisionId: "iri1",
        contextSnapshotId: "ctxi1",
        evidenceIds: ["ev-" + method],
        coverage: [
          {
            criterionId: "ci1",
            result: method === "agent" ? "pass" : "inconclusive",
            evidenceIds: ["ev-" + method],
          },
        ],
        knowledgeFollowup: {
          proposalIds: [],
          noUpdateReason: "No public behavior change.",
        },
        contentDigest: digest,
      },
    ]),
  ];
  const receipts = new Map<string, { body: string; receipt: WorkReceipt }>();
  return {
    mode: "demo",
    async capabilities() {
      return {
        protocolVersion: 1,
        enabled: true,
        allowedCommands: [
          "attempt.select",
          "review.decide",
          "requirements.approve",
        ],
        limits: {},
        features: {
          managedExecution: false,
          gitObserver: false,
          legacyConversion: false,
        },
      };
    },
    async snapshot() {
      return structuredClone({
        records,
        actions: [],
        eventCursor: String(receipts.size),
      });
    },
    async operation(id) {
      const receipt = receipts.get(id);
      if (!receipt)
        throw new ApiError(404, "not-found", "Unknown demo operation");
      return receipt.receipt;
    },
    async acceptancePreview() {
      throw new ApiError(
        409,
        "intent-not-accepted",
        "Integration deliverable is not accepted",
      );
    },
    async command(command) {
      const saved = receipts.get(command.operationId);
      if (saved) {
        if (saved.body !== JSON.stringify(command))
          throw new ApiError(
            409,
            "idempotency-conflict",
            "Changed demo command",
          );
        return saved.receipt;
      }
      for (const [id, version] of Object.entries(command.expectedVersions)) {
        const record = records.find((r) => r.id === id);
        if (!record || !("version" in record) || record.version !== version)
          throw new ApiError(409, "version-conflict", "Refresh demo state");
      }
      const p = command.payload;
      if (
        command.command === "attempt.select" ||
        command.command === "review.decide"
      ) {
        const intent = records.find(
          (r) => r.kind === "intent" && r.id === (p.intentId ?? p.targetId),
        );
        const submission = records.find(
          (r) => r.kind === "submission" && r.id === p.submissionId,
        );
        if (
          !intent ||
          intent.kind !== "intent" ||
          !submission ||
          submission.kind !== "submission" ||
          submission.contentDigest !== p.submissionDigest
        )
          throw new ApiError(409, "subject-drift", "Submission changed");
        if (
          command.command === "review.decide" &&
          intent.selectedSubmissionId !== submission.id
        )
          throw new ApiError(
            409,
            "invalid-transition",
            "Select an attempt first",
          );
        if (
          p.decision === "accept" &&
          records.some(
            (r) =>
              r.kind === "evidence" &&
              submission.evidenceIds.includes(r.id) &&
              r.result !== "pass",
          )
        )
          throw new ApiError(
            422,
            "coverage-incomplete",
            "Evidence is not passing",
          );
        const decisionId = "decision-" + command.operationId;
        records = records.map((r) =>
          r.id === intent.id
            ? {
                ...intent,
                version: intent.version + 1,
                selectedSubmissionId: submission.id,
                state: p.decision === "accept" ? "accepted" : intent.state,
                acceptanceDecisionId:
                  p.decision === "accept"
                    ? decisionId
                    : intent.acceptanceDecisionId,
              }
            : r,
        );
        records.push({
          ...stamp,
          id: decisionId,
          kind: "decision",
          createdBy: "human:demo",
          createdAt: new Date().toISOString(),
          targetType:
            command.command === "attempt.select"
              ? "attempt-selection"
              : "intent-review",
          targetId: intent.id,
          targetDigest: submission.contentDigest,
          decision:
            command.command === "attempt.select"
              ? "select"
              : p.decision === "accept"
                ? "accept"
                : p.decision === "reject"
                  ? "reject"
                  : "request-changes",
          reason: String(p.reason),
          actorKind: "human",
          operationId: command.operationId,
          contentDigest: digest,
        });
      } else
        throw new ApiError(
          400,
          "unsupported-command",
          "Demo supports selection and review only",
        );
      const receipt = {
        operationId: command.operationId,
        receiptId: "demo-" + command.operationId,
        status: "committed" as const,
        entities: [],
        eventCursor: String(receipts.size + 1),
      };
      receipts.set(command.operationId, {
        body: JSON.stringify(command),
        receipt,
      });
      return receipt;
    },
  };
}
