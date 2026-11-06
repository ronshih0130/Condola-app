import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { uploadSignedLeasePdf } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import type { Session } from "./types";
import { insertTestAuthSession } from "./test-auth-session";

// B-004 / PROP-US-v03-01: the paper-lease path reads the same two ID switches as e-sign
// (B-001 CAP-P-28). Flag id_sign_gate_v2 OFF keeps the existing hard gate.
const bytes = Buffer.from("%PDF-1.4\nb004 paper fixture\n%%EOF\n");
const idRequired = (e: unknown) => e instanceof FlowError && e.key === "errors.idDocRequired";

async function staff(): Promise<Session> {
  const sessionId = await withClient((client) => insertTestAuthSession(client, USERS.admin));
  return { userId: USERS.admin, sessionId, email: "", name: "admin", kind: "staff", role: "admin", orgId: ORG_ID, liveOrgId: ORG_ID,
    environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
}
/** A non-imported lease whose primary tenant has no ID documents. */
async function leaseWithoutId(status: "ended" | "draft" = "ended") {
  const property = (await query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`, [ORG_ID, `B004 ${randomUUID()}`])).rows[0].id;
  const unit = (await query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'1F') RETURNING id::text`, [ORG_ID, property])).rows[0].id;
  const lease = (await query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$3,$4::lease_status,'not_sent','2097-01-01','2097-12-31','TWD',0) RETURNING id::text`, [ORG_ID, property, unit, status])).rows[0].id;
  const tenant = (await query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,'B004 tenant') RETURNING id::text`, [ORG_ID])).rows[0].id;
  await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [ORG_ID, lease, tenant]);
  return lease;
}
async function setGate(on: boolean, settings: Record<string, unknown>) {
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='id_sign_gate_v2'`, [on, ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('id_sign_gate_v2',$1::boolean),
    settings=(settings - 'collect_id' - 'require_id_before_sign') || $3::jsonb WHERE id=$2`, [on, ORG_ID, JSON.stringify(settings)]);
}

const state = async (lease: string) => (await query<{ pdfs: number; status: string; esign: string }>(
  `SELECT (SELECT count(*)::int FROM lease_signed_pdfs WHERE lease_id=$1) pdfs, l.status::text status, l.esign_status::text esign FROM leases l WHERE l.id=$1`, [lease])).rows[0];

test("paper upload and establishment follow the two ID switches; flag OFF keeps the hard gate", async () => {
  const session = await staff();
  const savedOrg = (await query<{ flags: unknown; settings: unknown }>(`SELECT feature_flags flags, settings FROM organizations WHERE id=$1`, [ORG_ID])).rows[0];
  const savedGate = (await query<{ value: string; description: string | null }>(`SELECT value::text AS value, description FROM platform_settings WHERE key='id_sign_gate_v2'`)).rows[0];
  const savedPaper = process.env.PAPER_LEASE_VERSIONS_ENABLED;
  process.env.PAPER_LEASE_VERSIONS_ENABLED = "true";
  try {
    await query(`UPDATE organizations SET feature_flags=coalesce(feature_flags,'{}'::jsonb) || '{"paper_lease_versions":true}'::jsonb WHERE id=$1`, [ORG_ID]);
    const denied = async (on: boolean, settings: Record<string, unknown>) => {
      await setGate(on, settings);
      for (const status of ["ended", "draft"] as const) {
        const lease = await leaseWithoutId(status), before = await state(lease);
        await assert.rejects(uploadSignedLeasePdf(session, lease, { bytes, fileName: "denied.pdf" }), idRequired);
        assert.deepEqual(await state(lease), before, `no write when denied (${status})`);
      }
    };
    const allowed = async (settings: Record<string, unknown>) => {
      await setGate(true, settings);
      const ended = await leaseWithoutId("ended");
      await uploadSignedLeasePdf(session, ended, { bytes, fileName: "ended.pdf" });
      assert.deepEqual(await state(ended), { pdfs: 1, status: "ended", esign: "fully_signed" });
      const draft = await leaseWithoutId("draft");
      await uploadSignedLeasePdf(session, draft, { bytes, fileName: "draft.pdf" });
      // Establishment: the paper lease becomes active while ID collection runs in parallel.
      assert.deepEqual(await state(draft), { pdfs: 1, status: "active", esign: "fully_signed" });
    };
    await denied(false, { collect_id: true, require_id_before_sign: false });              // rollout OFF: legacy hard gate
    await allowed({});                                                                      // defaults: true × false
    await allowed({ collect_id: true, require_id_before_sign: false });
    await denied(true, { collect_id: true, require_id_before_sign: true });                // both ON blocks
    await allowed({ collect_id: false, require_id_before_sign: false });                    // master OFF
    await allowed({ collect_id: false, require_id_before_sign: true });                     // invalid: never blocks
  } finally {
    try {
      if (savedGate === undefined) await query(`DELETE FROM platform_settings WHERE key='id_sign_gate_v2'`);
      else await query(`UPDATE platform_settings SET value=$1::jsonb, description=$2 WHERE key='id_sign_gate_v2'`, [savedGate.value, savedGate.description]);
      await query(`UPDATE organizations SET feature_flags=$2::jsonb, settings=$3::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify(savedOrg.flags), JSON.stringify(savedOrg.settings)]);
    } finally {
      if (savedPaper === undefined) delete process.env.PAPER_LEASE_VERSIONS_ENABLED; else process.env.PAPER_LEASE_VERSIONS_ENABLED = savedPaper;
    }
  }
});
