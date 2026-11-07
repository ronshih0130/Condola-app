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

/**
 * Independent-review probes (fix rounds 1 and 2). SENSITIVE: masked on both sides.
 * KEPT: nothing masked on both sides (the output equals the normalised input).
 * Not listed: "0912 345" (7 digits, a split partial number) stays readable by design.
 */
export const SENSITIVE_PROBES = [
  "822-12-345678-9", "8221 2345 6789 0123", "4111-1111-1111-1111", "4111 1111 1111 1111", "012-345-678-901",
  "０９１２３４５６７８", "Ａ１２３４５６７８９", "A 123 456 789", "A1234-56789", "A123456789", "A800000014", "AB12345678",
  "(02) 2345-6789", "02-2345-6789", "(02)2345-6789", "0912 345 678", "0912-345-678", "0912345678",
  "+886 912 345 678", "+886-2-2345-6789", "+886912345678", "＋８８６９１２３４５６７８",
  "9f8e7d6c5b4a3928170", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "U4af4980629a1b2c3d4e5f60718293a4b",
  "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0", "0d6e1d3a-1111-4222-8333-444455556666", "wang＠gmail.com", "wang@gmail.com",

  // Fix round 2: independent re-review probe.ts (rv2), every input that masks.
  "0912/345/678",
  "0912_345_678",
  "0912·345·678",
  "0912‐345‐678",
  "0912‑345‑678",
  "0912–345–678",
  "0912—345—678",
  "0912－345－678",
  "0912−345−678",
  "0912\u3000345\u3000678",
  "0912\u00a0345\u00a0678",
  "09\u200b12\u200b34\u200b56\u200b78",
  "09\u200d1234\u200d5678",
  "0912\u00ad345\u00ad678",
  "0912\t345\t678",
  "0912,345,678",
  "0912:345:678",
  "０9１2３4５6７8",
  "822/12/345678/9",
  "822–12–345678–9",
  "4111\u00a01111\u00a01111\u00a01111",
  "4111   1111   1111   1111",
  "4111\u3000-1111-1111-1111",
  "A/123456789",
  "A  123456789",
  "A–123–456–789",
  "a123456789",
  "IDA123456789",
  "NoA123456789",
  "A1234\u200b56789",
  "ＡＢ１２３４５６７８",
  "A 8 0000 0014",
  "護照 312345678",
  "E12345678",
  "GB82WEST12345698765432",
  "GB82 WEST 1234 5698 7654 32",
  "LINE: wang_1234",
  "@wang1234",
  "eyJhbGciOiJIUzIiJ.eyJzdWIiOiJhYmMifQ.abcdefghijklmnop",
  "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
  "wang+rent@gmail.com",
  "王小明@gmail.com",
  "wang@例子.台灣",
  "ｗａｎｇ＠ｇｍａｉｌ．ｃｏｍ",
  "wang@gmail。com",
  "wang @ gmail.com",
  "wang(at)gmail.com",
  "+886 9 1234 5678",
  "+886 (0)912-345-678",
  "(02)2345-6789#123",
  "0912   345   678",
  "帳號 123456789",
  "0001234-0123456",
  "合約編號 0012345678",
  "2026 11 06 12",
  "0\u03019\u03011\u030123456789",
];
export const KEPT_PROBES = [
  "tenant_directory_contact_edit", "owner_repair_override_value", "確認登記電費", "同期分攤改由新草稿取代",
  "Supercalifragilisticexpialidocious Ltd", "陳先生（屋主）同意，門牌 100 號 3F-1", "租金 30000 改 33000，2026-01-05 起",
  "coast-only-marker", "Morgan Lee", "物業經理",

  // Fix round 2: rv2 probes that must stay readable (dates, amounts, labels, addresses).
  "租金 25,000 元",
  "NT$1,250,000",
  "租金 30000 33000",
  "2026-11-06",
  "租約於 2026-11-06 10:00 終止",
  "2026-11-06 2027-11-05",
  "2026-11-06 - 2027-11-05",
  "3F-2",
  "台北市信義區松仁路100號5樓之2",
  "110 台北市信義區信義路五段7號 89 樓",
  "0.5 個月",
];
