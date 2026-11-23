import {
  METAPROJECT_EDGE_KINDS_V2,
  type MetaprojectEdge,
  type MetaprojectEdgeKind,
  type MetaprojectNeighbors,
  type MetaprojectNode,
  type MetaprojectNodeKind,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { Icon, type IconName } from "../components/Icon";
import "./nodePanel.css";

const EVIDENCE_EXAMPLES = 2;

const KIND_BADGES: Record<MetaprojectNodeKind, { icon: IconName; tone: string }> = {
  module: { icon: "folder", tone: "badge-neutral" },
  file: { icon: "file", tone: "badge-neutral" },
  symbol: { icon: "circleDot", tone: "badge-neutral" },
  wiki: { icon: "list", tone: "badge-info" },
  spec: { icon: "checklist", tone: "badge-ok" },
  change: { icon: "branch", tone: "badge-warn" },
  archive: { icon: "archive", tone: "badge-neutral" },
};

/** A node kind as a text badge; the icon is decorative and the tint never carries meaning alone. */
export function NodeKindBadge({ kind, icon = false }: { kind: MetaprojectNodeKind; icon?: boolean }) {
  const badge = KIND_BADGES[kind];
  return <span className={`badge ${badge.tone} metaproject-kind-badge`}>
    {icon && <Icon name={badge.icon} size={12} />}{kind}
  </span>;
}

export type RelationshipDirection = "incoming" | "outgoing";
export interface AdjacentRelationship { edge: MetaprojectEdge; node: MetaprojectNode }
export interface RelationshipKindGroup { kind: MetaprojectEdgeKind; rows: AdjacentRelationship[] }
export interface SecondStepRelationship { edge: MetaprojectEdge; from: MetaprojectNode; to: MetaprojectNode }
export interface RelationshipGroups {
  incoming: RelationshipKindGroup[];
  outgoing: RelationshipKindGroup[];
  secondStep: SecondStepRelationship[];
}

/**
 * Direction is relative to the projection's root: `edge.to === root` is incoming and
 * `edge.from === root` is outgoing (a self-loop counts once, as outgoing). Edges whose ends are
 * not in the projection are left out, as the old list did.
 */
export function groupRelationships(projection: MetaprojectNeighbors): RelationshipGroups {
  const nodes = new Map(projection.nodes.map(node => [node.id, node]));
  const adjacent: Record<RelationshipDirection, AdjacentRelationship[]> = { incoming: [], outgoing: [] };
  const secondStep: SecondStepRelationship[] = [];
  for (const edge of projection.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    if (edge.from === projection.root) adjacent.outgoing.push({ edge, node: to });
    else if (edge.to === projection.root) adjacent.incoming.push({ edge, node: from });
    else secondStep.push({ edge, from, to });
  }
  return { incoming: byKind(adjacent.incoming), outgoing: byKind(adjacent.outgoing), secondStep };
}

function byKind(rows: AdjacentRelationship[]): RelationshipKindGroup[] {
  return METAPROJECT_EDGE_KINDS_V2
    .map(kind => ({ kind, rows: rows.filter(row => row.edge.kind === kind).sort((a, b) => a.node.title.localeCompare(b.node.title)) }))
    .filter(group => group.rows.length > 0);
}

export interface RelationshipSummary { incoming: number; outgoing: number; secondStep: number; truncated: boolean }

/** "N incoming · M outgoing" counts the root-adjacent edges of a projection. */
export function summarizeRelationships(projection: MetaprojectNeighbors): RelationshipSummary {
  const groups = groupRelationships(projection);
  const count = (list: RelationshipKindGroup[]) => list.reduce((sum, group) => sum + group.rows.length, 0);
  return { incoming: count(groups.incoming), outgoing: count(groups.outgoing), secondStep: groups.secondStep.length, truncated: projection.truncated };
}

function Evidence({ edge }: { edge: MetaprojectEdge }) {
  const lines = edge.evidence ?? [];
  if (!lines.length) return null;
  const hidden = lines.length - EVIDENCE_EXAMPLES;
  return <ul className="metaproject-rel-evidence" aria-label="Evidence">
    {lines.slice(0, EVIDENCE_EXAMPLES).map((line, index) => <li key={index} className="mono">{line}</li>)}
    {hidden > 0 && <li>and {hidden} more</li>}
  </ul>;
}

function Heading({ level, label, count }: { level: 3 | 4; label: string; count: number }) {
  const Tag = level === 3 ? "h3" : "h4";
  return <Tag className={level === 3 ? "metaproject-rel-heading" : "metaproject-rel-kind"}>
    {label} <span className="count-label">{count}</span>
  </Tag>;
}

function DirectionGroup({ direction, groups, select }: {
  direction: RelationshipDirection;
  groups: RelationshipKindGroup[];
  select: (id: string) => void;
}) {
  if (!groups.length) return null;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return <section className="metaproject-rel-group" data-direction={direction}>
    <Heading level={3} label={direction === "incoming" ? "Incoming" : "Outgoing"} count={total} />
    {groups.map(group => <div className="metaproject-rel-kind-group" key={group.kind}>
      <Heading level={4} label={group.kind} count={group.rows.length} />
      <ul className="metaproject-rel-list">
        {group.rows.map(({ edge, node }, index) => <li key={`${node.id}-${index}`}>
          <button type="button" className="activity-row metaproject-rel-row" onClick={() => select(node.id)} title={node.path}>
            <span className="metaproject-rel-title">{node.title}</span>
            <NodeKindBadge kind={node.kind} />
            <span className="metaproject-rel-path">{node.path}</span>
            {edge.count !== undefined && <span className="metaproject-rel-count">{edge.count} {edge.kind}</span>}
          </button>
          <Evidence edge={edge} />
        </li>)}
      </ul>
    </div>)}
  </section>;
}

function SecondStepGroup({ rows, select }: { rows: SecondStepRelationship[]; select: (id: string) => void }) {
  if (!rows.length) return null;
  return <section className="metaproject-rel-group" data-direction="second-step">
    <Heading level={3} label="Second step" count={rows.length} />
    <ul className="metaproject-rel-list">
      {rows.map(({ edge, from, to }, index) => <li key={`${from.id}-${to.id}-${edge.kind}-${index}`} className="metaproject-rel-second">
        <p className="metaproject-rel-ends-label">
          <span className="metaproject-rel-title">{from.title}</span>
          <span className="metaproject-rel-edge-kind"> {edge.kind} </span>
          <span className="metaproject-rel-title">{to.title}</span>
        </p>
        <Evidence edge={edge} />
        <div className="metaproject-rel-ends">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => select(from.id)} title={from.path}>Open {from.title}</button>
          {to.id !== from.id && <button type="button" className="btn btn-ghost btn-sm" onClick={() => select(to.id)} title={to.path}>Open {to.title}</button>}
        </div>
      </li>)}
    </ul>
  </section>;
}

/** The accessible relationship list: root-adjacent relationships by direction and kind, then second-step ones. */
export function RelationshipList({
  projection,
  select,
}: {
  projection: MetaprojectNeighbors;
  select: (id: string) => void;
}) {
  const groups = groupRelationships(projection);
  return (
    <div className="metaproject-rel">
      {projection.truncated && <p className="metaproject-rel-note" role="status">
        This projection is limited: some relationships are hidden. Narrow the filters to see them.
      </p>}
      {projection.edges.length === 0 && <p className="metaproject-rel-note">No relationships for these filters.</p>}
      <DirectionGroup direction="incoming" groups={groups.incoming} select={select} />
      <DirectionGroup direction="outgoing" groups={groups.outgoing} select={select} />
      <SecondStepGroup rows={groups.secondStep} select={select} />
    </div>
  );
}
