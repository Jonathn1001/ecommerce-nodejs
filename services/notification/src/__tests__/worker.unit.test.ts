import { describe, it, expect } from "vitest";
import { applySend, type SendRow, type WorkerPort } from "../worker";
import { ORDER_CONFIRMED } from "@ecom/contracts";

function fakePort(row: SendRow | null) {
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  let status = row?.status;
  const port: WorkerPort = {
    async loadRow() {
      return row ? { ...row, status: status! } : null;
    },
    async casSent() {
      if (status === "PENDING") {
        status = "SENT";
        return 1;
      }
      return 0;
    },
  };
  const mailer = {
    async send(m: { to: string; subject: string; html: string }) {
      sent.push(m);
    },
  };
  return { port, mailer, sent, statusNow: () => status };
}

const row: SendRow = {
  id: "n1",
  to: "u1@example.test",
  type: ORDER_CONFIRMED,
  orderId: "o1",
  status: "PENDING",
};

describe("applySend", () => {
  it("PENDING -> render+send+CAS SENT", async () => {
    const f = fakePort(row);
    expect(await applySend(f.port, f.mailer, "n1")).toBe("SENT");
    expect(f.sent[0].to).toBe("u1@example.test");
    expect(f.sent[0].subject).toContain("o1");
    expect(f.statusNow()).toBe("SENT");
  });

  it("already SENT -> SKIP, no send", async () => {
    const f = fakePort({ ...row, status: "SENT" });
    expect(await applySend(f.port, f.mailer, "n1")).toBe("SKIP");
    expect(f.sent).toEqual([]);
  });

  it("missing row -> SKIP", async () => {
    const f = fakePort(null);
    expect(await applySend(f.port, f.mailer, "x")).toBe("SKIP");
  });

  it("mailer throwing propagates (so consumeCommands retries -> DLQ); row stays PENDING", async () => {
    const f = fakePort(row);
    const throwing = {
      async send() {
        throw new Error("smtp down");
      },
    };
    await expect(applySend(f.port, throwing, "n1")).rejects.toThrow();
    expect(f.statusNow()).toBe("PENDING");
  });

  it("a lost CAS race (another worker already flipped it) -> SKIP", async () => {
    const f = fakePort(row);
    const racing: WorkerPort = {
      ...f.port,
      async casSent() {
        return 0;
      },
    };
    expect(await applySend(racing, f.mailer, "n1")).toBe("SKIP");
  });
});
