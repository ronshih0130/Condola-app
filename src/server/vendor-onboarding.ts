import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, svc } from "./db";
import { FlowError } from "./errors";
import { assertPerm, can } from "./perms";
import { PHOTO_BUCKET } from "./repair-rules";
import { downloadRepairObject } from "./ticket-photos";
import type { Session } from "./types";
import { hashVendorToken, newVendorToken } from "./vendor-repair-rules";
import { validateVendorOnboardingInput } from "./vendor-onboarding-rules";

export interface OnboardingInvite {
  id: string;
  org_id: string;
  contact_id: string;
  created_by: string;
  created_at: string;
}

/** Recheck live membership before any service-role staff operation. */
export async function authorizeVendorStaff(client: Client, session: Session) {
  assertPerm(session, "tickets.update");
  const member = await maybe<{ role: Session["role"] }>(
    client,
    `SELECT role::text FROM org_members
      WHERE org_id = $1 AND user_id = $2 AND status = 'active'
      FOR SHARE`,
    [session.orgId, session.userId],
  );
  if (!member || !can(member.role, "tickets.update")) {
    throw new FlowError("errors.forbidden");
  }
}

async function lockContact(client: Client, orgId: string, contactId: string) {
  const contact = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM contacts
      WHERE id = $1 AND org_id = $2 AND is_vendor AND archived_at IS NULL
      FOR UPDATE`,
    [contactId, orgId],
  );
  if (!contact) throw new FlowError("errors.notFound");
}

/** Discover without locking, then always lock contact before invite. */
async function liveInvite(client: Client, token: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new FlowError("errors.notFound");
  }
  const tokenHash = hashVendorToken(token);
  const candidate = await maybe<OnboardingInvite>(
    client,
    `SELECT id::text, org_id::text, contact_id::text,
            created_by::text, created_at::text
       FROM vendor_onboarding_invites
      WHERE token_hash = $1 AND scope = 'vendor_onboarding'`,
    [tokenHash],
  );
  if (!candidate) throw new FlowError("errors.notFound");
  await lockContact(client, candidate.org_id, candidate.contact_id);
  const invite = await maybe<OnboardingInvite>(
    client,
    `SELECT id::text, org_id::text, contact_id::text,
            created_by::text, created_at::text
       FROM vendor_onboarding_invites
      WHERE id = $1 AND org_id = $2 AND contact_id = $3
        AND token_hash = $4 AND scope = 'vendor_onboarding'
        AND used_at IS NULL AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
      FOR UPDATE`,
    [candidate.id, candidate.org_id, candidate.contact_id, tokenHash],
  );
  if (!invite) throw new FlowError("errors.notFound");
  return invite;
}

export async function createVendorOnboardingInvite(
  session: Session,
  contactId: string,
) {
  return svc(session.userId, async (client) => {
    await authorizeVendorStaff(client, session);
    await lockContact(client, session.orgId, contactId);
    await client.query(
      `UPDATE vendor_onboarding_invites SET revoked_at = clock_timestamp()
        WHERE org_id = $1 AND contact_id = $2
          AND used_at IS NULL AND revoked_at IS NULL`,
      [session.orgId, contactId],
    );
    const token = newVendorToken();
    const invite = await one<{ id: string; expires_at: string }>(
      client,
      `INSERT INTO vendor_onboarding_invites
         (org_id, contact_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,clock_timestamp() + interval '14 days',$4)
       RETURNING id::text, expires_at::text`,
      [session.orgId, contactId, hashVendorToken(token), session.userId],
    );
    await writeAudit(
      session.orgId,
      session.userId,
      "vendor_onboarding_invite",
      { inviteId: invite.id, contactId },
      client,
    );
    return {
      inviteId: invite.id,
      expiresAt: invite.expires_at,
      url: `/v/onboarding/${token}`,
    };
  });
}

export async function openVendorOnboarding(token: string) {
  return svc(null, async (client) => {
    const invite = await liveInvite(client, token);
    return one<{ inviteId: string; organizationName: string; vendorName: string }>(
      client,
      `SELECT i.id::text AS "inviteId", o.name AS "organizationName",
              c.display_name AS "vendorName"
         FROM vendor_onboarding_invites i
         JOIN organizations o ON o.id = i.org_id
         JOIN contacts c ON c.id = i.contact_id AND c.org_id = i.org_id
        WHERE i.id = $1`,
      [invite.id],
    );
  });
}

export type VendorOnboardingInput = Record<string, unknown> & {
  /** Confirmed file from the existing private signed-upload flow. */
  seal_file_id?: string | null;
};

export async function submitVendorOnboarding(
  token: string,
  input: VendorOnboardingInput,
) {
  return svc(null, async (client) => {
    const invite = await liveInvite(client, token);

    let sealBytes: Uint8Array | undefined;
    let sealFileId: string | null = null;
    if (input.kind === "business") {
      if (typeof input.seal_file_id !== "string") {
        throw new Error("missing_seal_image");
      }
      const file = await maybe<{ storage_path: string }>(
        client,
        `SELECT f.storage_path FROM files f
          WHERE f.id = $1 AND f.org_id = $2 AND f.storage_bucket = $3
            AND f.uploaded_by = $4 AND f.created_at >= $5::timestamptz
            AND f.mime_type IN ('image/png','image/jpeg')
            AND f.size_bytes BETWEEN 1 AND 5242880
            AND NOT EXISTS (
              SELECT 1 FROM vendor_profile_versions v WHERE v.seal_file_id = f.id
            )
          FOR SHARE`,
        [
          input.seal_file_id,
          invite.org_id,
          PHOTO_BUCKET,
          invite.created_by,
          invite.created_at,
        ],
      );
      if (!file) throw new Error("invalid_seal_file");
      sealBytes = await downloadRepairObject(file.storage_path);
      sealFileId = input.seal_file_id;
    }

    const checked = validateVendorOnboardingInput({
      ...input,
      seal_bytes: sealBytes,
    });
    if (!checked.ok) throw new Error(checked.error);
    const value = checked.value;

    const jobTypes = await client.query<{ code: string }>(
      `SELECT code FROM job_types WHERE active AND code = ANY($1::text[])`,
      [value.service_job_types],
    );
    if (
      new Set(jobTypes.rows.map((row) => row.code)).size !==
      new Set(value.service_job_types).size
    ) {
      throw new Error("invalid_service_job_types");
    }

    // Resolve only by org/contact. A phone change updates this profile and its
    // version; the database audits old/new phone values in this transaction.
    // Never use a phone to recover or link another profile's issuer/counter.
    const profile = await one<{ id: string; current_version: number }>(
      client,
      `INSERT INTO vendor_profiles
         (org_id, contact_id, vendor_code, kind, display_name, business_name,
          representative_name, tax_id, phone_e164, address, service_job_types,
          qualification_attested_at, seal_file_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               CASE WHEN $12 THEN clock_timestamp() ELSE NULL END,$13)
       ON CONFLICT (org_id, contact_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         display_name = EXCLUDED.display_name,
         business_name = EXCLUDED.business_name,
         representative_name = EXCLUDED.representative_name,
         tax_id = EXCLUDED.tax_id,
         phone_e164 = EXCLUDED.phone_e164,
         address = EXCLUDED.address,
         service_job_types = EXCLUDED.service_job_types,
         qualification_attested_at = EXCLUDED.qualification_attested_at,
         seal_file_id = EXCLUDED.seal_file_id,
         current_version = vendor_profiles.current_version + 1,
         updated_at = clock_timestamp()
       RETURNING id::text, current_version`,
      [
        invite.org_id,
        invite.contact_id,
        // Businesses bind to their private tax-ID issuer. Individuals retain a
        // random profile code and per-company/profile numbering across phone
        // changes, with no cross-org identity or phone continuity across profiles.
        // Cross-org 統編 linkage for individuals is post-11/9 backlog.
        globalThis.crypto.randomUUID().replaceAll("-", ""),
        value.kind,
        value.display_name,
        value.business_name,
        value.representative_name,
        value.tax_id,
        value.phone_e164,
        value.address,
        value.service_job_types,
        value.qualification_attested,
        sealFileId,
      ],
    );
    await client.query(
      `INSERT INTO vendor_profile_versions
         (org_id, vendor_profile_id, version, kind, display_name, business_name,
          representative_name, tax_id, phone_e164, address, service_job_types,
          qualification_attested_at, seal_file_id, snapshot)
       SELECT org_id, id, current_version, kind, display_name, business_name,
              representative_name, tax_id, phone_e164, address, service_job_types,
              qualification_attested_at, seal_file_id,
              jsonb_build_object(
                'invite_id', $2::text,
                'confirmation_method', 'onboarding_token',
                'confirmed_at', clock_timestamp()
              )
         FROM vendor_profiles WHERE id = $1`,
      [profile.id, invite.id],
    );
    const consumed = await client.query(
      `UPDATE vendor_onboarding_invites
          SET used_at = clock_timestamp(), vendor_profile_id = $2
        WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
          AND expires_at > clock_timestamp()`,
      [invite.id, profile.id],
    );
    if (consumed.rowCount !== 1) throw new FlowError("errors.notFound");
    await writeAudit(
      invite.org_id,
      null,
      "vendor_onboarding_submit",
      {
        inviteId: invite.id,
        profileId: profile.id,
        version: profile.current_version,
        actorKind: "onboarding_token",
      },
      client,
    );
    return { profileId: profile.id, version: profile.current_version };
  });
}

export async function revokeVendorOnboarding(
  session: Session,
  inviteId: string,
) {
  return svc(session.userId, async (client) => {
    await authorizeVendorStaff(client, session);
    const candidate = await maybe<{ contact_id: string }>(
      client,
      `SELECT contact_id::text FROM vendor_onboarding_invites
        WHERE id = $1 AND org_id = $2`,
      [inviteId, session.orgId],
    );
    if (!candidate) throw new FlowError("errors.notFound");
    await lockContact(client, session.orgId, candidate.contact_id);
    const invite = await maybe<{ id: string }>(
      client,
      `UPDATE vendor_onboarding_invites
          SET revoked_at = COALESCE(revoked_at, clock_timestamp())
        WHERE id = $1 AND org_id = $2 AND contact_id = $3
        RETURNING id::text`,
      [inviteId, session.orgId, candidate.contact_id],
    );
    if (!invite) throw new FlowError("errors.notFound");
    await writeAudit(
      session.orgId,
      session.userId,
      "vendor_onboarding_revoke",
      { inviteId },
      client,
    );
  });
}
