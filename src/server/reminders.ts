import { publicSiteOrigin } from "./signup-gotrue";
import { query } from "./db";
import { mailReady, replyToAddress, sendMail, type MailMessage, type MailResult } from "./mail";
import {
  contactMethod,
  formatMailAmount,
  formatMailDate,
  formatMailMonth,
  leaseAdminMail,
  leaseTenantMail,
  overdueAdminMail,
  overdueTenantMail,
  spaceLabel,
} from "./mail-copy";

export const LEASE_THRESHOLDS = [60, 30, 7] as const;
export const OVERDUE_ADMIN_THRESHOLDS = [1, 7] as const;

export type ReminderKind = "lease_expiry_admin" | "lease_expiry_tenant" | "rent_overdue_admin" | "rent_overdue_tenant";

export type ReminderPlan = {
  orgId: string;
  kind: ReminderKind;
  targetId: string;
  threshold: number;
  messages: MailMessage[];
};

export type Person = { name: string; email: string };

export function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function daysUntil(later: string, earlier: string) {
  const end = Date.parse(`${later.slice(0, 10)}T00:00:00Z`);
  const start = Date.parse(`${earlier.slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function readMemberPrefs(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    leaseExpiry: record.lease_expiry !== false && record.lease_expiry !== "false",
    rentOverdue: record.rent_overdue !== false && record.rent_overdue !== "false",
  };
}

export function readTenantToggles(settings: unknown) {
  const record = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  return {
    leaseExpiry: record.email_tenant_lease_expiry !== false && record.email_tenant_lease_expiry !== "false",
    rentOverdue: record.email_tenant_rent_overdue !== false && record.email_tenant_rent_overdue !== "false",
  };
}

function people(value: unknown): Person[] {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const email = String((row as { email?: string }).email ?? "").trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    const name = String((row as { name?: string }).name ?? "").trim() || "租客";
    out.push({ name, email });
  }
  return out;
}

export type LeaseReminderInput = {
  orgId: string;
  leaseId: string;
  environment: string;
  status: string;
  renewalStatus: string;
  startDate: string;
  endDate: string | null;
  rentMinor: number | string;
  orgName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  settings: unknown;
  propertyName: string;
  address: string;
  unitLabel: string | null;
  roomLabel: string | null;
  ownerName: string | null;
  tenants: unknown;
  staff: { name: string; email: string; prefs: unknown }[];
  origin: string;
};

export function planLeaseReminders(row: LeaseReminderInput, today: string): ReminderPlan[] {
  if (row.environment !== "live" || row.status !== "active" || row.renewalStatus === "renewed" || !row.endDate) return [];
  const days = daysUntil(row.endDate, today);
  if (days !== 60 && days !== 30 && days !== 7) return [];
  const space = spaceLabel(row.unitLabel, row.roomLabel);
  const tenants = people(row.tenants);
  const tenantName = tenants[0]?.name || "租客";
  const owner = (row.ownerName ?? "").trim() || "屋主";
  const replyTo = replyToAddress(row.contactEmail);
  const plans: ReminderPlan[] = [];
  const adminMessages: MailMessage[] = [];
  for (const member of row.staff) {
    const email = member.email.trim();
    if (!email || !readMemberPrefs(member.prefs).leaseExpiry) continue;
    const rendered = leaseAdminMail({
      name: member.name.trim() || "管理員",
      days,
      property: row.propertyName,
      space,
      tenant: tenantName,
      owner,
      start: formatMailDate(row.startDate),
      end: formatMailDate(row.endDate),
      rent: formatMailAmount(row.rentMinor),
      url: `${row.origin}/m/leases/${row.leaseId}`,
    });
    adminMessages.push({ to: email, subject: rendered.subject, text: rendered.text, html: rendered.html, replyTo });
  }
  if (adminMessages.length) {
    plans.push({ orgId: row.orgId, kind: "lease_expiry_admin", targetId: row.leaseId, threshold: days, messages: adminMessages });
  }
  if (days === 30 && readTenantToggles(row.settings).leaseExpiry) {
    const contact = contactMethod(row.contactEmail, row.contactPhone);
    const messages: MailMessage[] = tenants.map((tenant) => {
      const rendered = leaseTenantMail({
        name: tenant.name,
        address: row.address || row.propertyName,
        space,
        end: formatMailDate(row.endDate || ""),
        company: row.orgName,
        contact,
        url: `${row.origin}/t/lease`,
      });
      return { to: tenant.email, subject: rendered.subject, text: rendered.text, html: rendered.html, replyTo };
    });
    if (messages.length) {
      plans.push({ orgId: row.orgId, kind: "lease_expiry_tenant", targetId: row.leaseId, threshold: 30, messages });
    }
  }
  return plans;
}

export type OverdueReminderInput = {
  orgId: string;
  invoiceId: string;
  environment: string;
  dueDate: string;
  periodStart: string;
  balanceMinor: number | string;
  orgName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  settings: unknown;
  propertyName: string;
  address: string;
  unitLabel: string | null;
  roomLabel: string | null;
  tenants: unknown;
  staff: { name: string; email: string; prefs: unknown }[];
  origin: string;
};

export function planOverdueReminders(row: OverdueReminderInput, today: string): ReminderPlan[] {
  if (row.environment !== "live") return [];
  const days = daysUntil(today, row.dueDate);
  if (days !== 1 && days !== 7) return [];
  const space = spaceLabel(row.unitLabel, row.roomLabel);
  const tenants = people(row.tenants);
  const tenantName = tenants[0]?.name || "租客";
  const replyTo = replyToAddress(row.contactEmail);
  const month = formatMailMonth(row.periodStart || row.dueDate);
  const amount = formatMailAmount(row.balanceMinor);
  const due = formatMailDate(row.dueDate);
  const plans: ReminderPlan[] = [];
  const adminMessages: MailMessage[] = [];
  for (const member of row.staff) {
    const email = member.email.trim();
    if (!email || !readMemberPrefs(member.prefs).rentOverdue) continue;
    const rendered = overdueAdminMail({
      name: member.name.trim() || "管理員",
      property: row.propertyName,
      space,
      tenant: tenantName,
      month,
      amount,
      due,
      days,
      url: `${row.origin}/m/rent`,
    });
    adminMessages.push({ to: email, subject: rendered.subject, text: rendered.text, html: rendered.html, replyTo });
  }
  if (adminMessages.length) {
    plans.push({ orgId: row.orgId, kind: "rent_overdue_admin", targetId: row.invoiceId, threshold: days, messages: adminMessages });
  }
  if (days === 1 && readTenantToggles(row.settings).rentOverdue) {
    const contact = contactMethod(row.contactEmail, row.contactPhone);
    const messages: MailMessage[] = tenants.map((tenant) => {
      const rendered = overdueTenantMail({
        name: tenant.name,
        address: row.address || row.propertyName,
        space,
        month,
        due,
        amount,
        company: row.orgName,
        contact,
        url: `${row.origin}/t/pay`,
      });
      return { to: tenant.email, subject: rendered.subject, text: rendered.text, html: rendered.html, replyTo };
    });
    if (messages.length) {
      plans.push({ orgId: row.orgId, kind: "rent_overdue_tenant", targetId: row.invoiceId, threshold: 1, messages });
    }
  }
  return plans;
}

type ClaimStore = {
  claim(plan: ReminderPlan): Promise<string | null>;
  complete(id: string, messageId: string): Promise<void>;
  release(id: string): Promise<void>;
  send(message: MailMessage): Promise<MailResult>;
};

export async function deliverReminders(plans: ReminderPlan[], io: ClaimStore) {
  let sent = 0;
  for (const plan of plans) {
    if (plan.messages.length === 0) continue;
    const id = await io.claim(plan);
    if (!id) continue;
    const ids: string[] = [];
    for (const message of plan.messages) {
      const result = await io.send(message);
      if (!result.ok) break;
      ids.push(result.messageId);
      sent += 1;
    }
    if (ids.length === 0) await io.release(id);
    else await io.complete(id, ids.join(","));
  }
  return sent;
}

type LeaseSqlRow = {
  lease_id: string;
  org_id: string;
  environment: string;
  status: string;
  renewal_status: string;
  start_date: string;
  end_date: string;
  rent_minor: string;
  org_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  settings: unknown;
  property_name: string;
  address: string;
  unit_label: string | null;
  room_label: string | null;
  owner_name: string | null;
  tenants: unknown;
};

type InvoiceSqlRow = {
  invoice_id: string;
  org_id: string;
  environment: string;
  due_date: string;
  period_start: string;
  balance_minor: string;
  org_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  settings: unknown;
  property_name: string;
  address: string;
  unit_label: string | null;
  room_label: string | null;
  tenants: unknown;
};

type StaffSqlRow = { org_id: string; name: string | null; email: string | null; email_prefs: unknown };

const TENANTS_SQL = `
  SELECT coalesce(json_agg(json_build_object('name', c.display_name, 'email', c.email::text)), '[]'::json)
    FROM lease_parties lp
    JOIN contacts c ON c.id = lp.contact_id
   WHERE lp.lease_id = l.id
     AND c.email IS NOT NULL
     AND btrim(c.email::text) <> ''
     AND (c.is_tenant OR lp.role IN ('primary', 'co_tenant'))`;

async function loadStaff(orgIds: string[]) {
  const grouped = new Map<string, { name: string; email: string; prefs: unknown }[]>();
  if (orgIds.length === 0) return grouped;
  const rows = await query<StaffSqlRow>(
    `SELECT m.org_id::text AS org_id,
            coalesce(nullif(btrim(p.display_name), ''), u.email::text) AS name,
            coalesce(nullif(btrim(u.email::text), ''), nullif(btrim(p.email::text), '')) AS email,
            m.email_prefs
       FROM org_members m
       JOIN auth.users u ON u.id = m.user_id
       LEFT JOIN profiles p ON p.id = m.user_id
      WHERE m.org_id = ANY($1::uuid[])
        AND m.status = 'active'
        AND m.role IN ('admin', 'manager')`,
    [orgIds],
  );
  for (const row of rows.rows) {
    const list = grouped.get(row.org_id) ?? [];
    list.push({ name: row.name ?? "", email: row.email ?? "", prefs: row.email_prefs });
    grouped.set(row.org_id, list);
  }
  return grouped;
}

async function loadLeases() {
  const rows = await query<LeaseSqlRow>(
    `SELECT l.id::text AS lease_id, l.org_id::text AS org_id, o.environment::text AS environment,
            l.status::text AS status, l.renewal_status::text AS renewal_status,
            l.start_date::text AS start_date, l.end_date::text AS end_date, l.rent_amount_minor::text AS rent_minor,
            o.name AS org_name, o.contact_email::text AS contact_email, o.contact_phone,
            o.settings, p.name AS property_name,
            coalesce(nullif(p.address_display, ''), p.name) AS address,
            u.label AS unit_label, r.label AS room_label, owner.display_name AS owner_name,
            (${TENANTS_SQL}) AS tenants
       FROM leases l
       JOIN organizations o ON o.id = l.org_id
       JOIN properties p ON p.id = l.property_id
       JOIN units u ON u.id = l.unit_id
       LEFT JOIN rooms r ON r.id = l.target_room_id
       LEFT JOIN LATERAL (
         SELECT c.display_name
           FROM property_owners po
           JOIN contacts c ON c.id = po.owner_contact_id
          WHERE po.property_id = p.id
            AND (po.effective_to IS NULL OR po.effective_to >= current_date)
          ORDER BY po.is_primary DESC, po.created_at
          LIMIT 1
       ) owner ON true
      WHERE o.environment = 'live'
        AND l.status = 'active'
        AND l.renewal_status IS DISTINCT FROM 'renewed'
        AND l.end_date IS NOT NULL
        AND (l.end_date - (timezone('Asia/Taipei', now()))::date) IN (60, 30, 7)`,
  );
  return rows.rows;
}

async function loadInvoices() {
  const rows = await query<InvoiceSqlRow>(
    `SELECT i.id::text AS invoice_id, i.org_id::text AS org_id, o.environment::text AS environment,
            i.due_date::text AS due_date, coalesce(i.period_start, i.due_date)::text AS period_start,
            i.balance_minor::text AS balance_minor, o.name AS org_name,
            o.contact_email::text AS contact_email, o.contact_phone, o.settings,
            p.name AS property_name, coalesce(nullif(p.address_display, ''), p.name) AS address,
            u.label AS unit_label, r.label AS room_label,
            (${TENANTS_SQL}) AS tenants
       FROM invoices i
       JOIN organizations o ON o.id = i.org_id
       JOIN leases l ON l.id = i.lease_id
       JOIN properties p ON p.id = i.property_id
       JOIN units u ON u.id = l.unit_id
       LEFT JOIN rooms r ON r.id = l.target_room_id
      WHERE o.environment = 'live'
        AND i.status IN ('open', 'partially_paid')
        AND i.balance_minor > 0
        AND ((timezone('Asia/Taipei', now()))::date - i.due_date) IN (1, 7)
        AND (
          EXISTS (
            SELECT 1 FROM invoice_lines il
             WHERE il.invoice_id = i.id AND il.charge_type = 'rent' AND il.amount_minor > 0
          )
          OR (
            i.source = 'recurring'
            AND NOT EXISTS (
              SELECT 1 FROM invoice_lines il
               WHERE il.invoice_id = i.id AND il.charge_type <> 'rent'
            )
          )
        )`,
  );
  return rows.rows;
}

export function isLegacyReminderClaimFenced(error: unknown): boolean {
  const e=error as {code?:string;message?:string} | null;
  return Boolean(e && ((e.code === "42501" && e.message === "Legacy reminder claim unavailable") || e.code === "55P03"));
}

function dbStore(): ClaimStore {
  return {
    async claim(plan) {
      try {
        const row = await query<{ id: string }>(
          `INSERT INTO email_log (org_id, kind, target_id, threshold)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, kind, target_id, threshold) WHERE kind <> 'password_reset'
           DO NOTHING
           RETURNING id::text AS id`,
          [plan.orgId, plan.kind, plan.targetId, plan.threshold],
        );
        return row.rows[0]?.id ?? null;
      } catch (error) {
        // A new owner or concurrent switch suppresses this occurrence without
        // stopping other organizations in the legacy cron. No send was attempted.
        if (isLegacyReminderClaimFenced(error)) return null;
        throw error;
      }
    },
    async complete(id, messageId) {
      await query(`UPDATE email_log SET message_id = $2, sent_at = now() WHERE id = $1`, [id, messageId]);
    },
    async release(id) {
      await query(`DELETE FROM email_log WHERE id = $1 AND message_id IS NULL`, [id]);
    },
    send: sendMail,
  };
}

export async function runDueReminders(now = new Date()) {
  const ready = await mailReady();
  if (!ready.ok) {
    console.warn(`reminders skipped: ${ready.reason}`);
    return { sent: 0, skipped: ready.reason };
  }
  const today = taipeiToday(now);
  const origin = publicSiteOrigin("");
  const [leases, invoices] = await Promise.all([loadLeases(), loadInvoices()]);
  const orgIds = [...new Set([...leases.map((row) => row.org_id), ...invoices.map((row) => row.org_id)])];
  const staff = await loadStaff(orgIds);
  const plans: ReminderPlan[] = [];
  for (const row of leases) {
    plans.push(
      ...planLeaseReminders(
        {
          orgId: row.org_id,
          leaseId: row.lease_id,
          environment: row.environment,
          status: row.status,
          renewalStatus: row.renewal_status,
          startDate: row.start_date,
          endDate: row.end_date,
          rentMinor: row.rent_minor,
          orgName: row.org_name,
          contactEmail: row.contact_email,
          contactPhone: row.contact_phone,
          settings: row.settings,
          propertyName: row.property_name,
          address: row.address,
          unitLabel: row.unit_label,
          roomLabel: row.room_label,
          ownerName: row.owner_name,
          tenants: row.tenants,
          staff: staff.get(row.org_id) ?? [],
          origin,
        },
        today,
      ),
    );
  }
  for (const row of invoices) {
    plans.push(
      ...planOverdueReminders(
        {
          orgId: row.org_id,
          invoiceId: row.invoice_id,
          environment: row.environment,
          dueDate: row.due_date,
          periodStart: row.period_start,
          balanceMinor: row.balance_minor,
          orgName: row.org_name,
          contactEmail: row.contact_email,
          contactPhone: row.contact_phone,
          settings: row.settings,
          propertyName: row.property_name,
          address: row.address,
          unitLabel: row.unit_label,
          roomLabel: row.room_label,
          tenants: row.tenants,
          staff: staff.get(row.org_id) ?? [],
          origin,
        },
        today,
      ),
    );
  }
  const sent = await deliverReminders(plans, dbStore());
  return { sent, skipped: null as string | null };
}
