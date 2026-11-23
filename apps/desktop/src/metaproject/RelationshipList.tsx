import {
  METAPROJECT_EDGE_KINDS_V2,
  type MetaprojectEdge,
  type MetaprojectEdgeKind,
  type MetaprojectNeighbors,
  type MetaprojectNode,
  type MetaprojectNodeKind,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { useId, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { NODE_KIND_LABELS, RELATIONSHIP_KIND_LABELS } from "./labels";
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
    {icon && <Icon name={badge.icon} size={12} />}{NODE_KIND_LABELS[kind]}
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
 * `edge.from === root` is outgoing. A self-loop is left out at every step, as the graph layout
 * (`layoutNeighborhood`) leaves it out, so the panel and the graph caption count the same edges.
 * Edges whose ends are not in the projection are left out, as the old list did.
 */
export function groupRelationships(projection: MetaprojectNeighbors): RelationshipGroups {
  const nodes = new Map(projection.nodes.map(node => [node.id, node]));
  const adjacent: Record<RelationshipDirection, AdjacentRelationship[]> = { incoming: [], outgoing: [] };
  const secondStep: SecondStepRelationship[] = [];
  for (const edge of projection.edges) {
    if (edge.from === edge.to) continue;
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

/** A single lowercase word or hyphenated words with no path or position: "related-code", "key-files", "frontmatter". */
const ORIGIN_WORD = /^[a-z]+(?:-[a-z]+)*$/;

export interface RowEvidence { lines: string[]; origins: string[] }

/**
 * Splits an edge's evidence into example lines and origin tags. An item equal to the path of either
 * end only repeats what the row already shows; when the evidence carries such an item, the origin
 * words beside it ("related-code") become tags instead of lines.
 */
export function rowEvidence(edge: MetaprojectEdge, ends: readonly string[]): RowEvidence {
  const items = edge.evidence ?? [];
  const repeats = items.some(item => ends.includes(item));
  const rest = items.filter(item => !ends.includes(item));
  if (!repeats) return { lines: [...rest], origins: [] };
  return { lines: rest.filter(item => !ORIGIN_WORD.test(item)), origins: rest.filter(item => ORIGIN_WORD.test(item)) };
}

function examplesLabel(count: number): string {
  return `${count} ${count === 1 ? "example" : "examples"}`;
}

function kindWord(kind: MetaprojectEdgeKind): string {
  return RELATIONSHIP_KIND_LABELS[kind].toLowerCase();
}

function EvidenceLines({ id, lines }: { id: string; lines: string[] }) {
  const hidden = lines.length - EVIDENCE_EXAMPLES;
  return <ul className="metaproject-rel-evidence" id={id} aria-label="Evidence">
    {lines.slice(0, EVIDENCE_EXAMPLES).map((line, index) => <li key={index} className="mono">{line}</li>)}
    {hidden > 0 && <li>and {hidden} more</li>}
  </ul>;
}

/** A toggle (closed by default) that shows the example lines below the row it belongs to. */
function EvidenceDisclosure({ lines, label }: { lines: string[]; label: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  return <>
    <button
      type="button" className="btn btn-ghost btn-sm metaproject-rel-toggle"
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      title={open ? "Hide evidence" : "Show evidence"}
    ><Icon name={open ? "chevronDown" : "chevronRight"} size={12} />{label}</button>
    {open && <EvidenceLines id={id} lines={lines} />}
  </>;
}

function AdjacentRow({ edge, node, rootPath, select }: {
  edge: MetaprojectEdge;
  node: MetaprojectNode;
  rootPath: string;
  select: (id: string) => void;
}) {
  const { lines, origins } = rowEvidence(edge, [node.path, rootPath]);
  const countLabel = edge.count !== undefined ? `${edge.count} ${kindWord(edge.kind)}` : "";
  const toggleLabel = countLabel || examplesLabel(lines.length);
  return <li className="metaproject-rel-item">
    <button type="button" className="activity-row metaproject-rel-row" onClick={() => select(node.id)} title={node.path}>
      <span className="metaproject-rel-title truncate">{node.title}</span>
      <NodeKindBadge kind={node.kind} />
      <span className="metaproject-rel-path truncate">{node.path}</span>
      {origins.map(origin => <span key={origin} className="tag metaproject-rel-origin">{origin}</span>)}
    </button>
    {lines.length === 0 && countLabel && <span className="metaproject-rel-count">{countLabel}</span>}
    <EvidenceDisclosure lines={lines} label={toggleLabel} />
  </li>;
}

function Heading({ level, label, count }: { level: 3 | 4; label: string; count: number }) {
  const Tag = level === 3 ? "h3" : "h4";
  return <Tag className={level === 3 ? "metaproject-rel-heading" : "metaproject-rel-kind"}>
    {label} <span className="count-label">{count}</span>
  </Tag>;
}

function DirectionGroup({ direction, groups, rootPath, select }: {
  direction: RelationshipDirection;
  groups: RelationshipKindGroup[];
  rootPath: string;
  select: (id: string) => void;
}) {
  if (!groups.length) return null;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return <section className="metaproject-rel-group" data-direction={direction}>
    <Heading level={3} label={direction === "incoming" ? "Incoming" : "Outgoing"} count={total} />
    {groups.map(group => <div className="metaproject-rel-kind-group" key={group.kind}>
      <Heading level={4} label={RELATIONSHIP_KIND_LABELS[group.kind]} count={group.rows.length} />
      <ul className="metaproject-rel-list">
        {group.rows.map(({ edge, node }, index) => <AdjacentRow key={`${node.id}-${index}`} edge={edge} node={node} rootPath={rootPath} select={select} />)}
      </ul>
    </div>)}
  </section>;
}

function SecondStepGroup({ rows, select }: { rows: SecondStepRelationship[]; select: (id: string) => void }) {
  if (!rows.length) return null;
  return <details className="metaproject-rel-group metaproject-rel-disclosure" data-direction="second-step">
    <summary><Heading level={3} label="Second step" count={rows.length} /></summary>
    <ul className="metaproject-rel-list">
      {rows.map(({ edge, from, to }, index) => {
        const { lines, origins } = rowEvidence(edge, [from.path, to.path]);
        return <li key={`${from.id}-${to.id}-${edge.kind}-${index}`} className="metaproject-rel-second">
          <p className="metaproject-rel-ends-label">
            <span className="metaproject-rel-title">{from.title}</span>
            <span className="metaproject-rel-edge-kind"> {kindWord(edge.kind)} </span>
            <span className="metaproject-rel-title">{to.title}</span>
            {origins.map(origin => <span key={origin} className="tag metaproject-rel-origin">{origin}</span>)}
          </p>
          <div className="metaproject-rel-ends">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => select(from.id)} title={from.path}>Open {from.title}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => select(to.id)} title={to.path}>Open {to.title}</button>
            <EvidenceDisclosure lines={lines} label={examplesLabel(lines.length)} />
          </div>
        </li>;
      })}
    </ul>
  </details>;
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
  const rootPath = projection.nodes.find(node => node.id === projection.root)?.path ?? "";
  // Empty by the grouping rule, not by the raw edges: a self-loop or an edge with a missing end lists no row.
  const empty = !groups.incoming.length && !groups.outgoing.length && !groups.secondStep.length;
  return (
    <div className="metaproject-rel">
      {projection.truncated && <p className="metaproject-rel-note" role="status">
        This projection is limited: some relationships are hidden. Narrow the filters to see them.
      </p>}
      {empty && <p className="metaproject-rel-note">No relationships for these filters.</p>}
      <DirectionGroup direction="incoming" groups={groups.incoming} rootPath={rootPath} select={select} />
      <DirectionGroup direction="outgoing" groups={groups.outgoing} rootPath={rootPath} select={select} />
      <SecondStepGroup rows={groups.secondStep} select={select} />
    </div>
  );
}
