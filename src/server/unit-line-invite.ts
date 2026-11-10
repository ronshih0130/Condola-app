import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { svc } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function inviteTokenBytes(token: string): number {
  return Buffer.from(token, "base64url").length;
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function referrerHeaders(): Record<string, string> {
  return { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
}

export function maskToken(token: string): string {
  if (token.length > 8) return token.slice(0, 2) + "…" + token.slice(-2);
  return "***";
}

export function landingHtml(opts: { token: string; firm?: string; unit?: string; copy?: string }): string {
  const firm = opts.firm ?? "Condola";
  const unit = opts.unit ?? "";
  const copy = opts.copy ?? "";
  return [
    "<!doctype html>",
    '<html lang="zh-TW">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="referrer" content="no-referrer" />',
    `<title>${firm}</title>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${firm}</h1>`,
    `<p>${unit}</p>`,
    `<p>${copy}</p>`,
    "<p>等待管理方確認租約</p>",
    `<a href="/join/${opts.token}">continue</a>`,
    "<!-- TODO-R&D account recovery flow pending -->",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

export function roleHomeFor(kind: Session["kind"], role: Session["role"], flagOn: boolean): string {
  if (flagOn && kind === "staff" && role === "accountant") return "/m/payments";
  if (kind === "tenant") return "/t";
  if (kind === "owner") return "/o";
  if (role === "admin" || role === "manager" || role === "accountant") return "/m";
  return "/m/tickets";
}

export function staffCanManage(session: Session): boolean {
  return session.kind === "staff" && (session.role === "admin" || session.role === "manager");
}

async function requireInviteStaff(session: Session): Promise<Session> {
  if (!staffCanManage(session)) throw new FlowError("errors.forbidden");
  return guardEffectiveSession(session, "leases.edit");
}

export function mapSqlError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const codes = [
    "flag_off",
    "not_found",
    "expired",
    "revoked",
    "seat_cap",
    "staff_conflict",
    "identity_conflict",
    "multi_unit",
  ];
  for (const code of codes) {
    if (msg.includes(code)) throw new FlowError("errors." + code);
  }
  throw err;
}

async function withSql<T>(userId: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  return svc(userId, async (client) => {
    try {
      return await fn(client);
    } catch (err) {
      mapSqlError(err);
    }
  });
}

export async function unitLineInviteOn(orgId: string): Promise<boolean> {
  return withSql(null, async (client) => {
    const res = await client.query<{ on: boolean }>("SELECT app.unit_line_invite_on($1) AS on", [orgId]);
    return res.rows[0]?.on === true;
  });
}

async function audit(
  client: Client,
  orgId: string,
  actorUserId: string | null,
  actorRole: string | null,
  tableName: string,
  rowId: string,
  action: "insert" | "update" | "delete",
  eventType: string,
  reason?: string,
) {
  await client.query(
    `INSERT INTO public.audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orgId, actorUserId, actorRole, tableName, rowId, action, eventType, reason ?? null],
  );
}

export async function issueInvite(session: Session, unitId: string): Promise<{ token: string; path: string }> {
  session = await requireInviteStaff(session);
  if (!(await unitLineInviteOn(session.orgId))) throw new FlowError("errors.notFound");
  const token = newInviteToken();
  const hash = hashInviteToken(token);
  try {
    await withSql(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
      await client.query("SELECT app.unit_line_issue($1, $2, $3, $4)", [session.orgId, unitId, hash, session.userId]);
      await audit(client, session.orgId, session.userId, session.role, "unit_invite_secrets", unitId, "insert", "unit_line_issue", maskToken(token));
    }));
  } catch (err) {
    mapSqlError(err);
  }
  return { token, path: `/join/${token}` };
}

export async function rotateInvite(session: Session, unitId: string): Promise<{ token: string; path: string }> {
  session = await requireInviteStaff(session);
  if (!(await unitLineInviteOn(session.orgId))) throw new FlowError("errors.notFound");
  const token = newInviteToken();
  const hash = hashInviteToken(token);
  try {
    await withSql(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
      await client.query("SELECT app.unit_line_rotate($1, $2, $3, $4)", [session.orgId, unitId, hash, session.userId]);
      await audit(client, session.orgId, session.userId, session.role, "unit_invite_secrets", unitId, "insert", "unit_line_rotate", maskToken(token));
    }));
  } catch (err) {
    mapSqlError(err);
  }
  return { token, path: `/join/${token}` };
}

export async function acceptBind(input: {
  orgId: string;
  unitId: string;
  token: string;
  lineSub: string;
  enteredName?: string;
  displayName?: string;
  ip?: string;
  userId?: string;
}): Promise<{ bindingId: string; userId: string }> {
  if (!(await unitLineInviteOn(input.orgId))) throw new FlowError("errors.notFound");
  if (/^\d{6}$/.test(input.token) || inviteTokenBytes(input.token) !== 32) {
    throw new FlowError("errors.invalid");
  }
  const hash = hashInviteToken(input.token);
  const lineHash = createHash("sha256").update(input.lineSub).digest("hex");
  const displayName = input.displayName || input.enteredName || "tenant";

  try {
    return await withSql(input.userId ?? null, async (client) => {
      let userId = input.userId;
      if (!userId) {
        const email = `portal-${randomUUID()}@demo.condola.local`;
        const provisioned = await client.query<{ id: string }>(
          "SELECT app.provision_portal_user($1, $2, null) AS id",
          [email, displayName],
        );
        userId = provisioned.rows[0].id;
      }
      const contact = await client.query<{ id: string }>(
        `INSERT INTO public.contacts (org_id, user_id, is_tenant, display_name)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (org_id, user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET is_tenant = true
         RETURNING id`,
        [input.orgId, userId, displayName],
      );
      const contactId = contact.rows[0].id;
      const res = await client.query<{ id: string }>(
        "SELECT app.unit_line_accept($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id",
        [input.orgId, input.unitId, hash, userId, lineHash, displayName, input.enteredName ?? null, contactId, input.ip ?? null],
      );
      const bindingId = res.rows[0].id;
      await audit(client, input.orgId, userId, null, "unit_bindings", bindingId, "insert", "unit_line_bound");
      return { bindingId, userId };
    });
  } catch (err) {
    mapSqlError(err);
  }
}

export async function removeBinding(session: Session, bindingId: string): Promise<void> {
  session = await requireInviteStaff(session);
  if (!(await unitLineInviteOn(session.orgId))) throw new FlowError("errors.notFound");

  try {
    await withSql(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
      const binding = await client.query<{ user_id: string; contact_id: string | null }>(
        "SELECT user_id, contact_id FROM app.unit_bindings WHERE id = $1 AND org_id = $2",
        [bindingId, session.orgId],
      );
      const userId = binding.rows[0]?.user_id ?? null;
      const contactId = binding.rows[0]?.contact_id ?? null;
      await client.query("SELECT app.unit_line_remove($1, $2, $3)", [session.orgId, bindingId, session.userId]);
      if (userId) {
        await client.query(
          `INSERT INTO app.unit_bind_impostor_flags (org_id, binding_id, table_name, row_id, reason)
           SELECT $1, $2, 'maintenance_tickets', t.id, 'impostor-touched'
           FROM public.maintenance_tickets t
           WHERE t.org_id = $1 AND t.reported_by_user = $3`,
          [session.orgId, bindingId, userId],
        );
        await client.query(
          `INSERT INTO app.unit_bind_impostor_flags (org_id, binding_id, table_name, row_id, reason)
           SELECT $1, $2, 'messages', t.id, 'impostor-touched'
           FROM public.messages t
           WHERE t.org_id = $1 AND t.sender_user_id = $3`,
          [session.orgId, bindingId, userId],
        );
      }
      if (contactId) {
        await client.query(
          `INSERT INTO app.unit_bind_impostor_flags (org_id, binding_id, table_name, row_id, reason)
           SELECT $1, $2, 'identity_documents', t.id, 'impostor-touched'
           FROM public.identity_documents t
           WHERE t.org_id = $1 AND t.contact_id = $3`,
          [session.orgId, bindingId, contactId],
        );
      }
      await audit(client, session.orgId, session.userId, session.role, "unit_bindings", bindingId, "update", "unit_line_remove");
    }));
  } catch (err) {
    mapSqlError(err);
  }
}

export async function includeOnLease(
  session: Session,
  leaseId: string,
  unitId: string,
  bindingIds: string[],
): Promise<void> {
  session = await requireInviteStaff(session);
  if (!(await unitLineInviteOn(session.orgId))) throw new FlowError("errors.notFound");
  try {
    await withSql(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
      await client.query("SELECT app.unit_line_include_on_lease($1, $2, $3, $4)", [
        session.orgId,
        leaseId,
        unitId,
        bindingIds,
      ]);
    }));
  } catch (err) {
    mapSqlError(err);
  }
}

export interface TenantPortalView {
  viewLeaseLabel: string;
  showPay: boolean;
  showId: boolean;
  showRepair: boolean;
  showMessages: boolean;
}

export async function tenantPortalView(orgId: string, userId: string): Promise<TenantPortalView> {
  return withSql(null, async (client) => {
    const res = await client.query<{ status: string }>(
      `SELECT status FROM app.unit_bindings
        WHERE org_id = $1 AND user_id = $2 AND status IN ('pending','lease_linked')
        ORDER BY bound_at DESC LIMIT 1`,
      [orgId, userId],
    );
    const row = res.rows[0];
    if (row?.status === "lease_linked") {
      return { viewLeaseLabel: "lease", showPay: true, showId: true, showRepair: true, showMessages: true };
    }
    if (row?.status === "pending") {
      return {
        viewLeaseLabel: "等待管理方確認租約",
        showPay: false,
        showId: false,
        showRepair: false,
        showMessages: false,
      };
    }
    return { viewLeaseLabel: "", showPay: false, showId: false, showRepair: false, showMessages: false };
  });
}

export async function listBindings(session: Session, unitId: string): Promise<Record<string, unknown>[]> {
  session = await requireInviteStaff(session);
  return withSql(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
    const res = await client.query(
      "SELECT * FROM app.unit_bindings WHERE org_id = $1 AND unit_id = $2 ORDER BY bound_at DESC",
      [session.orgId, unitId],
    );
    return res.rows as Record<string, unknown>[];
  }));
}

export async function listInvites(session: Session, unitId: string): Promise<Record<string, unknown>[]> {
  session = await requireInviteStaff(session);
  return withSql(session.userId, async (client) => withEffectiveAuthority(client, session, "leases.edit", async () => {
    const res = await client.query(
      "SELECT id, org_id, unit_id, expires_at, revoked_at, issued_by, created_at FROM app.unit_invite_secrets WHERE org_id = $1 AND unit_id = $2 ORDER BY created_at DESC",
      [session.orgId, unitId],
    );
    return res.rows as Record<string, unknown>[];
  }));
}
