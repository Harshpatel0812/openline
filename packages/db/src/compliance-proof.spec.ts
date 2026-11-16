import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "./client";
import { migrate } from "./migrate";
import { eq } from "drizzle-orm";
import { contacts, messages, workspaces, type ComplianceProofJson } from "./schema";
import { withTenant } from "./tenant";

const proof: ComplianceProofJson = {
  rulesetVersion: "test",
  channel: "email",
  decision: "allowed",
  jurisdiction: "US",
  evaluatedAt: "2026-11-18T15:00:00.000Z",
  checks: [{ rule: "suppression", outcome: "pass", detail: "ok", citation: "x" }],
};

/**
 * 0010: messages.compliance_proof is tenant-isolated with its row, written only when an outbound
 * email is reserved (or on its sending → sent step), immutable once set, and a row carrying proof
 * can't be deleted once it left `sending` — except by the workspace-deletion cascade.
 */
describe("messages.compliance_proof (0010)", () => {
  let handle: DatabaseHandle;
  const wsA = randomUUID();
  const wsB = randomUUID();
  let messageId = "";

  const insert = (
    ws: string,
    values: Partial<typeof messages.$inferInsert> = {},
  ): Promise<string> =>
    withTenant(handle.db, { workspaceId: ws }, async (tx) => {
      const [m] = await tx
        .insert(messages)
        .values({
          workspaceId: ws,
          direction: "outbound",
          messageIdHeader: `<${randomUUID()}@test>`,
          subject: "Hi",
          status: "sending",
          ...values,
        })
        .returning({ id: messages.id });
      return m!.id;
    });
  const update = (id: string, set: Partial<typeof messages.$inferInsert>, ws = wsA) =>
    withTenant(handle.db, { workspaceId: ws }, (tx) =>
      tx.update(messages).set(set).where(eq(messages.id, id)),
    );
  const remove = (id: string) =>
    withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.delete(messages).where(eq(messages.id, id)).returning({ id: messages.id }),
    );
  const load = async (id: string) => {
    const [row] = await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.select().from(messages).where(eq(messages.id, id)),
    );
    return row!;
  };

  beforeAll(async () => {
    handle = createDatabase(process.env.TEST_DATABASE_URL ?? "pglite://memory");
    await migrate(handle);
    for (const ws of [wsA, wsB]) {
      await withTenant(handle.db, { workspaceId: ws }, (tx) =>
        tx.insert(workspaces).values({ id: ws, name: ws, trialEndsAt: new Date() }),
      );
    }
    messageId = await insert(wsA, { complianceProof: proof });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("stores the proof as JSON and other columns stay updatable", async () => {
    await update(messageId, { status: "sent" });
    const row = await load(messageId);
    expect(row.status).toBe("sent");
    expect(row.complianceProof).toEqual(proof);
  });

  it("rejects changing or clearing a recorded proof", async () => {
    for (const next of [{ ...proof, decision: "blocked" }, null]) {
      await expect(update(messageId, { complianceProof: next })).rejects.toThrow();
    }
  });

  it("rejects proof on an inbound message, at insert or later", async () => {
    await expect(
      insert(wsA, { direction: "inbound", status: "received", complianceProof: proof }),
    ).rejects.toThrow();
    const inbound = await insert(wsA, { direction: "inbound", status: "received" });
    await expect(update(inbound, { complianceProof: proof })).rejects.toThrow();
  });

  it("adds proof only while the row is still sending (never to a sent email afterwards)", async () => {
    const sent = await insert(wsA, { status: "sent" });
    await expect(update(sent, { complianceProof: proof })).rejects.toThrow();
    const reserved = await insert(wsA);
    await update(reserved, { complianceProof: proof, status: "sent" });
    expect((await load(reserved)).complianceProof).toEqual(proof);
  });

  it("can't move an email with proof back to sending (to make it deletable)", async () => {
    await expect(update(messageId, { status: "sending" })).rejects.toThrow();
  });

  it("refuses to delete a sent or unconfirmed email with proof; a failed reservation still deletes", async () => {
    await expect(remove(messageId)).rejects.toThrow();
    const unconfirmed = await insert(wsA, { complianceProof: proof });
    await update(unconfirmed, { status: "unconfirmed" });
    await expect(remove(unconfirmed)).rejects.toThrow();
    const reservation = await insert(wsA, { complianceProof: proof });
    expect(await remove(reservation)).toEqual([{ id: reservation }]);
    const plain = await insert(wsA, { status: "sent" });
    expect(await remove(plain)).toEqual([{ id: plain }]);
  });

  it("erasing a contact keeps the proof and detaches the message", async () => {
    const contactId = await withTenant(handle.db, { workspaceId: wsA }, async (tx) => {
      const [c] = await tx
        .insert(contacts)
        .values({ workspaceId: wsA, email: `${randomUUID()}@example.com` })
        .returning({ id: contacts.id });
      return c!.id;
    });
    const id = await insert(wsA, { contactId, complianceProof: proof });
    await update(id, { status: "sent" });
    await withTenant(handle.db, { workspaceId: wsA }, (tx) =>
      tx.delete(contacts).where(eq(contacts.id, contactId)),
    );
    const row = await load(id);
    expect(row.contactId).toBeNull();
    expect(row.complianceProof).toEqual(proof);
  });

  it("another workspace can't see the message or its proof", async () => {
    const rows = await withTenant(handle.db, { workspaceId: wsB }, (tx) =>
      tx
        .select({ proof: messages.complianceProof })
        .from(messages)
        .where(eq(messages.id, messageId)),
    );
    expect(rows).toEqual([]);
  });

  it("deleting a whole workspace (operator path) still cascades through proof rows", async () => {
    const wsC = randomUUID();
    await withTenant(handle.db, { workspaceId: wsC }, (tx) =>
      tx.insert(workspaces).values({ id: wsC, name: wsC, trialEndsAt: new Date() }),
    );
    const id = await insert(wsC, { complianceProof: proof });
    await update(id, { status: "sent" }, wsC);
    // The app role can't delete workspaces; the operator (table owner) can.
    await handle.db.delete(workspaces).where(eq(workspaces.id, wsC));
    const left = await handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.workspaceId, wsC));
    expect(left).toEqual([]);
  });
});
