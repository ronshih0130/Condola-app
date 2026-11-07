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

/** Independent-review probes (fix round 1): masked on both sides, and kept verbatim on both sides. */
export const SENSITIVE_PROBES = [
  "822-12-345678-9", "8221 2345 6789 0123", "4111-1111-1111-1111", "4111 1111 1111 1111", "012-345-678-901",
  "０９１２３４５６７８", "Ａ１２３４５６７８９", "A 123 456 789", "A1234-56789", "A123456789", "A800000014", "AB12345678",
  "(02) 2345-6789", "02-2345-6789", "(02)2345-6789", "0912 345 678", "0912-345-678", "0912345678",
  "+886 912 345 678", "+886-2-2345-6789", "+886912345678", "＋８８６９１２３４５６７８",
  "9f8e7d6c5b4a3928170", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "U4af4980629a1b2c3d4e5f60718293a4b",
  "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0", "0d6e1d3a-1111-4222-8333-444455556666", "wang＠gmail.com", "wang@gmail.com",
];
export const KEPT_PROBES = [
  "tenant_directory_contact_edit", "owner_repair_override_value", "確認登記電費", "同期分攤改由新草稿取代",
  "Supercalifragilisticexpialidocious Ltd", "陳先生（屋主）同意，門牌 100 號 3F-1", "租金 30000 改 33000，2026-01-05 起",
  "coast-only-marker", "Morgan Lee", "物業經理",
];
