import { describe, it, expect } from "vitest";
import { rotateRefresh, type SessionRow, type SessionTx } from "../sessions";

const HOUR = 3600_000;
const NOW = new Date("2026-07-25T00:00:00.000Z");

function fakeTx(rows: SessionRow[]) {
  const store = new Map(rows.map((r) => [r.tokenHash, { ...r }]));
  const revokedFamilies: string[] = [];
  const minted: Array<{ familyId: string; userId: string }> = [];
  const tx: SessionTx = {
    async findByHash(hash) {
      return store.get(hash) ?? null;
    },
    async revokeFamily(familyId) {
      revokedFamilies.push(familyId);
      for (const row of store.values())
        if (row.familyId === familyId) row.revokedAt = NOW;
    },
    async revokeOne(id) {
      for (const row of store.values()) if (row.id === id) row.revokedAt = NOW;
    },
    async mintInFamily(n) {
      minted.push({ familyId: n.familyId, userId: n.userId });
      store.set(n.tokenHash, {
        id: `new_${minted.length}`,
        tokenHash: n.tokenHash,
        userId: n.userId,
        familyId: n.familyId,
        revokedAt: null,
        expiresAt: n.expiresAt,
      });
      return `new_${minted.length}`;
    },
    async linkReplacement(oldId, newId) {
      for (const row of store.values()) if (row.id === oldId) row.replacedBy = newId;
    },
  };
  return { tx, store, revokedFamilies, minted };
}

const live = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  tokenHash: "h1",
  userId: "u1",
  familyId: "f1",
  revokedAt: null,
  expiresAt: new Date(NOW.getTime() + 24 * HOUR),
  ...over,
});

describe("rotateRefresh", () => {
  it("live token -> ROTATED: mints in the same family, revokes and links the old row", async () => {
    const f = fakeTx([live()]);
    const r = await rotateRefresh(f.tx, "h1", NOW, () => "h2");
    expect(r.outcome).toBe("ROTATED");
    expect(r.tokenHash).toBe("h2");
    expect(f.minted).toEqual([{ familyId: "f1", userId: "u1" }]);
    expect(f.store.get("h1")!.revokedAt).toEqual(NOW);
    expect(f.store.get("h1")!.replacedBy).toBe("new_1");
  });

  it("unknown token -> UNKNOWN with no side effect (it proves nothing about a family)", async () => {
    const f = fakeTx([live()]);
    const r = await rotateRefresh(f.tx, "nope", NOW, () => "h2");
    expect(r.outcome).toBe("UNKNOWN");
    expect(f.revokedFamilies).toEqual([]);
    expect(f.minted).toEqual([]);
  });

  it("already-revoked token -> REUSE: revokes the WHOLE family, mints nothing", async () => {
    const f = fakeTx([
      live({ id: "s1", tokenHash: "h1", revokedAt: NOW }),
      live({ id: "s2", tokenHash: "h2" }), // same family, still live
    ]);
    const r = await rotateRefresh(f.tx, "h1", NOW, () => "h3");
    expect(r.outcome).toBe("REUSE");
    expect(f.revokedFamilies).toEqual(["f1"]);
    expect(f.store.get("h2")!.revokedAt).toEqual(NOW); // the thief's live token dies too
    expect(f.minted).toEqual([]);
  });

  it("expired token -> EXPIRED and the row is revoked", async () => {
    const f = fakeTx([live({ expiresAt: new Date(NOW.getTime() - HOUR) })]);
    const r = await rotateRefresh(f.tx, "h1", NOW, () => "h2");
    expect(r.outcome).toBe("EXPIRED");
    expect(f.store.get("h1")!.revokedAt).toEqual(NOW);
    expect(f.minted).toEqual([]);
  });

  it("rotating twice with the same token trips REUSE the second time", async () => {
    const f = fakeTx([live()]);
    expect((await rotateRefresh(f.tx, "h1", NOW, () => "h2")).outcome).toBe("ROTATED");
    const second = await rotateRefresh(f.tx, "h1", NOW, () => "h3");
    expect(second.outcome).toBe("REUSE");
    expect(f.store.get("h2")!.revokedAt).toEqual(NOW); // the honest client is logged out too
  });

  it("another family is untouched by a reuse in this one", async () => {
    const f = fakeTx([
      live({ id: "s1", tokenHash: "h1", revokedAt: NOW }),
      live({ id: "s9", tokenHash: "h9", familyId: "f2" }), // other device
    ]);
    await rotateRefresh(f.tx, "h1", NOW, () => "hx");
    expect(f.store.get("h9")!.revokedAt).toBeNull();
  });
});
