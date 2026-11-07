import { query } from "./db";
import { ORG_ID, USERS } from "./ids";
import type { Session } from "./types";

/**
 * B-031 slice 2 OFF fixture, shared by the integration test and the one-time
 * baseline capture against the pre-B031-slice-2 audit reader (1bba9f3). Synthetic
 * values only. The row ids do not exist, so record lookups resolve no names and the
 * SQL text depends only on the fixed tables below.
 */
export const OFF_DAY = "2020-01-02";
export const OFF_LEASE = "10000000-0000-4000-8000-0000000b31a1";
export const OFF_CONTACT = "10000000-0000-4000-8000-0000000b31a2";

export function adminSession(): Session {
  return {
    userId: USERS.admin,
    sessionId: "b031-audit-detail",
    email: "audit-detail@example.test",
    name: "Audit",
    kind: "staff",
    role: "admin",
    orgId: ORG_ID,
    liveOrgId: ORG_ID,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

/** Superuser fixture write, as the existing audit-read tests do. */
export async function insertOffFixture() {
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, reason, changed_cols, old_row, new_row, occurred_at)
     VALUES ($1, $2, 'authenticated', 'leases', $3, 'update', 'b031a-off 屋主同意', ARRAY['end_date','rent_amount_minor']::text[],
             '{"end_date":"2027-01-01","rent_amount_minor":3000000,"currency":"TWD"}'::jsonb,
             '{"end_date":"2027-02-01","rent_amount_minor":3100000,"currency":"TWD"}'::jsonb, '2020-01-02T01:00:00Z'),
            ($1, $2, 'authenticated', 'contacts', $4, 'update', NULL, ARRAY['phone_e164','legal_name']::text[],
             '{"phone_e164":"+886912345678","legal_name":"Fixture A"}'::jsonb,
             '{"phone_e164":"+886912345679","legal_name":"Fixture B"}'::jsonb, '2020-01-02T01:01:00Z')`,
    [ORG_ID, USERS.admin, OFF_LEASE, OFF_CONTACT],
  );
}

type Reader = {
  loadAuditScreen: (session: Session, input: Record<string, string>) => Promise<unknown>;
  loadAuditHistory: (session: Session, table: string, rowId: string) => Promise<unknown>;
};

export const OFF_FLOWS = ["screen", "history-lease", "history-contact"] as const;

export function offFlow(reader: Reader, flow: (typeof OFF_FLOWS)[number]) {
  const session = adminSession();
  if (flow === "screen") return () => reader.loadAuditScreen(session, { from: OFF_DAY, to: OFF_DAY });
  if (flow === "history-lease") return () => reader.loadAuditHistory(session, "leases", OFF_LEASE);
  return () => reader.loadAuditHistory(session, "contacts", OFF_CONTACT);
}

/** Cursors embed the identity id, which differs between databases. */
export function withoutCursors(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === "cursor" ? undefined : item)));
}
