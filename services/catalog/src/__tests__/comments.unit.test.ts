import { describe, it, expect } from "vitest";
import { assembleTree } from "../comments";

describe("assembleTree", () => {
  it("nests children under parents, roots first, insertion order preserved", () => {
    const tree = assembleTree([
      { id: "a", parentId: null, body: "root" },
      { id: "b", parentId: "a", body: "child" },
      { id: "c", parentId: "b", body: "grandchild" },
      { id: "d", parentId: null, body: "root2" },
    ]);
    expect(tree.map((n) => n.id)).toEqual(["a", "d"]);
    expect(tree[0].children[0].id).toBe("b");
    expect(tree[0].children[0].children[0].id).toBe("c");
    expect(tree[1].children).toEqual([]);
  });
  it("orphan (missing parent) is dropped from the forest, not crashed", () => {
    const tree = assembleTree([{ id: "x", parentId: "ghost", body: "orphan" }]);
    expect(tree).toEqual([]);
  });
});
