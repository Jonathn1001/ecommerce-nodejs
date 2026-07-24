export interface CommentRow {
  id: string;
  parentId: string | null;
  body: string;
}
export interface CommentNode {
  id: string;
  body: string;
  children: CommentNode[];
}

// Build the forest from a flat product-scoped fetch. O(n): one pass to index, one to link.
export function assembleTree(rows: CommentRow[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const r of rows) nodes.set(r.id, { id: r.id, body: r.body, children: [] });
  const roots: CommentNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    if (r.parentId === null) roots.push(node);
    else {
      const parent = nodes.get(r.parentId);
      if (parent) parent.children.push(node); // missing parent => orphan dropped
    }
  }
  return roots;
}
