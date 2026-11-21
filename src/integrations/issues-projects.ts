import { graphSummary, issueFields, type GithubIssue } from "./issues-board";
import { cursorScope, denied, invalidInput, readCursor, scopedCursor, type IssueAccount } from "./issues-github";
import type { IssuePage, IssueSummary } from "./issues-contract";

interface Option {
  id: string;
  name: string;
}
interface Field {
  __typename: string;
  id?: string;
  options?: Option[];
}
interface Project {
  id: string;
  number: number;
  title: string;
  owner: { login: string };
  viewerCanUpdate: boolean;
  field: Field | null;
}
interface Item {
  id: string;
  isArchived: boolean;
  content: GithubIssue | null;
  status: { optionId?: string; field?: { id?: string } } | null;
}
interface ProjectPage extends Project {
  items: { nodes: (Item | null)[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } };
}
export interface ProjectRequest {
  projectId?: string;
  owner?: string;
  number?: number;
  cursor?: string | null;
}
export interface ProjectItem {
  itemId: string;
  optionId: string | null;
  issue: IssueSummary;
}
export interface ProjectSnapshot extends IssuePage<ProjectItem> {
  project: {
    id: string;
    number: number;
    title: string;
    owner: string;
    canWrite: boolean;
    fieldId: string | null;
    options: Option[];
  };
}
export interface MoveRequest {
  projectId: string;
  itemId: string;
  fieldId: string;
  issueNodeId: string;
  expectedOptionId: string | null;
  optionId: string | null;
}
const statusField =
  'field(name:"Status") { __typename ... on ProjectV2SingleSelectField { id options {id name} } }';
const itemStatus =
  'status:fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId field {... on ProjectV2SingleSelectField {id}} } }';
const readableId = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,512}$/.test(value);
const singleField = (field: Field | null) => (field?.__typename === "ProjectV2SingleSelectField" ? field : null);

export async function readIssueProject(
  { api, viewer }: IssueAccount,
  request: ProjectRequest,
): Promise<ProjectSnapshot> {
  const { projectId, owner, number } = request;
  if (
    projectId === undefined
      ? typeof owner !== "string" ||
        !/^[a-z\d_-]{1,100}$/i.test(owner) ||
        !Number.isSafeInteger(number) ||
        number! < 1
      : !readableId(projectId) || owner !== undefined || number !== undefined
  )
    throw new Error(invalidInput);
  const scope = cursorScope(viewer, "project", projectId ?? owner, number ?? null);
  const after = readCursor(scope, request.cursor);
  const fields = `id number title owner { ... on User {login} ... on Organization {login} } viewerCanUpdate ${statusField}
    items(first:30,after:$after) { nodes { id isArchived ${itemStatus} content {__typename ... on Issue { ${issueFields} }} } pageInfo {hasNextPage endCursor} }`;
  let project: ProjectPage | null;
  if (projectId) {
    const data = await api.graphql<{ node: ProjectPage | null }>(
      `query IssueProject($id:ID!,$after:String) {node(id:$id) {... on ProjectV2 {${fields}}}}`,
      { id: projectId, after },
    );
    project = data.node;
  } else {
    const data = await api.graphql<{ repositoryOwner: { projectV2: ProjectPage | null } | null }>(
      `query IssueProjectByNumber($owner:String!,$number:Int!,$after:String) {repositoryOwner(login:$owner) {... on ProjectV2Owner {projectV2(number:$number) {${fields}}}}}`,
      { owner, number, after },
    );
    project = data.repositoryOwner?.projectV2 ?? null;
  }
  if (!project?.id || (projectId && project.id !== projectId)) throw new Error(denied);
  const field = singleField(project.field);
  const items: ProjectItem[] = [];
  let incomplete = false;
  for (const item of project.items.nodes) {
    if (!item || item.content === null) {
      incomplete = true;
      continue;
    }
    if (item.isArchived || item.content.__typename !== "Issue") continue;
    items.push({
      itemId: item.id,
      optionId: field && item.status?.field?.id === field.id ? (item.status?.optionId ?? null) : null,
      issue: graphSummary(item.content),
    });
  }
  const { hasNextPage, endCursor } = project.items.pageInfo;
  return {
    viewer,
    project: {
      id: project.id,
      number: project.number,
      title: project.title,
      owner: project.owner.login,
      canWrite: project.viewerCanUpdate,
      fieldId: field?.id ?? null,
      options: field?.options ?? [],
    },
    items,
    nextCursor: scopedCursor(scope, hasNextPage ? endCursor : null),
    incomplete,
  };
}

interface MoveItem {
  id: string;
  isArchived: boolean;
  project: Pick<Project, "id" | "field" | "viewerCanUpdate">;
  content: { __typename: string; id?: string } | null;
  status: Item["status"];
}
async function readMoveItem({ api }: IssueAccount, r: MoveRequest) {
  const data = await api.graphql<{ node: MoveItem | null }>(
    `query ReadIssueProjectStatus($item:ID!) {node(id:$item) {... on ProjectV2Item {id isArchived content {__typename ... on Issue {id}}
      project {id viewerCanUpdate ${statusField}} ${itemStatus}}}}`,
    { item: r.itemId },
  );
  const row = data.node;
  if (
    !row ||
    row.id !== r.itemId ||
    row.project.id !== r.projectId ||
    row.isArchived ||
    row.content?.__typename !== "Issue" ||
    row.content.id !== r.issueNodeId
  )
    throw new Error(denied);
  const field = singleField(row.project.field);
  if (field?.id !== r.fieldId || (row.status?.field?.id && row.status.field.id !== r.fieldId))
    throw new Error("configuration: The project Status field changed. Refresh the project.");
  return {
    canWrite: row.project.viewerCanUpdate,
    options: field.options ?? [],
    optionId: row.status?.optionId ?? null,
  };
}

export async function moveIssueProjectItem(account: IssueAccount, r: MoveRequest) {
  if (
    ![r.projectId, r.itemId, r.fieldId, r.issueNodeId].every(readableId) ||
    (r.optionId !== null && !readableId(r.optionId)) ||
    (r.expectedOptionId !== null && !readableId(r.expectedOptionId))
  )
    throw new Error(invalidInput);
  const response = (outcome: "updated" | "unchanged" | "reconciled" | "conflict", optionId: string | null) => ({
    viewer: account.viewer,
    itemId: r.itemId,
    optionId,
    outcome,
  });
  const before = await readMoveItem(account, r);
  if (before.optionId !== r.expectedOptionId) return response("conflict", before.optionId);
  if (before.optionId === r.optionId) return response("unchanged", before.optionId);
  if (!before.canWrite) throw new Error("access: This project is read-only for the selected account.");
  if (r.optionId !== null && !before.options.some((o) => o.id === r.optionId))
    throw new Error("configuration: Status option changed. Refresh the project.");
  const input = { projectId: r.projectId, itemId: r.itemId, fieldId: r.fieldId };
  let failure: unknown;
  try {
    if (r.optionId !== null) {
      await account.api.graphql(
        "mutation ChangeIssueProjectStatus($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}",
        { input: { ...input, value: { singleSelectOptionId: r.optionId } } },
      );
    } else {
      await account.api.graphql(
        "mutation ClearIssueProjectStatus($input:ClearProjectV2ItemFieldValueInput!){clearProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}",
        { input },
      );
    }
  } catch (error) {
    failure = error;
  }
  // GitHub has no compare-and-set here. A timeout can be a committed write.
  // Read back exactly once. Any later mutation requires another user decision.
  const observed = await readMoveItem(account, r);
  if (observed.optionId === r.optionId) return response(failure ? "reconciled" : "updated", observed.optionId);
  if (failure && observed.optionId === before.optionId) throw failure;
  return response("conflict", observed.optionId);
}
