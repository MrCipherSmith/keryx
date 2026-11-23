import type { MetaprojectEdgeKind, MetaprojectNodeKind } from "../../../../src/integrations/metaproject-explorer-contract";

/** Human-readable names shown wherever a kind appears: filters, graph captions and legend, panel, lists. */
export const RELATIONSHIP_KIND_LABELS: Record<MetaprojectEdgeKind, string> = {
  imports: "Imports",
  asset: "Assets",
  describes: "Describes",
  links: "Wiki links",
  contains: "Contains",
  defines: "Defines",
  calls: "Calls",
  "changes-spec": "Changes spec",
  "spec-context": "Spec context",
};

export const NODE_KIND_LABELS: Record<MetaprojectNodeKind, string> = {
  module: "Module",
  file: "File",
  symbol: "Symbol",
  wiki: "Wiki page",
  spec: "Spec",
  change: "Change",
  archive: "Archived change",
};
