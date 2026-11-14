import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, createTestApp, PASSWORD, signedUp, uniqueEmail, type Browser } from "./helpers";

function tokenFrom(inviteUrl: string): string {
  return inviteUrl.split("/invite/")[1]!;
}

describe("team: members and invites", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function inviteNewRep(owner: Browser, role = "rep") {
    const email = uniqueEmail("invitee");
    const res = await owner.post("/v1/invites", { email, role }).expect(201);
    return {
      email,
      token: tokenFrom(res.body.inviteUrl as string),
      inviteId: res.body.invite.id as string,
    };
  }

  it("owner invites a new person, who creates an account and joins", async () => {
    const { b: owner } = await signedUp(app, { workspaceName: "Team A" });
    const { email, token } = await inviteNewRep(owner);

    const lookup = await browser(app).get(`/v1/invites/lookup?token=${token}`).expect(200);
    expect(lookup.body).toMatchObject({
      workspaceName: "Team A",
      email,
      role: "rep",
      status: "valid",
      accountExists: false,
    });

    const invitee = browser(app);
    await invitee
      .post("/v1/invites/accept", { token, name: "New Rep", password: PASSWORD })
      .expect(200);
    const me = await invitee.get("/v1/auth/me").expect(200);
    expect(me.body.role).toBe("rep");
    expect(me.body.workspace.name).toBe("Team A");

    const members = await owner.get("/v1/members").expect(200);
    expect(members.body.map((m: { email: string }) => m.email)).toContain(email);
  });

  it("an invite can only be used once", async () => {
    const { b: owner } = await signedUp(app);
    const { token } = await inviteNewRep(owner);
    await browser(app)
      .post("/v1/invites/accept", { token, name: "A", password: PASSWORD })
      .expect(200);
    const again = await browser(app)
      .post("/v1/invites/accept", { token, name: "B", password: PASSWORD })
      .expect(410);
    expect(again.body.code).toBe("invite_used");
  });

  it("revoked invites cannot be accepted", async () => {
    const { b: owner } = await signedUp(app);
    const { token, inviteId } = await inviteNewRep(owner);
    await owner.delete(`/v1/invites/${inviteId}`).expect(200);
    const res = await browser(app)
      .post("/v1/invites/accept", { token, name: "A", password: PASSWORD })
      .expect(410);
    expect(res.body.code).toBe("invite_revoked");
  });

  it("an existing user must sign in as the invited email to accept", async () => {
    const { b: owner } = await signedUp(app, { workspaceName: "Team B" });
    const { b: other, email: otherEmail } = await signedUp(app, { workspaceName: "Other Co" });
    const res = await owner.post("/v1/invites", { email: otherEmail, role: "manager" }).expect(201);
    const token = tokenFrom(res.body.inviteUrl as string);

    // Not signed in → must sign in first.
    const anon = await browser(app).post("/v1/invites/accept", { token }).expect(409);
    expect(anon.body.code).toBe("login_required");

    // Signed in as the invited email → joins and switches to the new workspace.
    await other.post("/v1/invites/accept", { token }).expect(200);
    const me = await other.get("/v1/auth/me").expect(200);
    expect(me.body.workspace.name).toBe("Team B");
    expect(me.body.role).toBe("manager");
    expect(me.body.workspaces).toHaveLength(2);
  });

  it("refuses to invite someone who is already a member", async () => {
    const { b: owner, email } = await signedUp(app);
    const res = await owner.post("/v1/invites", { email, role: "rep" }).expect(409);
    expect(res.body.code).toBe("already_member");
  });

  it("reps cannot invite or change roles", async () => {
    const { b: owner } = await signedUp(app);
    const { token } = await inviteNewRep(owner);
    const rep = browser(app);
    await rep.post("/v1/invites/accept", { token, name: "Rep", password: PASSWORD }).expect(200);
    await rep.post("/v1/invites", { email: uniqueEmail(), role: "rep" }).expect(403);
    const members = await rep.get("/v1/members").expect(200);
    const ownerId = members.body.find((m: { role: string }) => m.role === "owner").userId as string;
    await rep.patch(`/v1/members/${ownerId}`, { role: "rep" }).expect(403);
  });

  it("the last owner cannot be demoted or removed", async () => {
    const { b: owner } = await signedUp(app);
    const me = await owner.get("/v1/auth/me").expect(200);
    const res = await owner
      .patch(`/v1/members/${me.body.user.id as string}`, { role: "admin" })
      .expect(409);
    expect(res.body.code).toBe("last_owner");
    await owner.delete(`/v1/members/${me.body.user.id as string}`).expect(409);
  });

  it("admins cannot touch owners; removing a member ends their session", async () => {
    const { b: owner } = await signedUp(app);
    const { token: adminToken } = await inviteNewRep(owner, "admin");
    const admin = browser(app);
    await admin
      .post("/v1/invites/accept", { token: adminToken, name: "Admin", password: PASSWORD })
      .expect(200);

    const members = await owner.get("/v1/members").expect(200);
    const ownerId = members.body.find((m: { role: string }) => m.role === "owner").userId as string;
    await admin.delete(`/v1/members/${ownerId}`).expect(403);
    await admin.patch(`/v1/members/${ownerId}`, { role: "rep" }).expect(403);

    const { token: repToken, email: repEmail } = await inviteNewRep(owner);
    const rep = browser(app);
    await rep
      .post("/v1/invites/accept", { token: repToken, name: "Rep", password: PASSWORD })
      .expect(200);
    const list = await admin.get("/v1/members").expect(200);
    const repId = list.body.find((m: { email: string }) => m.email === repEmail).userId as string;
    await admin.delete(`/v1/members/${repId}`).expect(200);
    await rep.get("/v1/auth/me").expect(401);
  });

  it("workspaces never see each other's members or invites", async () => {
    const { b: a } = await signedUp(app, { workspaceName: "Alpha" });
    const { b: bOwner, email: bEmail } = await signedUp(app, { workspaceName: "Beta" });
    const { inviteId } = await inviteNewRep(bOwner);

    const aMembers = await a.get("/v1/members").expect(200);
    expect(aMembers.body.map((m: { email: string }) => m.email)).not.toContain(bEmail);
    const aInvites = await a.get("/v1/invites").expect(200);
    expect(aInvites.body.map((i: { id: string }) => i.id)).not.toContain(inviteId);
    // Revoking another workspace's invite looks like it doesn't exist.
    await a.delete(`/v1/invites/${inviteId}`).expect(404);
  });
});
