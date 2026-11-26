// Sessions as a tree: each child (a fork, or a session started from another) right
// after its parent, one level deeper. Order among siblings is the input order, so a
// newest-first list stays newest-first at every level. A child whose parent is not in
// the list is a root (its parent was deleted, or lives in another listing). Pure.

export type TreeRow<T> = { item: T; depth: number; parentMissing: boolean };

export function sessionTree<T>(items: readonly T[], idOf: (item: T) => string, parentOf: (item: T) => string | undefined): TreeRow<T>[] {
  const ids = new Set(items.map(idOf));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = parentOf(item);
    if (parent !== undefined && parent !== idOf(item) && ids.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(item);
      children.set(parent, list);
    } else roots.push(item);
  }
  const rows: TreeRow<T>[] = [];
  const placed = new Set<string>();
  const visit = (item: T, depth: number): void => {
    const id = idOf(item);
    if (placed.has(id)) return;
    placed.add(id);
    const parent = parentOf(item);
    rows.push({ item, depth, parentMissing: depth === 0 && parent !== undefined && parent !== id });
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // A parent cycle (a corrupt store) leaves items unplaced: list them as roots rather than drop them.
  for (const item of items) visit(item, 0);
  return rows;
}
