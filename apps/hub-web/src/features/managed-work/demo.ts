import { ApiError } from "../../api/client";
import type { WorkAdapter } from "./adapter";
import type { WorkEvent, WorkRecord, WorkReceipt } from "./types";

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
  // Like the live server, side effects reach the board through the event
  // feed; a receipt carries only the command's own result.
  const log: WorkEvent[] = [];
  const emit = (record: WorkRecord, type: WorkEvent["type"], operationId: string) =>
    log.push({
      protocolVersion: 1,
      projectId,
      sequence: log.length + 1,
      eventId: "demo-event-" + (log.length + 1),
      operationId,
      actorId: "human:demo",
      actorKind: "human",
      occurredAt: new Date().toISOString(),
      type,
      entityType: record.kind as WorkEvent["entityType"],
      entityId: record.id,
      entityVersion: "version" in record ? record.version : null,
      contentDigest: "contentDigest" in record ? record.contentDigest : null,
      causationId: null,
    });
  return {
    mode: "demo",
    async document() {
      throw new ApiError(404, "not-found", "No archived demo document");
    },
    async events(cursor) {
      return {
        events: structuredClone(log.slice(Number(cursor) || 0)),
        nextCursor: String(log.length),
      };
    },
    async attention() {
      return {
        records: structuredClone(
          records.filter(
            (r) =>
              ((r.kind === "flow" || r.kind === "intent") &&
                r.state === "in-review") ||
              (r.kind === "attempt" && r.state === "blocked"),
          ),
        ),
        nextCursor: null,
      };
    },
    async observations() {
      return { observations: [], nextCursor: null };
    },
    async observe() {
      throw new ApiError(
        501,
        "observation-unavailable",
        "Demo has no provider",
      );
    },
    async capabilities() {
      return {
        protocolVersion: 1,
        enabled: true,
        allowedCommands: [
          "attempt.select",
          "review.decide",

        ],
        limits: {},
        features: {
          managedExecution: false,
          gitObserver: false,
          legacyConversion: false,
        },
      };
    },
    async record(id) {
      const snapshot = await this.snapshot();
      const record = snapshot.records.find((record) => record.id === id);
      if (!record) throw new Error("Missing demo work record");
      return {record, eventCursor: snapshot.eventCursor};
    },
    async snapshot() {
      return structuredClone({
        records,
        actions: [],
        eventCursor: String(log.length),
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
      let result: WorkRecord;
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
        const changed: WorkRecord = {
          ...intent,
          version: intent.version + 1,
          selectedSubmissionId: submission.id,
          state: p.decision === "accept" ? "accepted" : intent.state,
          acceptanceDecisionId:
            p.decision === "accept"
              ? decisionId
              : intent.acceptanceDecisionId,
        };
        records = records.map((r) => (r.id === intent.id ? changed : r));
        result = {
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
        };
        records.push(result);
        emit(changed, "intent-changed", command.operationId);
        emit(result, "decision-recorded", command.operationId);
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
        entities: [structuredClone(result)],
        eventCursor: String(log.length),
      };
      receipts.set(command.operationId, {
        body: JSON.stringify(command),
        receipt,
      });
      return receipt;
    },
  };
}
