import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { withClient } from "./db";
import { captureHandoverBeforeDemoReset } from "./handover-demo-reset";
import { buildStoredConsent, writeConsentSql } from "./consent";
import { DEMO_PASSWORD } from "./demo-password";
import { seedSampleCheck } from "./id-docs";
import { FIRM2_NAME, FIRM_NAME, ORG2_ID, ORG_ID, USERS } from "./ids";

const KEEP = new Set([
  "currencies",
  "platform_settings",
  "partner_codes",
  "jurisdictions",
  "jurisdiction_rules",
  "lease_templates",
  "lease_template_versions",
]);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function wipe(client: Client) {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  await client.query("SET session_replication_role = replica");
  // These specific private tables refer to demo rows wiped below. Older schemas
  // may not have them yet; leave unrelated private application data alone.
  for (const table of ["b009_row_identities", "b009_decisions"]) {
    if ((await client.query("SELECT to_regclass($1) AS name", [`app.${table}`])).rows[0].name) {
      await client.query(`DELETE FROM app.${table}`);
    }
  }
  for (const name of ["b025_profile_seals", "b025_paper_scans", "b025_received_marks", "b022_report_replies", "b022_receipt_title_revisions", "b014_report_delivery_events", "b014_statement_versions", "b010_payment_confirmations", "b010_lease_collectors", "b008_monthly_rent_commands", "b008_monthly_rent_occurrences", "b013_policy_commands", "b013_override_revisions", "b013_default_revisions", "b013_default_roots", "b015_edit_commands", "b017_center_resolutions", "b028_center_mark_contexts", "b028_center_cursors", "b028_center_reads", "b028_center_recipients", "b028_center_events", "b017_occurrences", "b017_old_source_transactions", "b028_read_markers", "b028_recipient_claims", "b010_payment_commands", "b010_source_events", "b010_tenant_due_preferences"]) {
    const exists = await client.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [`app.${name}`]);
    if (exists.rows[0].present) await client.query(`DELETE FROM app.${quoteIdent(name)}`);
  }
  for (const { tablename } of tables.rows) {
    if (KEEP.has(tablename)) continue;
    await client.query(`DELETE FROM public.${quoteIdent(tablename)}`);
  }
  await client.query("DELETE FROM jurisdiction_rules WHERE org_id IS NOT NULL");
  await client.query("DELETE FROM auth.users");
  await client.query("SET session_replication_role = DEFAULT");
}

function quoteIdent(name: string) {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`unexpected table ${name}`);
  return `"${name}"`;
}

type UserSeed = { id: string; email: string; name: string; phone?: string; locale?: string };

const PEOPLE: UserSeed[] = [
  { id: USERS.admin, email: "yating.lin@songxin.demo", name: "林雅婷", phone: "+886921000001" },
  { id: USERS.manager, email: "zhiming.huang@songxin.demo", name: "黃志明", phone: "+886921000002" },
  { id: USERS.accountant, email: "meiling.zhou@songxin.demo", name: "周美玲", phone: "+886921000003" },
  { id: USERS.maintenance, email: "dawei.wu@songxin.demo", name: "吳大維", phone: "+886921000004" },
  { id: USERS.tenant, email: "yawen.zhang@tenant.demo", name: "張雅文", phone: "+886912111001" },
  { id: USERS.tenant2, email: "xiaomei.wang@tenant.demo", name: "王小美", phone: "+886912111002" },
  { id: USERS.owner, email: "jianhong.chen@owner.demo", name: "陳建宏", phone: "+886923111222" },
  { id: USERS.owner2, email: "xiuying.lin@owner.demo", name: "林秀英", phone: "+886923111333" },
  { id: USERS.coastAdmin, email: "admin@coast.demo", name: "高海明", phone: "+886921000099" },
];

export async function resetAndSeed() {
  await withClient(async (client) => {
  try {
    await client.query("BEGIN");
    // All feature writers take SHARE admission before mutable parents. This
    // must also fence center-only schemas that predate the handover hook.
    await client.query("LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE");
    // Older disposable schemas may predate B011. On newer schemas, capture
    // object tombstones before any public-parent mutation in this transaction.
    const handover = await client.query<{present:boolean}>(`SELECT to_regclass('app.handover_records') IS NOT NULL AS present`);
    if (handover.rows[0].present) await captureHandoverBeforeDemoReset(client);
    await wipe(client);

    for (const person of PEOPLE) {
      await client.query(
        `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
         VALUES ($1, $2, crypt($3, gen_salt('bf')), $4::jsonb, now(), 'authenticated', 'authenticated')`,
        [person.id, person.email, DEMO_PASSWORD, JSON.stringify({ name: person.name })],
      );
      const consent = buildStoredConsent("signup");
      await client.query(
        `INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source)
         VALUES ($1, $2, $3, $4, $5)`,
        [person.id, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source],
      );
      await writeConsentSql(person.id, consent, client);
      await client.query(
        `INSERT INTO profiles (id, display_name, email, phone_e164, locale, timezone, line_linked)
         VALUES ($1, $2, $3, $4, $5, 'Asia/Taipei', $6)`,
        [person.id, person.name, person.email, person.phone ?? null, person.locale ?? "zh-TW", person.id === USERS.manager],
      );
    }

    const tw = await client.query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code = 'TW'`);
    const ca = await client.query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code = 'US-CA'`);
    const twId = tw.rows[0].id;
    const caId = ca.rows[0].id;

    await client.query(
      `INSERT INTO organizations (
         id, name, legal_name, tax_id, country_code, jurisdiction_id, default_currency, default_locale,
         timezone, is_rental_mgmt_business, rental_mgmt_license_no, plan_tier, created_by, settings, feature_flags, live_enabled
       ) VALUES (
         $1, $2, $3, '82838485', 'TW', $4, 'TWD', 'zh-TW', 'Asia/Taipei', true, '北市租管字第1234號', 'beta', $5,
         '{"tryout":{"property":false,"lease":false,"statement":false}}'::jsonb,
         '{"line_alerts":true,"branded_line_oa":false}'::jsonb, true
       )`,
      [ORG_ID, FIRM_NAME, `${FIRM_NAME}有限公司`, twId, USERS.admin],
    );
    await client.query(
      `INSERT INTO organizations (
         id, name, legal_name, country_code, jurisdiction_id, default_currency, default_locale, timezone,
         is_rental_mgmt_business, rental_mgmt_license_no, created_by, live_enabled
       ) VALUES ($1, $2, $2, 'TW', $3, 'TWD', 'zh-TW', 'Asia/Taipei', true, '北市租管字第5678號', $4, true)`,
      [ORG2_ID, FIRM2_NAME, twId, USERS.coastAdmin],
    );

    const members: { org: string; user: string; role: string; billing: boolean; title: string }[] = [
      { org: ORG_ID, user: USERS.admin, role: "admin", billing: true, title: "負責人" },
      { org: ORG_ID, user: USERS.manager, role: "manager", billing: false, title: "物業經理" },
      { org: ORG_ID, user: USERS.accountant, role: "accountant", billing: false, title: "會計" },
      { org: ORG_ID, user: USERS.maintenance, role: "maintenance", billing: false, title: "維修" },
      { org: ORG2_ID, user: USERS.coastAdmin, role: "admin", billing: true, title: "負責人" },
    ];
    const memberIds = new Map<string, string>();
    for (const member of members) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status, title)
         VALUES ($1, $2, $3::org_role, $4, 'active', $5) RETURNING id`,
        [member.org, member.user, member.role, member.billing, member.title],
      );
      memberIds.set(`${member.org}:${member.user}`, inserted.rows[0].id);
    }

    const feeTwd = randomUUID();
    const feeUsd = randomUUID();
    await client.query(
      `INSERT INTO fee_rules (id, org_id, name, purpose, kind, basis, currency, percent_bp)
       VALUES ($1, $2, '管理費 8%', 'management_fee', 'percent', 'collected_rent', 'TWD', 800),
              ($3, $2, 'Management fee 8%', 'management_fee', 'percent', 'collected_rent', 'USD', 800)`,
      [feeTwd, ORG_ID, feeUsd],
    );

    const ids = {
      chen: randomUUID(),
      lin: randomUUID(),
      wang: randomUUID(),
      zhang: randomUUID(),
      li: randomUUID(),
      morgan: randomUUID(),
      alex: randomUUID(),
      vendor: randomUUID(),
      coastZhang: randomUUID(),
      xinyi: randomUUID(),
      daan: randomUUID(),
      oakland: randomUUID(),
      coastProp: randomUUID(),
    };

    const contacts: unknown[][] = [
      [ids.chen, ORG_ID, USERS.owner, true, false, false, "陳建宏", "chen.owner@demo.mail", "+886923111222"],
      [ids.lin, ORG_ID, USERS.owner2, true, false, false, "林秀英", "lin.owner@demo.mail", "+886923111333"],
      [ids.wang, ORG_ID, USERS.tenant2, false, true, false, "王小美", "xiaomei.wang@tenant.demo", "+886912111002"],
      [ids.zhang, ORG_ID, USERS.tenant, false, true, false, "張雅文", "yawen.zhang@tenant.demo", "+886912111001"],
      [ids.li, ORG_ID, null, false, true, false, "李愛玲", "ailing.li@tenant.demo", "+886912111003"],
      [ids.morgan, ORG_ID, null, true, false, false, "Morgan Lee", "morgan.lee@owner.demo", "+14155550100"],
      [ids.alex, ORG_ID, null, false, true, false, "Alex Kim", "alex.kim@tenant.demo", "+14155550199"],
      [ids.vendor, ORG_ID, null, false, false, true, "老張水電", "zhang.plumber@vendor.demo", "+886922000777"],
      [ids.coastZhang, ORG2_ID, USERS.tenant, false, true, false, "張雅文", "yawen.zhang@tenant.demo", "+886912111001"],
    ];
    for (const row of contacts) {
      await client.query(
        `INSERT INTO contacts (id, org_id, user_id, is_owner, is_tenant, is_vendor, display_name, email, phone_e164, locale, vendor_trade)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $7 IN ('Morgan Lee','Alex Kim') THEN 'en' ELSE 'zh-TW' END,
                 CASE WHEN $6 THEN '水電' ELSE NULL END)`,
        row,
      );
    }

    await client.query(
      `INSERT INTO properties (id, org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode)
       VALUES
       ($1,$2,'信義松仁',$3::jsonb,'台北市信義區松仁路88號','TW',$4,'TWD','Asia/Taipei','by_room'),
       ($5,$2,'大安和平',$6::jsonb,'台北市大安區和平東路二段10號','TW',$4,'TWD','Asia/Taipei','whole_unit'),
       ($7,$2,'Oakland 12th',$8::jsonb,'1200 12th St, Oakland, CA 94607','US',$9,'USD','America/Los_Angeles','whole_unit')`,
      [
        ids.xinyi,
        ORG_ID,
        JSON.stringify({ country: "TW", city: "台北市", district: "信義區", street: "松仁路88號", postal: "110" }),
        twId,
        ids.daan,
        JSON.stringify({ country: "TW", city: "台北市", district: "大安區", street: "和平東路二段10號", postal: "106" }),
        ids.oakland,
        JSON.stringify({ country: "US", street: "1200 12th St", city: "Oakland", region: "CA", postal: "94607" }),
        caId,
      ],
    );
    await client.query(
      `INSERT INTO properties (id, org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode)
       VALUES ($1,$2,'延平北路',$3::jsonb,'台北市大同區延平北路一段20號','TW',$4,'TWD','Asia/Taipei','by_room')`,
      [
        ids.coastProp,
        ORG2_ID,
        JSON.stringify({ country: "TW", city: "台北市", district: "大同區", street: "延平北路一段20號" }),
        twId,
      ],
    );

    await client.query(
      `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary, can_view_tenant_phone, effective_from)
       VALUES
       ($1,$2,$3,true,false,(date_trunc('month', current_date) - interval '2 months')::date),
       ($1,$4,$5,true,true,(date_trunc('month', current_date) - interval '2 months')::date),
       ($1,$6,$7,true,false,(date_trunc('month', current_date) - interval '2 months')::date)`,
      [ORG_ID, ids.xinyi, ids.chen, ids.daan, ids.lin, ids.oakland, ids.morgan],
    );

    await client.query(
      `INSERT INTO management_agreements (org_id, owner_contact_id, fee_rule_id, effective_from)
       VALUES ($1,$2,$3, current_date - 365), ($1,$4,$3, current_date - 365), ($1,$5,$6, current_date - 180)`,
      [ORG_ID, ids.chen, feeTwd, ids.lin, ids.morgan, feeUsd],
    );

    const unitXinyi = randomUUID();
    const unitDaan = randomUUID();
    const unitOak = randomUUID();
    const unitCoast = randomUUID();
    await client.query(
      `INSERT INTO units (id, org_id, property_id, label, floor, rental_mode, area_unit, bedrooms)
       VALUES
       ($1,$2,$3,'3F','3','by_room','ping',3),
       ($4,$2,$5,'2F','2','whole_unit','ping',2),
       ($6,$2,$7,'Apt 2B','2','whole_unit','sqft',1),
       ($8,$9,$10,'5F','5','by_room','ping',2)`,
      [unitXinyi, ORG_ID, ids.xinyi, unitDaan, ids.daan, unitOak, ids.oakland, unitCoast, ORG2_ID, ids.coastProp],
    );

    const roomA = randomUUID();
    const roomB = randomUUID();
    const roomC = randomUUID();
    const roomCoast = randomUUID();
    await client.query(
      `INSERT INTO rooms (id, org_id, unit_id, label, room_type, base_rent_minor, area_unit)
       VALUES
       ($1,$2,$3,'A','suite',1200000,'ping'),
       ($4,$2,$3,'B','shared_bath',1000000,'ping'),
       ($5,$2,$3,'C','suite',1100000,'ping'),
       ($6,$7,$8,'A','suite',900000,'ping')`,
      [roomA, ORG_ID, unitXinyi, roomB, roomC, roomCoast, ORG2_ID, unitCoast],
    );

    async function lease(spec: {
      org: string;
      property: string;
      unit: string;
      room: string | null;
      contact: string;
      rent: number;
      depositMonths: number;
      currency: string;
    }) {
      const id = randomUUID();
      const hash = sha256(`${id}:${spec.rent}`);
      await client.query(
        `INSERT INTO leases (
           id, org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
           start_date, end_date, currency, rent_amount_minor, due_day, prorate_first_period,
           deposit_amount_minor, deposit_months, document_sha256, signed_at, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,'active','fully_signed',
           (date_trunc('month', current_date) - interval '2 months')::date,
           (date_trunc('month', current_date) + interval '10 months')::date,
           $7,$8,5,false,$9,$10,$11, now(), $12
         )`,
        [
          id,
          spec.org,
          spec.property,
          spec.unit,
          spec.room ? null : spec.unit,
          spec.room,
          spec.currency,
          spec.rent,
          spec.rent * spec.depositMonths,
          spec.depositMonths,
          hash,
          USERS.admin,
        ],
      );
      await client.query(
        `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
        [spec.org, id, spec.contact],
      );
      const tenantSig = randomUUID();
      const managerSig = randomUUID();
      await client.query(
        `INSERT INTO lease_signatures (id, org_id, lease_id, signer_role, contact_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at)
         VALUES ($1,$2,$3,'tenant',$4,'signed',1,$5,$6,'lease.consent', now())`,
        [tenantSig, spec.org, id, spec.contact, "tenant", hash],
      );
      await client.query(
        `INSERT INTO lease_signatures (id, org_id, lease_id, signer_role, member_id, status, signing_order, signed_name, document_sha256, consent_text_key, signed_at)
         VALUES ($1,$2,$3,'manager',$4,'signed',2,$5,$6,'lease.consent', now())`,
        [managerSig, spec.org, id, memberIds.get(`${spec.org}:${spec.org === ORG_ID ? USERS.admin : USERS.coastAdmin}`), "manager", hash],
      );
      const thread = randomUUID();
      await client.query(
        `INSERT INTO message_threads (id, org_id, kind, lease_id, property_id) VALUES ($1,$2,'lease',$3,$4)`,
        [thread, spec.org, id, spec.property],
      );
      await client.query(
        `INSERT INTO thread_participants (org_id, thread_id, contact_id) VALUES ($1,$2,$3)`,
        [spec.org, thread, spec.contact],
      );
      const managerMember = memberIds.get(`${spec.org}:${spec.org === ORG_ID ? USERS.admin : USERS.coastAdmin}`);
      if (managerMember) {
        await client.query(
          `INSERT INTO thread_participants (org_id, thread_id, member_id) VALUES ($1,$2,$3)`,
          [spec.org, thread, managerMember],
        );
      }
      return { id, thread, hash };
    }

    const leaseWang = await lease({
      org: ORG_ID, property: ids.xinyi, unit: unitXinyi, room: roomA, contact: ids.wang,
      rent: 1_200_000, depositMonths: 2, currency: "TWD",
    });
    const leaseZhang = await lease({
      org: ORG_ID, property: ids.xinyi, unit: unitXinyi, room: roomB, contact: ids.zhang,
      rent: 1_000_000, depositMonths: 2, currency: "TWD",
    });
    const leaseLi = await lease({
      org: ORG_ID, property: ids.daan, unit: unitDaan, room: null, contact: ids.li,
      rent: 2_800_000, depositMonths: 2, currency: "TWD",
    });
    const leaseAlex = await lease({
      org: ORG_ID, property: ids.oakland, unit: unitOak, room: null, contact: ids.alex,
      rent: 180_000, depositMonths: 1, currency: "USD",
    });
    const leaseCoast = await lease({
      org: ORG2_ID, property: ids.coastProp, unit: unitCoast, room: roomCoast, contact: ids.coastZhang,
      rent: 900_000, depositMonths: 2, currency: "TWD",
    });

    async function bookRent(spec: {
      org: string;
      property: string;
      lease: string;
      contact: string;
      currency: string;
      amount: number;
      number: string;
      paid: boolean;
      user: string;
    }) {
      const invoice = await client.query<{ id: string }>(
        `INSERT INTO invoices (
           org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency,
           issue_date, due_date, period_start, period_end, status, source, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6, current_date - 10, current_date - 3,
           date_trunc('month', current_date)::date,
           (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date,
           'open', 'recurring', $7
         ) RETURNING id`,
        [spec.org, spec.property, spec.lease, spec.contact, spec.number, spec.currency, spec.user],
      );
      const invoiceId = invoice.rows[0].id;
      await client.query(
        `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
         VALUES ($1,$2,1,'rent',$3,1,$4,$5)`,
        [spec.org, invoiceId, "rent", spec.amount, spec.amount],
      );
      const txn = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by)
         VALUES ($1,$2,$3,'invoice',$4, current_date - 10, $5, 'invoices', $6, $7) RETURNING id`,
        [spec.org, spec.property, spec.lease, spec.currency, spec.number, invoiceId, spec.user],
      );
      await client.query(
        `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id)
         VALUES ($1,$2,'tenant_receivable',$3,$4,$5,$6,$7,$8),
                ($1,$2,'rental_income',$9,$4,$5,$6,$7,$8)`,
        [spec.org, txn.rows[0].id, spec.amount, spec.currency, spec.contact, spec.property, spec.lease, invoiceId, -spec.amount],
      );
      await client.query(`UPDATE invoices SET ledger_transaction_id = $2 WHERE id = $1`, [invoiceId, txn.rows[0].id]);
      if (!spec.paid) return;
      const payment = await client.query<{ id: string }>(
        `INSERT INTO payments (
           org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method,
           payer_account_last5, status, source, submitted_by, confirmed_by, confirmed_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6, current_date - 3, 'bank_transfer', '13579', 'confirmed', 'manager_entry', $7, $7, now()
         ) RETURNING id`,
        [spec.org, spec.property, spec.lease, spec.contact, spec.currency, spec.amount, spec.user],
      );
      await client.query(
        `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [spec.org, payment.rows[0].id, invoiceId, spec.amount, spec.user],
      );
      const payTxn = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by)
         VALUES ($1,$2,$3,'payment',$4, current_date - 3, $5, 'payments', $6, $7) RETURNING id`,
        [spec.org, spec.property, spec.lease, spec.currency, spec.number, payment.rows[0].id, spec.user],
      );
      await client.query(
        `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id)
         VALUES ($1,$2,'cash_clearing',$3,$4,$5,$6,$7,$8),
                ($1,$2,'tenant_receivable',$9,$4,$5,$6,$7,$8)`,
        [spec.org, payTxn.rows[0].id, spec.amount, spec.currency, spec.contact, spec.property, spec.lease, invoiceId, -spec.amount],
      );
      await client.query(`UPDATE payments SET ledger_transaction_id = $2 WHERE id = $1`, [payment.rows[0].id, payTxn.rows[0].id]);
    }

    await bookRent({ org: ORG_ID, property: ids.xinyi, lease: leaseWang.id, contact: ids.wang, currency: "TWD", amount: 1_200_000, number: "INV-SEED-001", paid: false, user: USERS.admin });
    await bookRent({ org: ORG_ID, property: ids.xinyi, lease: leaseZhang.id, contact: ids.zhang, currency: "TWD", amount: 1_000_000, number: "INV-SEED-002", paid: true, user: USERS.admin });
    await bookRent({ org: ORG_ID, property: ids.daan, lease: leaseLi.id, contact: ids.li, currency: "TWD", amount: 2_800_000, number: "INV-SEED-003", paid: false, user: USERS.admin });
    await bookRent({ org: ORG_ID, property: ids.oakland, lease: leaseAlex.id, contact: ids.alex, currency: "USD", amount: 180_000, number: "INV-SEED-004", paid: false, user: USERS.admin });
    await bookRent({ org: ORG2_ID, property: ids.coastProp, lease: leaseCoast.id, contact: ids.coastZhang, currency: "TWD", amount: 900_000, number: "INV-COAST-001", paid: false, user: USERS.coastAdmin });

    const maint = memberIds.get(`${ORG_ID}:${USERS.maintenance}`)!;
    await client.query(
      `INSERT INTO maintenance_tickets (
         org_id, ticket_number, property_id, unit_id, room_id, lease_id, category, priority, status, title, description,
         reported_by_user, reported_by_contact_id, currency
       ) VALUES (
         $1, 1001, $2, $3, $4, $5, 'plumbing', 'high', 'open', '浴室水龍頭滲水', '洗手台下方有水漬。',
         $6, $7, 'TWD'
       )`,
      [ORG_ID, ids.xinyi, unitXinyi, roomA, leaseWang.id, USERS.tenant2, ids.wang],
    );
    await client.query(
      `INSERT INTO maintenance_tickets (
         org_id, ticket_number, property_id, unit_id, room_id, lease_id, category, priority, status, title, description,
         reported_by_user, reported_by_contact_id, assigned_member_id, currency, estimated_cost_minor, cost_bearer
       ) VALUES (
         $1, 1002, $2, $3, $4, $5, 'electrical', 'normal', 'in_progress', '房間燈管不亮', 'A 房主燈全暗。',
         $6, $7, $8, 'TWD', 150000, 'owner'
       )`,
      [ORG_ID, ids.xinyi, unitXinyi, roomA, leaseWang.id, USERS.tenant2, ids.wang, maint],
    );

    await client.query(
      `INSERT INTO messages (org_id, thread_id, sender_user_id, sender_contact_id, body, inbound_channel)
       VALUES ($1,$2,$3,$4,'請問這個月的匯款末五碼是 24680。','in_app')`,
      [ORG_ID, leaseWang.thread, USERS.tenant2, ids.wang],
    );
    await client.query(
      `INSERT INTO messages (org_id, thread_id, sender_user_id, sender_member_id, body, inbound_channel)
       VALUES ($1,$2,$3,$4,'已記下末五碼，對帳完成後會在軟體裡把狀態改成已確認。','in_app')`,
      [ORG_ID, leaseWang.thread, USERS.admin, memberIds.get(`${ORG_ID}:${USERS.admin}`)],
    );

    await client.query(
      `INSERT INTO bank_accounts (org_id, nickname, bank_name, bank_code, account_last5, currency, show_to_tenants)
       VALUES ($1,'租金匯款帳戶','玉山銀行','808','88921','TWD',true),
              ($2,'租金匯款帳戶','台新銀行','812','44556','TWD',true)`,
      [ORG_ID, ORG2_ID],
    );

    const channel = await client.query<{ id: string }>(
      `INSERT INTO line_channels (
         mode, display_name, line_provider_id, messaging_channel_id,
         messaging_channel_secret_ref, messaging_access_token_ref, liff_app_id, oa_basic_id,
         rich_menu_linked_id, rich_menu_unlinked_id
       ) VALUES (
         'platform_default', '租多啦租客通知（範例）', 'provider-demo', 'channel-demo',
         'vault://demo/line/secret', 'vault://demo/line/token', '1234567890-demoLiff', '@condola-demo',
         'rich-menu-linked-demo', 'rich-menu-unlinked-demo'
       ) RETURNING id`,
    );
    await client.query(`UPDATE organizations SET line_channel_id = $2 WHERE id = $1`, [ORG_ID, channel.rows[0].id]);
    const lineUsers = [
      [ORG_ID, ids.wang, `U${"a".repeat(32)}`],
      [ORG_ID, ids.zhang, `U${"b".repeat(32)}`],
      [ORG2_ID, ids.coastZhang, `U${"b".repeat(32)}`],
    ];
    for (const [orgId, contactId, lineUserId] of lineUsers) {
      await client.query(
        `INSERT INTO line_account_links (org_id, contact_id, line_channel_id, line_user_id, status, is_friend, consent_text_key, consented_at, linked_at)
         VALUES ($1,$2,$3,$4,'linked',true,'line.consent', now(), now())`,
        [orgId, contactId, channel.rows[0].id, lineUserId],
      );
    }

    await client.query(
      `INSERT INTO notifications (org_id, event_type, template_key, recipient_contact_id, recipient_user_id, lease_id, locale, dedupe_key, status)
       VALUES ($1,'rent_due','notifications.rent_due',$2,$3,$4,'zh-TW',$5,'queued')`,
      [ORG_ID, ids.wang, USERS.tenant2, leaseWang.id, `rent_due:${leaseWang.id}`],
    );
    const notice = await client.query<{ id: string }>(
      `SELECT id FROM notifications WHERE org_id = $1 AND dedupe_key = $2`,
      [ORG_ID, `rent_due:${leaseWang.id}`],
    );
    await client.query(
      `INSERT INTO deliveries (org_id, notification_id, channel, recipient_contact_id, status, provider, counts_toward_quota, error)
       VALUES ($1,$2,'line',$3,'skipped','demo_line',false,'demo_not_sent')`,
      [ORG_ID, notice.rows[0].id, ids.wang],
    );

    for (const event of ["rent_due", "rent_overdue", "lease_to_sign", "payment_confirmed", "ticket_update"]) {
      await client.query(
        `INSERT INTO reminder_rules (org_id, event_type, offsets_days, channels)
         VALUES ($1,$2,$3::smallint[],'{line,email}')`,
        [ORG_ID, event, event === "rent_due" ? [-3, 0] : event === "rent_overdue" ? [1, 7] : [0]],
      );
    }

    const acRepair = await client.query<{ id: string }>(
      `INSERT INTO expenses (
         org_id, property_id, category, description, currency, amount_minor, incurred_on,
         paid_by, bill_to, status, approved_by, approved_at, created_by
       ) VALUES (
         $1, $2, 'repair', '冷氣維修', 'TWD', 280000,
         (date_trunc('month', current_date) + interval '1 month')::date,
         'manager_firm', 'owner', 'approved', $3, now(), $3
       ) RETURNING id`,
      [ORG_ID, ids.xinyi, USERS.admin],
    );
    const november = await client.query<{ id: string }>(
      `INSERT INTO owner_statements (
         org_id, owner_contact_id, currency, period_start, period_end, status,
         opening_balance_minor, rent_received_minor, other_income_minor, management_fee_minor,
         expenses_minor, payouts_minor, closing_balance_minor, fee_rule_snapshot, locale,
         einvoice_status, issued_at, issued_by
       ) VALUES (
         $1, $2, 'TWD',
         (date_trunc('month', current_date) + interval '1 month')::date,
         (date_trunc('month', current_date) + interval '2 months' - interval '1 day')::date,
         'issued', 0, 0, 0, 0, 280000, 0, -280000,
         '{"name":"管理費 8%"}'::jsonb, 'zh-TW', 'not_applicable', now(), $3
       ) RETURNING id`,
      [ORG_ID, ids.chen, USERS.admin],
    );
    await client.query(
      `INSERT INTO owner_statement_lines (org_id, statement_id, property_id, line_type, description, amount_minor, expense_id)
       VALUES ($1, $2, $3, 'expense', '冷氣維修', 280000, $4)`,
      [ORG_ID, november.rows[0].id, ids.xinyi, acRepair.rows[0].id],
    );

    await seedSampleCheck(client, {
      orgId: ORG_ID,
      contactId: ids.zhang,
      leaseId: leaseZhang.id,
      createdBy: USERS.tenant,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  });
}

const isDirect = process.argv[1]?.endsWith("seed.ts");
if (isDirect) {
  resetAndSeed()
    .then(() => {
      console.log("Seeded Condola demo data.");
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
