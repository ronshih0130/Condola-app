import type { Client } from "pg";
import { writeAudit } from "./audit";
import { seatLimit } from "./billing";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import { recordFunnel } from "./funnel";
import { goLiveLocked } from "./platform";
import {
  COPY_KINDS,
  FREE_ACTIVE_UNITS,
  NEVER_KINDS,
  goLiveAllowed,
  loadSampleRows,
  planSnapshot,
  sampleCounts,
  type PlanSnapshot,
  type SampleCounts,
} from "./sandbox-data";
import { runSandboxSeed } from "./sandbox-seed";
import { assertStaff, type Session } from "./types";

async function tableExists(client: Client, name: string) {
  const found = await client.query<{ rel: string | null }>(`SELECT to_regclass($1) AS rel`, [`public.${name}`]);
  return Boolean(found.rows[0]?.rel);
}

export async function sandboxForLive(liveOrgId: string) {
  const row = await query<{ id: string }>(
    `SELECT id::text FROM organizations WHERE live_org_id = $1 AND environment = 'sandbox'`,
    [liveOrgId],
  );
  return row.rows[0]?.id ?? null;
}

/** Create the linked sandbox and copy active members. The live firm must already be visible on this client. */
export async function insertSandboxOrg(client: Client, liveOrgId: string, userId: string) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO organizations (
       name, legal_name, country_code, jurisdiction_id, default_currency, default_locale, timezone,
       date_calendar, id_doc_retention_days, is_rental_mgmt_business, rental_mgmt_license_no,
       plan_tier, feature_flags, settings, environment, live_org_id, created_by
     )
     SELECT name, legal_name, country_code, jurisdiction_id, default_currency, default_locale, timezone,
            date_calendar, id_doc_retention_days, is_rental_mgmt_business, rental_mgmt_license_no,
            'free', feature_flags, '{"sandboxPrompt":"open"}'::jsonb,
            'sandbox', id, $2
       FROM organizations
      WHERE id = $1 AND environment = 'live'
     RETURNING id::text`,
    [liveOrgId, userId],
  );
  const sandboxId = inserted.rows[0]?.id;
  if (!sandboxId) throw new FlowError("errors.notFound");
  await client.query(
    `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status, title)
     SELECT $1, user_id, role, is_billing_owner, status, title
       FROM org_members
      WHERE org_id = $2 AND status = 'active'
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [sandboxId, liveOrgId],
  );
  return sandboxId;
}

/** Sandbox plus its sample portfolio, in the caller's transaction. */
export async function seedSandboxForNewFirm(client: Client, liveOrgId: string, userId: string) {
  const sandboxId = await insertSandboxOrg(client, liveOrgId, userId);
  await client.query(
    `UPDATE organizations
        SET sample_loaded_at = now(),
            settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{sandboxPrompt}', '"loaded"'::jsonb, true)
      WHERE id = $1 AND environment = 'sandbox'`,
    [sandboxId],
  );
  await runSandboxSeed(client, { orgId: sandboxId, actorUserId: userId });
  return sandboxId;
}

export async function ensureSandbox(session: Session) {
  assertStaff(session, ["admin", "manager", "accountant", "maintenance"]);
  const existing = await sandboxForLive(session.liveOrgId);
  if (existing) return existing;
  try {
    return await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const again = await client.query<{ id: string }>(
          `SELECT id::text FROM organizations WHERE live_org_id = $1 AND environment = 'sandbox'`,
          [session.liveOrgId],
        );
        if (again.rows[0]) {
          await client.query("COMMIT");
          return again.rows[0].id;
        }
        const sandboxId = await insertSandboxOrg(client, session.liveOrgId, session.userId);
        await client.query("COMMIT");
        return sandboxId;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "23505") throw error;
    const winner = await sandboxForLive(session.liveOrgId);
    if (!winner) throw error;
    return winner;
  }
}

/** First visit: create the linked sandbox, if it is missing, and load the sample portfolio once. */
export async function openSandboxFirm(session: Session) {
  const sandboxId = await ensureSandbox(session);
  await ensureSampleLoaded({ ...session, orgId: sandboxId, environment: "sandbox" });
  return sandboxId;
}

export async function countActiveUnits(orgId: string) {
  const row = await query<{ n: number }>(
    `SELECT count(DISTINCT coalesce(target_room_id::text, target_unit_id::text))::int AS n
       FROM leases
      WHERE org_id = $1 AND status = 'active' AND signed_at IS NOT NULL
        AND coalesce(target_room_id, target_unit_id) IS NOT NULL`,
    [orgId],
  );
  return row.rows[0]?.n ?? 0;
}

export async function readPlan(orgId: string): Promise<PlanSnapshot> {
  const row = await query<{ plan_tier: string; settings: unknown }>(
    `SELECT plan_tier::text, settings FROM organizations WHERE id = $1`,
    [orgId],
  );
  return planSnapshot(row.rows[0]?.plan_tier, row.rows[0]?.settings ?? null);
}

export async function goLivePreview(session: Session) {
  const activeUnits = await countActiveUnits(session.liveOrgId);
  const plan = await readPlan(session.liveOrgId);
  return {
    activeUnits,
    freeUnits: FREE_ACTIVE_UNITS,
    allowed: goLiveAllowed({ activeUnits, plan, now: new Date() }),
  };
}

export async function sandboxChrome(session: Session | null): Promise<{
  environment: "live" | "sandbox";
  prompt: "open" | "closed";
  loaded: boolean;
  counts: SampleCounts | null;
}> {
  if (!session || session.environment !== "sandbox") {
    return { environment: "live", prompt: "closed", loaded: false, counts: null };
  }
  const row = await query<{ settings: { sandboxPrompt?: string } | null; sample_loaded_at: Date | null }>(
    `SELECT settings, sample_loaded_at FROM organizations WHERE id = $1`,
    [session.orgId],
  );
  const settings = row.rows[0]?.settings;
  const loaded = Boolean(row.rows[0]?.sample_loaded_at) || settings?.sandboxPrompt === "loaded";
  const closed = loaded || settings?.sandboxPrompt === "blank";
  return {
    environment: "sandbox",
    prompt: closed ? "closed" : "open",
    loaded,
    counts: closed ? null : sampleCounts(loadSampleRows()),
  };
}

export async function dismissSamplePrompt(session: Session) {
  if (session.environment !== "sandbox") throw new FlowError("errors.forbidden");
  assertStaff(session, ["admin", "manager", "accountant", "maintenance"]);
  await query(
    `UPDATE organizations
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{sandboxPrompt}', '"blank"'::jsonb, true)
      WHERE id = $1`,
    [session.orgId],
  );
}

const SANDBOX_PORTFOLIO = `
  EXISTS (SELECT 1 FROM properties p WHERE p.org_id = o.id)
  OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = o.id)
  OR EXISTS (SELECT 1 FROM units u WHERE u.org_id = o.id)
  OR EXISTS (SELECT 1 FROM contacts c WHERE c.org_id = o.id)
`;

async function sandboxLoadState(client: Client, orgId: string) {
  const row = await client.query<{ loaded: Date | null; has_data: boolean }>(
    `SELECT o.sample_loaded_at AS loaded, (${SANDBOX_PORTFOLIO}) AS has_data
       FROM organizations o
      WHERE o.id = $1 AND o.environment = 'sandbox'`,
    [orgId],
  );
  return row.rows[0] ?? null;
}

/**
 * Load the sample portfolio when this sandbox has never been seeded and still
 * has no portfolio rows. A conditional update plus a transaction advisory lock
 * lets concurrent requests seed at most once.
 */
export async function ensureSampleLoaded(session: Session) {
  if (session.environment !== "sandbox") throw new FlowError("errors.forbidden");
  assertStaff(session, ["admin", "manager", "accountant", "maintenance"]);
  const peek = await query<{ loaded: Date | null; has_data: boolean }>(
    `SELECT o.sample_loaded_at AS loaded, (${SANDBOX_PORTFOLIO}) AS has_data
       FROM organizations o
      WHERE o.id = $1 AND o.environment = 'sandbox'`,
    [session.orgId],
  );
  const first = peek.rows[0];
  if (!first || first.loaded || first.has_data) return;
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [session.orgId]);
      const state = await sandboxLoadState(client, session.orgId);
      if (!state || state.loaded || state.has_data) {
        await client.query("COMMIT");
        return;
      }
      const claim = await client.query<{ id: string }>(
        `UPDATE organizations
            SET sample_loaded_at = now(),
                settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{sandboxPrompt}', '"loaded"'::jsonb, true)
          WHERE id = $1 AND environment = 'sandbox' AND sample_loaded_at IS NULL
          RETURNING id::text`,
        [session.orgId],
      );
      if (!claim.rows[0]) {
        await client.query("COMMIT");
        return;
      }
      await runSandboxSeed(client, { orgId: session.orgId, actorUserId: session.userId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export const RETIRED_SAMPLE_ADDRESS = "台中市西區範例路 1 號";

const RETIRED_AVENUE = ["示", "範", "大道"].join("");

/** Existing sample firms keep the address they were seeded with. Replace a retired avenue line. */
export async function correctRetiredSampleAddresses(client: { query: Client["query"] }, orgId: string) {
  await client.query(
    `UPDATE properties
        SET address_display = $2,
            address = coalesce(address, '{}'::jsonb) || $3::jsonb
      WHERE org_id = $1
        AND (address_display LIKE '%' || $4 || '%' OR address_display LIKE '%範例大道%')`,
    [
      orgId,
      RETIRED_SAMPLE_ADDRESS,
      JSON.stringify({ country: "TW", city: "台中市", district: "西區", street: "範例路 1 號" }),
      RETIRED_AVENUE,
    ],
  );
}

export async function loadSampleData(session: Session) {
  await ensureSampleLoaded(session);
}

async function copySandboxSetup(sandboxId: string, liveOrgId: string, actorId: string) {
  await withClient(async (client) => {
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE organizations AS live
          SET settings = coalesce(live.settings, '{}'::jsonb) || ((sandbox.settings - 'sandboxPrompt') - 'plan'),
              feature_flags = sandbox.feature_flags,
              default_locale = sandbox.default_locale,
              timezone = sandbox.timezone,
              date_calendar = sandbox.date_calendar,
              id_doc_retention_days = sandbox.id_doc_retention_days
         FROM organizations AS sandbox
        WHERE live.id = $1 AND sandbox.id = $2`,
      [liveOrgId, sandboxId],
    );
    await client.query(
      `INSERT INTO reminder_rules (org_id, event_type, offsets_days, channels, is_enabled)
       SELECT $1, event_type, offsets_days, channels, is_enabled
         FROM reminder_rules WHERE org_id = $2
       ON CONFLICT (org_id, event_type) DO UPDATE
         SET offsets_days = EXCLUDED.offsets_days, channels = EXCLUDED.channels, is_enabled = EXCLUDED.is_enabled`,
      [liveOrgId, sandboxId],
    );

    const portfolio = await tableExists(client, "properties");
    if (portfolio) {
      await client.query(`CREATE TEMP TABLE map_fee (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE map_contact (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE map_property (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE map_unit (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE map_room (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP`);

      await client.query(
        `INSERT INTO map_fee (old_id, new_id)
         SELECT f.id, gen_random_uuid()
           FROM fee_rules f
          WHERE f.org_id = $1 AND f.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = f.org_id AND sm.entity_table = 'fee_rules' AND sm.entity_id = f.id
            )
            AND f.name NOT LIKE '%範例資料%' AND f.name NOT LIKE '%[Sample data]%'`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO fee_rules (
           id, org_id, name, purpose, kind, hybrid_mode, basis, currency, fixed_amount_minor, percent_bp,
           minimum_minor, maximum_minor, rate_minor_per_unit, usage_unit, grace_days, rounding
         )
         SELECT m.new_id, $1, f.name, f.purpose, f.kind, f.hybrid_mode, f.basis, f.currency, f.fixed_amount_minor,
                f.percent_bp, f.minimum_minor, f.maximum_minor, f.rate_minor_per_unit, f.usage_unit, f.grace_days, f.rounding
           FROM fee_rules f JOIN map_fee m ON m.old_id = f.id`,
        [liveOrgId],
      );

      await client.query(
        `INSERT INTO map_contact (old_id, new_id)
         SELECT DISTINCT c.id, gen_random_uuid()
           FROM contacts c
           JOIN property_owners po ON po.owner_contact_id = c.id AND po.org_id = c.org_id
          WHERE c.org_id = $1 AND c.is_owner AND c.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = c.org_id AND sm.entity_table = 'contacts' AND sm.entity_id = c.id
            )
            AND c.display_name NOT LIKE '%範例資料%' AND c.display_name NOT LIKE '%[Sample data]%'`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO contacts (
           id, org_id, user_id, is_owner, is_tenant, is_vendor, display_name, legal_name, email, phone_e164, locale, timezone, notes
         )
         SELECT m.new_id, $1, NULL, true, false, false, c.display_name, c.legal_name, c.email, c.phone_e164, c.locale, c.timezone, c.notes
           FROM contacts c JOIN map_contact m ON m.old_id = c.id`,
        [liveOrgId],
      );

      await client.query(
        `INSERT INTO map_property (old_id, new_id)
         SELECT p.id, gen_random_uuid()
           FROM properties p
          WHERE p.org_id = $1 AND p.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = p.org_id AND sm.entity_table = 'properties' AND sm.entity_id = p.id
            )
            AND p.name NOT LIKE '%範例資料%' AND p.name NOT LIKE '%[Sample data]%'`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO properties (
           id, org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone, default_rental_mode
         )
         SELECT m.new_id, $1, p.name, p.address, p.address_display, p.country_code, p.jurisdiction_id, p.currency, p.timezone, p.default_rental_mode
           FROM properties p JOIN map_property m ON m.old_id = p.id`,
        [liveOrgId],
      );

      await client.query(
        `INSERT INTO map_unit (old_id, new_id)
         SELECT u.id, gen_random_uuid()
           FROM units u
           JOIN map_property mp ON mp.old_id = u.property_id
          WHERE u.org_id = $1 AND u.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = u.org_id AND sm.entity_table = 'units' AND sm.entity_id = u.id
            )
            AND u.label NOT LIKE '%範例資料%' AND u.label NOT LIKE '%[Sample data]%'`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO units (
           id, org_id, property_id, label, floor, rental_mode, bedrooms, bathrooms, area_value, area_unit, base_rent_minor
         )
         SELECT m.new_id, $1, mp.new_id, u.label, u.floor, u.rental_mode, u.bedrooms, u.bathrooms, u.area_value, u.area_unit, u.base_rent_minor
           FROM units u
           JOIN map_unit m ON m.old_id = u.id
           JOIN map_property mp ON mp.old_id = u.property_id`,
        [liveOrgId],
      );

      await client.query(
        `INSERT INTO map_room (old_id, new_id)
         SELECT r.id, gen_random_uuid()
           FROM rooms r
           JOIN map_unit mu ON mu.old_id = r.unit_id
          WHERE r.org_id = $1 AND r.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = r.org_id AND sm.entity_table = 'rooms' AND sm.entity_id = r.id
            )
            AND r.label NOT LIKE '%範例資料%' AND r.label NOT LIKE '%[Sample data]%'`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO rooms (id, org_id, unit_id, label, room_type, area_value, area_unit, base_rent_minor)
         SELECT m.new_id, $1, mu.new_id, r.label, r.room_type, r.area_value, r.area_unit, r.base_rent_minor
           FROM rooms r
           JOIN map_room m ON m.old_id = r.id
           JOIN map_unit mu ON mu.old_id = r.unit_id`,
        [liveOrgId],
      );

      await client.query(
        `INSERT INTO property_owners (
           org_id, property_id, owner_contact_id, ownership_bp, is_primary, repair_approval_threshold_minor,
           can_view_tenant_phone, effective_from, effective_to
         )
         SELECT $1, mp.new_id, mc.new_id, po.ownership_bp, po.is_primary, po.repair_approval_threshold_minor,
                po.can_view_tenant_phone, po.effective_from, po.effective_to
           FROM property_owners po
           JOIN map_property mp ON mp.old_id = po.property_id
           JOIN map_contact mc ON mc.old_id = po.owner_contact_id
          WHERE po.org_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = po.org_id AND sm.entity_table = 'property_owners' AND sm.entity_id = po.id
            )`,
        [liveOrgId, sandboxId],
      );

      await client.query(
        `INSERT INTO management_agreements (org_id, owner_contact_id, property_id, fee_rule_id, effective_from, effective_to)
         SELECT $1, mc.new_id, mp.new_id, mf.new_id, a.effective_from, a.effective_to
           FROM management_agreements a
           JOIN map_contact mc ON mc.old_id = a.owner_contact_id
           JOIN map_fee mf ON mf.old_id = a.fee_rule_id
           LEFT JOIN map_property mp ON mp.old_id = a.property_id
          WHERE a.org_id = $2 AND (a.property_id IS NULL OR mp.new_id IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = a.org_id AND sm.entity_table = 'management_agreements' AND sm.entity_id = a.id
            )`,
        [liveOrgId, sandboxId],
      );

      await client.query(
        `INSERT INTO bank_accounts (
           org_id, property_id, owner_contact_id, nickname, bank_name, bank_code, branch_code, account_last5, currency, show_to_tenants
         )
         SELECT $1, mp.new_id, mc.new_id, b.nickname, b.bank_name, b.bank_code, b.branch_code, b.account_last5, b.currency, b.show_to_tenants
           FROM bank_accounts b
           LEFT JOIN map_property mp ON mp.old_id = b.property_id
           LEFT JOIN map_contact mc ON mc.old_id = b.owner_contact_id
          WHERE b.org_id = $2 AND b.archived_at IS NULL
            AND (b.property_id IS NULL OR mp.new_id IS NOT NULL)
            AND (b.owner_contact_id IS NULL OR mc.new_id IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM sample_marks sm
               WHERE sm.org_id = b.org_id AND sm.entity_table = 'bank_accounts' AND sm.entity_id = b.id
            )
            AND coalesce(b.nickname, '') NOT LIKE '%範例資料%'
            AND coalesce(b.nickname, '') NOT LIKE '%[Sample data]%'`,
        [liveOrgId, sandboxId],
      );
    }

    await client.query(
      `INSERT INTO invitations (org_id, kind, role, email, code_hash, status, expires_at, invited_by)
       SELECT $1, 'team_member', role, email, encode(gen_random_bytes(32), 'hex'), 'pending', expires_at, $3
         FROM invitations
        WHERE org_id = $2 AND kind = 'team_member' AND status = 'pending' AND expires_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM sample_marks sm
             WHERE sm.org_id = invitations.org_id AND sm.entity_table = 'invitations' AND sm.entity_id = invitations.id
          )`,
      [liveOrgId, sandboxId, actorId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  });
}

/** Go-live stays open unless the platform emergency pause is on. The per-firm live_enabled column is no longer the gate. */
export async function liveModeEnabled(orgId?: string) {
  void orgId;
  return !(await goLiveLocked());
}

async function dropExtraLiveInvites(liveOrgId: string, actorId: string) {
  const plan = await readPlan(liveOrgId);
  const limit = seatLimit(plan.tier);
  if (limit == null) return;
  const usage = await query<{ members: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM org_members WHERE org_id = $1 AND status = 'active') AS members,
       (SELECT count(*)::int FROM invitations
         WHERE org_id = $1 AND kind = 'team_member' AND status = 'pending' AND expires_at > now()) AS pending`,
    [liveOrgId],
  );
  const overflow = (usage.rows[0]?.members ?? 0) + (usage.rows[0]?.pending ?? 0) - limit;
  if (overflow <= 0) return;
  const dropped = await query<{ email: string }>(
    `UPDATE invitations SET status = 'revoked'
      WHERE id IN (
        SELECT id FROM invitations
         WHERE org_id = $1 AND kind = 'team_member' AND status = 'pending' AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT $2
      )
      RETURNING email::text AS email`,
    [liveOrgId, overflow],
  );
  if (dropped.rows.length) {
    await writeAudit(liveOrgId, actorId, "go_live_invites_dropped", { emails: dropped.rows.map((row) => row.email) });
  }
}

export async function goLive(session: Session, copy: boolean) {
  assertStaff(session, ["admin", "manager", "accountant", "maintenance"]);
  if (!(await liveModeEnabled(session.liveOrgId))) throw new FlowError("errors.forbidden");
  const sandboxId = await sandboxForLive(session.liveOrgId);
  if (!sandboxId) throw new FlowError("errors.notFound");
  const activeUnits = await countActiveUnits(session.liveOrgId);
  const plan = await readPlan(session.liveOrgId);
  if (!goLiveAllowed({ activeUnits, plan, now: new Date() })) throw new FlowError("errors.planLimit");
  if (copy && session.role !== "admin") throw new FlowError("errors.forbidden");
  if (copy) {
    await copySandboxSetup(sandboxId, session.liveOrgId, session.userId);
    await dropExtraLiveInvites(session.liveOrgId, session.userId);
  }
  await query(`UPDATE organizations SET live_started_at = coalesce(live_started_at, now()) WHERE id = $1`, [session.liveOrgId]);
  await writeAudit(session.liveOrgId, session.userId, "go_live", {
    copy,
    copied: copy ? [...COPY_KINDS] : [],
    notCopied: [...NEVER_KINDS],
    owners: copy ? "copied_without_portal_login" : "not_copied",
  });
  await recordFunnel("golive", { userId: session.userId, orgId: session.liveOrgId, email: session.email, detail: { copy } });
  return sandboxId;
}
