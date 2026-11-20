// The Files tab's folder tree, built from the flat relative paths `project_files` returns.

export interface FileNode {
  name: string;
  /** Relative path, `/`-separated. */
  path: string;
  dir: boolean;
  children: FileNode[];
}

export interface FileRow {
  node: FileNode;
  depth: number;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** Folders first, then files, each sorted by name. */
export function buildTree(paths: readonly string[]): FileNode[] {
  const root: FileNode = { name: "", path: "", dir: true, children: [] };
  const nodes = new Map<string, FileNode>([["", root]]);
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let node = nodes.get(path);
      if (!node) {
        node = { name: parts[i]!, path, dir: i < parts.length - 1, children: [] };
        nodes.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }
  const sort = (list: FileNode[]) => {
    list.sort((a, b) => (a.dir === b.dir ? byName(a.name, b.name) : a.dir ? -1 : 1));
    list.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

/** The rows to draw: every node whose ancestors are all expanded, in tree order. */
export function visibleRows(tree: readonly FileNode[], expanded: ReadonlySet<string>): FileRow[] {
  const rows: FileRow[] = [];
  const walk = (list: readonly FileNode[], depth: number) => {
    for (const node of list) {
      rows.push({ node, depth });
      if (node.dir && expanded.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/** At most `max` lines of `text`, and whether anything was cut. */
export function limitLines(text: string, max: number): { text: string; cut: boolean } {
  let idx = -1;
  for (let i = 0; i < max; i++) {
    idx = text.indexOf("\n", idx + 1);
    if (idx === -1) return { text, cut: false };
  }
  return { text: text.slice(0, idx), cut: true };
}
