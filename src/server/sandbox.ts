import type { Client } from "pg";
import { BILLABLE_ACTIVE_LEASE } from "./billing";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import { goLiveLocked } from "./platform";
import { loadSampleRows, sampleCounts, type SampleCounts } from "./sandbox-data";
import { runSandboxSeed } from "./sandbox-seed";
import { assertStaff, type Session } from "./types";

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
            'free', coalesce(feature_flags, '{}'::jsonb) || '{"rent_settlement": true}'::jsonb,
            '{"sandboxPrompt":"open"}'::jsonb,
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
      WHERE org_id = $1 AND ${BILLABLE_ACTIVE_LEASE}
        AND coalesce(target_room_id, target_unit_id) IS NOT NULL`,
    [orgId],
  );
  return row.rows[0]?.n ?? 0;
}

export async function sandboxChrome(session: Session | null): Promise<{
  environment: "live" | "sandbox";
  prompt: "open" | "closed";
  loaded: boolean;
  counts: SampleCounts | null;
  /** Live firm already has data, so the sandbox banner says return rather than switch. */
  returnToLive: boolean;
}> {
  if (!session || session.environment !== "sandbox") {
    return { environment: "live", prompt: "closed", loaded: false, counts: null, returnToLive: false };
  }
  const row = await query<{ settings: { sandboxPrompt?: string } | null; sample_loaded_at: Date | null }>(
    `SELECT settings, sample_loaded_at FROM organizations WHERE id = $1`,
    [session.orgId],
  );
  const returning = await query<{ returning: boolean }>(
    `SELECT (
        live_started_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM properties p WHERE p.org_id = organizations.id)
        OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = organizations.id)
      ) AS returning
       FROM organizations
      WHERE id = $1 AND environment = 'live'`,
    [session.liveOrgId],
  );
  const settings = row.rows[0]?.settings;
  const loaded = Boolean(row.rows[0]?.sample_loaded_at) || settings?.sandboxPrompt === "loaded";
  const closed = loaded || settings?.sandboxPrompt === "blank";
  return {
    environment: "sandbox",
    prompt: closed ? "closed" : "open",
    loaded,
    counts: closed ? null : sampleCounts(loadSampleRows()),
    returnToLive: Boolean(returning.rows[0]?.returning),
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
export const SECOND_SAMPLE_ADDRESS = "台中市西區範例路 2 號";

const RETIRED_AVENUE = ["示", "範", "大道"].join("");
const SAMPLE_FICTION = "（虛構）";
const SAMPLE_ADDRESS_REV = "2";

/** Existing sample firms keep the address they were seeded with. Replace a retired avenue line. */
export async function correctRetiredSampleAddresses(client: { query: Client["query"] }, orgId: string) {
  const current = await client.query<{ rev: string }>(
    `SELECT coalesce(settings->>'sampleAddressRev', '') AS rev
       FROM organizations
      WHERE id = $1 AND environment = 'sandbox'`,
    [orgId],
  );
  if (!current.rows[0] || current.rows[0].rev === SAMPLE_ADDRESS_REV) return;
  const first = { country: "TW", city: "台中市", district: "西區", street: "範例路 1 號", line: RETIRED_SAMPLE_ADDRESS };
  const second = { country: "TW", city: "台中市", district: "西區", street: "範例路 2 號", line: SECOND_SAMPLE_ADDRESS };
  await client.query(
    `UPDATE properties
        SET address_display = $2,
            address = coalesce(address, '{}'::jsonb) || $3::jsonb
      WHERE org_id = $1
        AND (address_display LIKE '%' || $4 || '%' OR address_display LIKE '%範例大道%'
          OR coalesce(address->>'line', '') LIKE '%' || $4 || '%'
          OR coalesce(address->>'line', '') LIKE '%範例大道%')`,
    [orgId, RETIRED_SAMPLE_ADDRESS, JSON.stringify(first), RETIRED_AVENUE],
  );
  await client.query(
    `UPDATE properties
        SET address_display = $2,
            address = coalesce(address, '{}'::jsonb) || $3::jsonb
      WHERE org_id = $1
        AND (address_display LIKE '%樣本街%' OR coalesce(address->>'line', '') LIKE '%樣本街%')`,
    [orgId, SECOND_SAMPLE_ADDRESS, JSON.stringify(second)],
  );
  await client.query(
    `UPDATE properties
        SET address_display = replace(address_display, $2, ''),
            address = jsonb_set(
              coalesce(address, '{}'::jsonb),
              '{line}',
              to_jsonb(replace(coalesce(address->>'line', address_display), $2, ''))
            )
      WHERE org_id = $1
        AND (address_display LIKE '%' || $2 || '%' OR coalesce(address->>'line', '') LIKE '%' || $2 || '%')`,
    [orgId, SAMPLE_FICTION],
  );
  await client.query(
    `UPDATE organizations
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{sampleAddressRev}', to_jsonb($2::text), true)
      WHERE id = $1 AND environment = 'sandbox'`,
    [orgId, SAMPLE_ADDRESS_REV],
  );
}

export async function loadSampleData(session: Session) {
  await ensureSampleLoaded(session);
}

/** Switching to the live company stays open unless platform_settings.go_live_lock is true. */
export async function liveModeEnabled(orgId?: string) {
  void orgId;
  return !(await goLiveLocked());
}
