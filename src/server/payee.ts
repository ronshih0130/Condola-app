import { tx } from "./db";
import { FlowError } from "./errors";
import { can } from "./perms";
import type { Session } from "./types";
import {
  PAYEE_DETAILS_ENABLED, payeeDetailsOn, resolvePayee, validatePayee,
  validUuid, type PayeeInput,
} from "./payee-rules";

export type PayeeAccount = {
  id: string;
  holder_name: string | null;
  bank_name: string | null;
  bank_code: string | null;
  branch_code: string | null;
  account_number: string | null;
  account_last5: string | null;
  owner_contact_id: string | null;
  is_default_payee: boolean;
  details: { swift?: string; routing?: string };
};

function assertAdmin(session: Session) {
  if (!can(session.role, "settings.edit")) throw new FlowError("forbidden");
}

const columns = `id, holder_name, bank_name, bank_code, branch_code,
  account_number, account_last5, owner_contact_id, is_default_payee, details`;

export async function tenantPayee(session: Session, leaseId: string) {
  return tx(session.userId, async (client) => {
    const org = (await client.query(
      "SELECT feature_flags FROM organizations WHERE id = $1", [session.orgId],
    )).rows[0];
    const enabled = payeeDetailsOn(PAYEE_DETAILS_ENABLED, org?.feature_flags);
    if (!enabled) {
      // Legacy columns only: works before the additive migration is deployed.
      const row = (await client.query(
        `SELECT account_last5 FROM bank_accounts
         WHERE org_id = $1 AND archived_at IS NULL AND show_to_tenants
         ORDER BY created_at LIMIT 1`, [session.orgId],
      )).rows[0];
      return { enabled: false as const, last5: row?.account_last5 as string | null, account: null };
    }
    const lease = (await client.query(
      "SELECT payee_bank_account_id FROM leases WHERE org_id = $1 AND id = $2",
      [session.orgId, leaseId],
    )).rows[0];
    if (!lease) return { enabled: true as const, last5: null, account: null };
    const accounts = (await client.query<PayeeAccount>(
      `SELECT ${columns} FROM bank_accounts
       WHERE org_id = $1 AND archived_at IS NULL AND show_to_tenants
         AND (id = $2 OR (is_default_payee AND owner_contact_id IS NULL))`,
      [session.orgId, lease.payee_bank_account_id],
    )).rows;
    return {
      enabled: true as const, last5: null,
      account: resolvePayee(
        accounts.find((a) => a.id === lease.payee_bank_account_id) ?? null,
        accounts.find((a) => a.is_default_payee && !a.owner_contact_id) ?? null,
      ),
    };
  });
}

export async function payeeSettings(session: Session) {
  if (!can(session.role, "settings.edit")) return null;
  return tx(session.userId, async (client) => {
    const org = (await client.query(
      "SELECT country_code, default_currency, feature_flags FROM organizations WHERE id = $1",
      [session.orgId],
    )).rows[0];
    if (!org || !payeeDetailsOn(PAYEE_DETAILS_ENABLED, org.feature_flags)) return null;
    const accounts = (await client.query<PayeeAccount>(
      `SELECT ${columns} FROM bank_accounts
       WHERE org_id = $1 AND archived_at IS NULL ORDER BY created_at, id`, [session.orgId],
    )).rows;
    const owners = (await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM contacts
       WHERE org_id = $1 AND is_owner AND archived_at IS NULL ORDER BY display_name`,
      [session.orgId],
    )).rows;
    const leases = (await client.query<{ id: string; payee_bank_account_id: string | null }>(
      "SELECT id, payee_bank_account_id FROM leases WHERE org_id = $1 ORDER BY created_at, id",
      [session.orgId],
    )).rows;
    return { country: org.country_code as string, accounts, owners, leases };
  });
}

export async function savePayee(session: Session, input: PayeeInput): Promise<string> {
  assertAdmin(session);
  return tx(session.userId, async (client) => {
    const org = (await client.query(
      `SELECT country_code, default_currency, feature_flags FROM organizations
       WHERE id = $1 FOR UPDATE`, [session.orgId],
    )).rows[0];
    if (!org || !payeeDetailsOn(PAYEE_DETAILS_ENABLED, org.feature_flags)) {
      throw new FlowError("forbidden");
    }
    let data: PayeeInput;
    try { data = validatePayee(org.country_code, input); }
    catch { throw new FlowError("invalid_payee"); }
    if (data.ownerContactId) {
      const owner = await client.query(
        `SELECT id FROM contacts WHERE org_id = $1 AND id = $2
         AND is_owner AND archived_at IS NULL`, [session.orgId, data.ownerContactId],
      );
      if (!owner.rows.length) throw new FlowError("invalid_payee");
    }
    if (data.id) {
      const existing = await client.query(
        "SELECT id FROM bank_accounts WHERE org_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE",
        [session.orgId, data.id],
      );
      if (!existing.rows.length) throw new FlowError("invalid_payee");
    }
    if (data.isDefault) {
      await client.query(
        `UPDATE bank_accounts SET is_default_payee = false, updated_at = now()
         WHERE org_id = $1 AND is_default_payee AND archived_at IS NULL`,
        [session.orgId],
      );
    }
    const values = [
      session.orgId, data.holderName, data.bankName || null, data.bankCode || null,
      data.branchCode || null, data.accountNumber, org.country_code,
      JSON.stringify(data.details), data.ownerContactId, data.isDefault,
    ];
    const result = data.id
      ? await client.query<{ id: string }>(
        `UPDATE bank_accounts SET holder_name=$2, bank_name=$3, bank_code=$4,
         branch_code=$5, account_number=$6, country_code=$7, details=$8::jsonb,
         owner_contact_id=$9, is_default_payee=$10, show_to_tenants=true, updated_at=now()
         WHERE org_id=$1 AND id=$11 RETURNING id`, [...values, data.id],
      )
      : await client.query<{ id: string }>(
        `INSERT INTO bank_accounts
         (org_id, holder_name, bank_name, bank_code, branch_code, account_number,
          country_code, details, owner_contact_id, is_default_payee,
          nickname, currency, show_to_tenants, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$2,$11,true,now())
         RETURNING id`, [...values, org.default_currency],
      );
    // Usage metering hook: retain the account ID; no metering table yet.
    return result.rows[0].id;
  });
}

export async function setLeasePayee(session: Session, leaseId: string, accountId: string | null) {
  assertAdmin(session);
  if (!validUuid(leaseId) || (accountId !== null && !validUuid(accountId))) {
    throw new FlowError("invalid_payee");
  }
  return tx(session.userId, async (client) => {
    const org = (await client.query(
      "SELECT feature_flags FROM organizations WHERE id = $1 FOR UPDATE", [session.orgId],
    )).rows[0];
    if (!payeeDetailsOn(PAYEE_DETAILS_ENABLED, org?.feature_flags)) throw new FlowError("forbidden");
    if (accountId) {
      const account = await client.query(
        `SELECT id FROM bank_accounts WHERE org_id=$1 AND id=$2
         AND archived_at IS NULL AND show_to_tenants FOR SHARE`, [session.orgId, accountId],
      );
      if (!account.rows.length) throw new FlowError("invalid_payee");
    }
    const result = await client.query<{ id: string }>(
      `UPDATE leases SET payee_bank_account_id=$3, updated_at=now()
       WHERE org_id=$1 AND id=$2 RETURNING id`, [session.orgId, leaseId, accountId],
    );
    if (!result.rows.length) throw new FlowError("invalid_payee");
    // Usage metering hook: the lease and account IDs identify this assignment.
    return { leaseId: result.rows[0].id, accountId };
  });
}
