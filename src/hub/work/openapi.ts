import domain from "../../../docs/requirements/hub-work-management/schemas/domain.schema.json";
import command from "../../../docs/requirements/hub-work-management/schemas/command.schema.json";
import event from "../../../docs/requirements/hub-work-management/schemas/event.schema.json";

/** The schema vocabulary used by the reviewed metadata protocol. No external refs. */
export interface WorkSchema {
    $ref?: string; const?: unknown; enum?: readonly unknown[]; oneOf?: WorkSchema[]; anyOf?: WorkSchema[];
    type?: string; properties?: Record<string, WorkSchema>; required?: string[];
    additionalProperties?: boolean | WorkSchema; propertyNames?: WorkSchema;
    items?: WorkSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
    minimum?: number; maximum?: number; maxProperties?: number; pattern?: string;
}
const ref = (name: string): WorkSchema => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, WorkSchema>, required = Object.keys(properties)): WorkSchema => ({ type: "object", additionalProperties: false, properties, required });
const text: WorkSchema = { type: "string", minLength: 1, maxLength: 200 };
const cursor: WorkSchema = { type: "string", minLength: 1, maxLength: 4096 };
const nullableCursor: WorkSchema = { anyOf: [{ type: "string", minLength: 1, maxLength: 4096 }, { type: "null" }] };
const commandNames = command.oneOf.map(variant => variant.properties.command.const);
/** Rebase domain-local references into the single self-contained OpenAPI document. */
function rebase(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rebase);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema" && key !== "$id").map(([key, item]) => [key, key === "$ref" && typeof item === "string" ? item.replace("#/$defs/", "#/components/schemas/") : rebase(item)]));
    return value;
}
// These values are JSON Schema documents checked by the shared vocabulary validator below.
const domainSchemas = rebase(domain.$defs) as Record<string, WorkSchema>;
const workRecord: WorkSchema = { oneOf: domain.oneOf.map(item => ref(item.$ref.split("/").at(-1)!)) };
const array = (items: WorkSchema, maxItems: number): WorkSchema => ({ type: "array", maxItems, items });
const schemas: Record<string, WorkSchema> = {
    ...domainSchemas,
    WorkRecord: workRecord,
    WorkCommand: rebase(command) as WorkSchema,
    WorkEvent: rebase(event) as WorkSchema,
    Page: object({ records: array(ref("WorkRecord"), 200), nextCursor: nullableCursor, eventCursor: cursor }),
    Record: object({ record: ref("WorkRecord"), eventCursor: cursor }),
    Aggregate: object({ records: array(ref("WorkRecord"), 200), actions: array(object({ command: { enum: commandNames }, allowed: { type: "boolean" }, reasonCode: { type: "string", minLength: 1, maxLength: 200 } }), commandNames.length), eventCursor: cursor }),
    Events: object({ events: array(ref("WorkEvent"), 1000), nextCursor: cursor }),
    CommandResult: object({ operationId: text, entities: array(ref("WorkRecord"), 1000), eventCursor: cursor, receiptId: text }),
    Error: object({ error: object({ code: { type: "string", minLength: 1, maxLength: 200 }, message: { type: "string", maxLength: 4096 }, retryable: { type: "boolean" }, currentVersions: { type: "object", maxProperties: 210, additionalProperties: { type: "integer", minimum: 1 } } }, ["code", "message", "retryable"]), operationId: text }, ["error"]),
    Capabilities: object({ protocolVersion: { const: 1 }, enabled: { type: "boolean" }, allowedCommands: array({ enum: commandNames }, commandNames.length), limits: object({ maxCommandBytes: { const: 65536 }, defaultPageSize: { const: 50 }, maxPageSize: { const: 200 }, maxEventPageSize: { const: 1000 }, maxEventBytes: { const: 1048576 }, maxSnapshotBytes: { const: 20971520 } }), features: object({ managedExecution: { type: "boolean" }, gitObserver: { type: "boolean" }, legacyConversion: { type: "boolean" } }) }),
};
for (const [name, recordType] of Object.entries({ FlowRevision: "FlowRevision", IntentRevision: "IntentRevision", Context: "ContextSnapshot", Subject: "ResultSubject", Submission: "ReviewSubmission", FlowSubmission: "FlowSubmission", Amendment: "AmendmentManifest" })) schemas[`${name}Record`] = object({ record: ref(recordType), eventCursor: cursor });
for (const [name, recordType] of Object.entries({ Flow: "WorkFlow", Intent: "WorkIntent", Attempt: "Attempt", Evidence: "EvidenceRecord", Decision: "Decision" })) schemas[`${name}Page`] = object({ records: array(ref(recordType), 200), nextCursor: nullableCursor, eventCursor: cursor });
schemas.AttentionPage = object({ records: array({ oneOf: [ref("WorkFlow"), ref("WorkIntent"), ref("Attempt")] }, 200), nextCursor: nullableCursor, eventCursor: cursor });
schemas.LegacyPreview = object({ receiptId: text, contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, legacyFlowId: text, sourceVersion: { type: "integer", minimum: 1 }, sourceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, status: { const: "eligible" }, source: object({ flowId: text, title: { type: "string", minLength: 1, maxLength: 500 }, specification: ref("DocumentRef"), criteria: array({ type: "string", minLength: 1, maxLength: 4000 }, 200), status: { enum: ["initializing", "ready"] } }) });
schemas.CommandResult!.properties!.preview = ref("LegacyPreview");
schemas.Operation = { oneOf: [
    object({ operationId: text, status: { const: "pending" }, receiptId: { type: "null" }, result: { type: "null" }, eventCursor: { type: "null" } }),
    object({ operationId: text, status: { const: "committed" }, receiptId: text, result: ref("CommandResult"), eventCursor: cursor }),
] };
const submission = domainSchemas.FlowSubmission!.properties!;
schemas.AcceptancePreview = object({ flowId: submission.flowId!, flowRevisionId: submission.flowRevisionId!, acceptedIntents: submission.acceptedIntents!, knowledgeProposalIds: submission.knowledgeProposalIds!, criterionCoverage: submission.criterionCoverage!, acceptanceManifestDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, eventCursor: cursor });

export const workReadRoutes = [
    { suffix: "capabilities", name: "capabilities", schema: "Capabilities" },
    { suffix: "snapshot", name: "snapshot", schema: "Page", paging: "snapshot" },
    { suffix: "flows", name: "list_flows", schema: "FlowPage", paging: "list" },
    { suffix: "flows/{flowId}", name: "get_flow", schema: "Aggregate" },
    { suffix: "flows/{flowId}/intents", name: "list_intents", schema: "IntentPage", paging: "list" },
    { suffix: "flows/{flowId}/revisions/{revisionId}", name: "get_flow_revision", schema: "FlowRevisionRecord" },
    { suffix: "intents/{intentId}", name: "get_intent", schema: "Aggregate" },
    { suffix: "intents/{intentId}/revisions/{revisionId}", name: "get_intent_revision", schema: "IntentRevisionRecord" },
    { suffix: "intents/{intentId}/attempts", name: "list_attempts", schema: "AttemptPage", paging: "list" },
    { suffix: "attempts/{attemptId}", name: "get_attempt", schema: "Aggregate" },
    { suffix: "attempts/{attemptId}/evidence", name: "list_evidence", schema: "EvidencePage", paging: "list" },
    { suffix: "contexts/{contextId}", name: "get_context", schema: "ContextRecord" },
    { suffix: "subjects/{subjectId}", name: "get_subject", schema: "SubjectRecord" },
    { suffix: "submissions/{submissionId}", name: "get_submission", schema: "SubmissionRecord" },
    { suffix: "flow-submissions/{submissionId}", name: "get_flow_submission", schema: "FlowSubmissionRecord" },
    { suffix: "amendments/{amendmentId}", name: "get_amendment", schema: "AmendmentRecord" },
    { suffix: "decisions", name: "list_decisions", schema: "DecisionPage", paging: "decisions" },
    { suffix: "events", name: "events", schema: "Events", paging: "events" },
    { suffix: "attention", name: "attention", schema: "AttentionPage", paging: "list" },
    { suffix: "flows/{flowId}/acceptance-preview", name: "acceptance_preview", schema: "AcceptancePreview" },
    { suffix: "operations/{operationId}", name: "operation", schema: "Operation" },
] as const;
export type WorkReadName = typeof workReadRoutes[number]["name"];
export function workRouteParameters(suffix: string): string[] { return [...suffix.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!); }
const prefix = "/hub/work/v1/projects/{projectId}/";
const errorResponses = Object.fromEntries([400, 401, 403, 404, 409, 410, 413, 415, 422, 503].map(status => [status, { description: "Closed work error. Authorization is checked before record/receipt lookup. A conflict never replaces an earlier receipt.", content: { "application/json": { schema: ref("Error") } } }]));
function readOperation(route: typeof workReadRoutes[number]) {
    const parameters: { name: string; in: string; required: boolean; schema: WorkSchema }[] = ["projectId", ...workRouteParameters(route.suffix)].map(name => ({ name, in: "path", required: true, schema: text }));
    if ("paging" in route) {
        parameters.push({ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: route.paging === "events" ? 1000 : 200 } });
        parameters.push({ name: route.paging === "snapshot" ? "cursor" : route.paging === "events" ? "after" : "afterId", in: "query", required: false, schema: { type: "string", minLength: 1, maxLength: 4096 } });
        if (route.paging === "decisions") parameters.push({ name: "targetId", in: "query", required: false, schema: text });
    }
    return { operationId: `work_${route.name}`, tags: ["Managed work"], parameters, responses: { "200": { description: route.name === "snapshot" ? "Consistent staged snapshot page. Event cursor stays fixed across pages. Expires after five minutes; 410 requires a fresh snapshot." : "Authorized closed projection; embedded content is untrusted data.", content: { "application/json": { schema: ref(route.schema) } } }, ...errorResponses } };
}
export const workOpenApi = {
    openapi: "3.1.0",
    info: { title: "Keryx managed work metadata API", version: "0.1.1", description: "Authenticated metadata only. Work cursors are independent from document and machine execution cursors. Commands do not execute models or tools. Contributor MCP excludes human approval, selection, review, waiver, amendment and conversion." },
    security: [{ HubBearer: [] }, { HubSession: [] }],
    paths: {
        ...Object.fromEntries(workReadRoutes.map(route => [`${prefix}${route.suffix}`, { get: readOperation(route) }])),
        [`${prefix}commands`]: { post: { operationId: "work_command", tags: ["Managed work"], description: "Maximum UTF-8 JSON body 65536 bytes. Cookie mutations require configured Origin. Idempotency-Key must equal operationId; preserve the entire original envelope on retry. Replay checks current project authorization before returning the original actor-scoped result. Agents cannot invoke human-only commands. Unsupported optional adapters fail closed.", parameters: [{ name: "projectId", in: "path", required: true, schema: text }, { name: "Idempotency-Key", in: "header", required: true, schema: text }], requestBody: { required: true, content: { "application/json": { schema: ref("WorkCommand") } } }, responses: { "200": { description: "Committed result or exact authorized replay.", content: { "application/json": { schema: ref("CommandResult") } } }, "202": { description: "Pending operation; poll original operationId boundedly. No committed outcome is implied.", content: { "application/json": { schema: ref("Operation") } } }, ...errorResponses } } },
    },
    components: { securitySchemes: { HubBearer: { type: "http", scheme: "bearer" }, HubSession: { type: "apiKey", in: "cookie", name: "keryx_hub_session" } }, schemas },
};

/** Fail closed for unknown schema vocabulary or unresolved references. */
export function matchesWorkSchema(value: unknown, schema: WorkSchema): boolean {
    if (schema.$ref) { const target = schemas[schema.$ref.replace("#/components/schemas/", "")]; return !!target && matchesWorkSchema(value, target); }
    if ("const" in schema && value !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (schema.oneOf && schema.oneOf.filter(variant => matchesWorkSchema(value, variant)).length !== 1) return false;
    if (schema.anyOf && !schema.anyOf.some(variant => matchesWorkSchema(value, variant))) return false;
    if (schema.type === "null") return value === null;
    if (schema.type === "string") return typeof value === "string" && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value));
    if (schema.type === "boolean") return typeof value === "boolean";
    if (schema.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && !!schema.items && value.every(item => matchesWorkSchema(item, schema.items!));
    if (schema.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const entries = Object.entries(value);
        if (entries.length > (schema.maxProperties ?? Infinity) || schema.required?.some(key => !Object.hasOwn(value, key))) return false;
        return entries.every(([key, item]) => (!schema.propertyNames || matchesWorkSchema(key, schema.propertyNames)) && (schema.properties?.[key] ? matchesWorkSchema(item, schema.properties[key]!) : schema.additionalProperties === false ? false : typeof schema.additionalProperties === "object" ? matchesWorkSchema(item, schema.additionalProperties) : true));
    }
    return schema.const !== undefined || !!schema.enum || !!schema.oneOf || !!schema.anyOf;
}
