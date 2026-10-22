import type { Client } from "pg";
import { writeAudit } from "./audit";
import {
  BILLABLE_ACTIVE_LEASE,
  normalizePartnerCode,
  type PaidTier,
  type PriceOverride,
  type PriceSnapshot,
} from "./billing";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import { assertStaff, type Session } from "./types";

export type PartnerPreview =
  | { state: "empty" }
  | {
      state: "valid";
      code: string;
      partnerName: string;
      standardPrice: number;
      proPrice: number;
      freeUnits: number;
      trialMonths: number;
      lockMonths: number;
    }
  | { state: "invalid"; reason: "format" | "unknown" | "inactive" | "expired" | "used" };

type CodeRow = {
  code: string;
  partner_name: string;
  standard_price: number;
  pro_price: number;
  free_units: number;
  trial_months: number;
  price_lock_months: number;
  max_uses: number;
  uses: number;
  expires_at: Date | null;
  active: boolean;
};

function previewFrom(row: CodeRow | undefined, now: Date): PartnerPreview {
  if (!row) return { state: "invalid", reason: "unknown" };
  if (!row.active) return { state: "invalid", reason: "inactive" };
  if (row.expires_at && row.expires_at.getTime() <= now.getTime()) return { state: "invalid", reason: "expired" };
  if (row.uses >= row.max_uses) return { state: "invalid", reason: "used" };
  return {
    state: "valid",
    code: row.code,
    partnerName: row.partner_name,
    standardPrice: row.standard_price,
    proPrice: row.pro_price,
    freeUnits: row.free_units,
    trialMonths: row.trial_months,
    lockMonths: row.price_lock_months,
  };
}

const PARTNER_CODE_SQL = `SELECT code, partner_name, standard_price, pro_price, free_units, trial_months, price_lock_months,
            max_uses, uses, expires_at, active
       FROM partner_codes WHERE code = $1`;

/** Same lookup as previewPartnerCode, on a connection the caller already holds. */
export async function previewPartnerCodeOn(client: Client, raw: string, now = new Date()): Promise<PartnerPreview> {
  const code = normalizePartnerCode(raw);
  if (code == null) return { state: "invalid", reason: "format" };
  if (!code) return { state: "empty" };
  const row = await client.query<CodeRow>(PARTNER_CODE_SQL, [code]);
  return previewFrom(row.rows[0], now);
}

export async function previewPartnerCode(raw: string, now = new Date()): Promise<PartnerPreview> {
  const code = normalizePartnerCode(raw);
  if (code == null) return { state: "invalid", reason: "format" };
  if (!code) return { state: "empty" };
  const row = await query<CodeRow>(PARTNER_CODE_SQL, [code]);
  return previewFrom(row.rows[0], now);
}

export type RedeemedCode = {
  code: string;
  partnerName: string;
  standardPrice: number;
  proPrice: number;
  freeUnits: number;
  trialMonths: number;
  lockMonths: number;
  already: boolean;
};

/** Atomic: the row is locked, uses < max_uses, active, and not expired. An existing snapshot is kept. */
export async function redeemPartnerCode(
  client: Client,
  input: { orgId: string; code: string; where: "signup" | "upgrade" },
): Promise<RedeemedCode | null> {
  const existing = await client.query<{
    code: string;
    partner_name: string;
    standard_price: number;
    pro_price: number;
    free_units: number;
    trial_months: number;
    price_lock_months: number;
  }>(
    `SELECT code, partner_name, standard_price, pro_price, free_units, trial_months, price_lock_months
       FROM firm_partner_prices WHERE org_id = $1 FOR UPDATE`,
    [input.orgId],
  );
  const held = existing.rows[0];
  if (held) {
    return {
      code: held.code,
      partnerName: held.partner_name,
      standardPrice: held.standard_price,
      proPrice: held.pro_price,
      freeUnits: held.free_units,
      trialMonths: held.trial_months,
      lockMonths: held.price_lock_months,
      already: true,
    };
  }
  const updated = await client.query<CodeRow>(
    `UPDATE partner_codes
        SET uses = uses + 1, updated_at = now()
      WHERE code = $1 AND active AND uses < max_uses
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING code, partner_name, standard_price, pro_price, free_units, trial_months, price_lock_months,
                max_uses, uses, expires_at, active`,
    [input.code],
  );
  const row = updated.rows[0];
  if (!row) return null;
  await client.query(
    `INSERT INTO firm_partner_prices (
       org_id, code, partner_name, standard_price, pro_price, free_units, trial_months,
       price_lock_months, locked_until, redeemed_where
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       CASE WHEN $8::int = 0 THEN now() ELSE now() + make_interval(months => $8::int) END,
       $9
     )`,
    [
      input.orgId,
      row.code,
      row.partner_name,
      row.standard_price,
      row.pro_price,
      row.free_units,
      row.trial_months,
      row.price_lock_months,
      input.where,
    ],
  );
  return {
    code: row.code,
    partnerName: row.partner_name,
    standardPrice: row.standard_price,
    proPrice: row.pro_price,
    freeUnits: row.free_units,
    trialMonths: row.trial_months,
    lockMonths: row.price_lock_months,
    already: false,
  };
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export async function loadPriceInputs(orgId: string): Promise<{ override: PriceOverride | null; snapshot: PriceSnapshot | null; code: string | null; partnerName: string | null; lockMonths: number }> {
  const override = await query<{ rate: number; locked_until: Date | null }>(
    `SELECT rate, locked_until FROM firm_price_overrides WHERE org_id = $1`,
    [orgId],
  );
  const snapshot = await query<{
    code: string;
    partner_name: string;
    standard_price: number;
    pro_price: number;
    free_units: number;
    price_lock_months: number;
    locked_until: Date | null;
  }>(
    `SELECT code, partner_name, standard_price, pro_price, free_units, price_lock_months, locked_until
       FROM firm_partner_prices WHERE org_id = $1`,
    [orgId],
  );
  const over = override.rows[0];
  const snap = snapshot.rows[0];
  return {
    override: over ? { rate: over.rate, lockedUntil: iso(over.locked_until) } : null,
    snapshot: snap
      ? {
          standardPrice: snap.standard_price,
          proPrice: snap.pro_price,
          freeUnits: snap.free_units,
          lockedUntil: iso(snap.locked_until),
        }
      : null,
    code: snap?.code ?? null,
    partnerName: snap?.partner_name ?? null,
    lockMonths: snap?.price_lock_months ?? 0,
  };
}

export async function listPartnerCodes() {
  const rows = await query<CodeRow & { created_at: Date }>(
    `SELECT code, partner_name, standard_price, pro_price, free_units, trial_months, price_lock_months,
            max_uses, uses, expires_at, active, created_at
       FROM partner_codes ORDER BY created_at DESC`,
  );
  return rows.rows;
}

export async function listFlaggedFirms() {
  const rows = await query<{ id: string; name: string; contact_email: string | null; created_at: Date }>(
    `SELECT id::text, name, contact_email, created_at
       FROM organizations
      WHERE dup_name_flag AND environment = 'live'
      ORDER BY created_at DESC
      LIMIT 50`,
  );
  return rows.rows;
}

export async function createPartnerCode(
  actorId: string,
  input: {
    code: string;
    partnerName: string;
    standardPrice: number;
    proPrice: number;
    freeUnits: number;
    trialMonths: number;
    lockMonths: number;
    maxUses: number;
    expiresAt: string | null;
  },
) {
  const code = normalizePartnerCode(input.code);
  if (!code) throw new FlowError("errors.required");
  if (!input.partnerName.trim()) throw new FlowError("errors.required");
  const prices = [input.standardPrice, input.proPrice, input.freeUnits, input.trialMonths, input.lockMonths];
  if (prices.some((value) => !Number.isInteger(value) || value < 0) || !Number.isInteger(input.maxUses) || input.maxUses < 1) {
    throw new FlowError("errors.required");
  }
  await query(
    `INSERT INTO partner_codes (
       code, partner_name, standard_price, pro_price, free_units, trial_months, price_lock_months,
       max_uses, expires_at, active, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       CASE WHEN $9::text IS NULL OR $9::text = '' THEN NULL
            ELSE ($9::date + time '23:59:59') AT TIME ZONE 'Asia/Taipei' END,
       true, $10
     )`,
    [
      code,
      input.partnerName.trim(),
      input.standardPrice,
      input.proPrice,
      input.freeUnits,
      input.trialMonths,
      input.lockMonths,
      input.maxUses,
      input.expiresAt,
      actorId,
    ],
  );
  await writeAudit(null, actorId, "code_created", { code, partnerName: input.partnerName.trim() });
  return code;
}

export async function setFirmOverride(actorId: string, orgId: string, rate: number) {
  if (!Number.isInteger(rate) || rate < 0) throw new FlowError("errors.required");
  const firm = await query(`SELECT 1 FROM organizations WHERE id = $1 AND environment = 'live'`, [orgId]);
  if (!firm.rows[0]) throw new FlowError("errors.notFound");
  await query(
    `INSERT INTO firm_price_overrides (org_id, rate, set_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET rate = EXCLUDED.rate, set_by = EXCLUDED.set_by, updated_at = now()`,
    [orgId, rate, actorId],
  );
  await writeAudit(orgId, actorId, "override_set", { rate });
}

export async function clearFirmOverride(actorId: string, orgId: string) {
  const removed = await query(`DELETE FROM firm_price_overrides WHERE org_id = $1`, [orgId]);
  if (removed.rowCount !== 1) throw new FlowError("errors.notFound");
  await writeAudit(orgId, actorId, "override_removed", {});
}

export async function requestUpgrade(session: Session, tier: PaidTier, rawCode: string) {
  assertStaff(session, ["admin"]);
  const orgId = session.liveOrgId;
  const normalized = rawCode.trim() ? normalizePartnerCode(rawCode) : "";
  const code = normalized || "";
  const formatBad = Boolean(rawCode.trim()) && normalized == null;
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      let redeemed: RedeemedCode | null = null;
      if (code) redeemed = await redeemPartnerCode(client, { orgId, code, where: "upgrade" });
      const held = await client.query<{ trial_months: number; code: string }>(
        `SELECT trial_months, code FROM firm_partner_prices WHERE org_id = $1`,
        [orgId],
      );
      const trialMonths = held.rows[0]?.trial_months ?? 3;
      const units = await client.query<{ n: number }>(
        `SELECT count(DISTINCT coalesce(target_room_id::text, target_unit_id::text))::int AS n
           FROM leases
          WHERE org_id = $1 AND ${BILLABLE_ACTIVE_LEASE}
            AND coalesce(target_room_id, target_unit_id) IS NOT NULL`,
        [orgId],
      );
      await client.query(
        `UPDATE organizations
            SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
                  'plan', jsonb_build_object(
                    'tier', $2::text,
                    'trialUntil', to_jsonb(now() + make_interval(months => $3::int))
                  )
                )
          WHERE id = $1`,
        [orgId, tier, trialMonths],
      );
      await client.query(
        `INSERT INTO upgrade_requests (org_id, user_id, tier, units, partner_code, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, session.userId, tier, units.rows[0]?.n ?? 0, held.rows[0]?.code ?? redeemed?.code ?? null, "offline"],
      );
      await client.query("COMMIT");
      await writeAudit(orgId, session.userId, "upgrade_requested", {
        tier,
        code: redeemed && !redeemed.already ? redeemed.code : null,
        codeApplied: Boolean(redeemed && !redeemed.already),
      });
      if (redeemed && !redeemed.already) {
        await writeAudit(orgId, session.userId, "code_redeemed", { code: redeemed.code, where: "upgrade" });
      }
      return {
        codeApplied: Boolean(redeemed && !redeemed.already),
        codeIgnored: formatBad || (Boolean(code) && !redeemed),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
