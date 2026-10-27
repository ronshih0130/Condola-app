import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { svc } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import type { Session } from "./types";
import {
  createVendorOnboardingInvite,
  submitVendorOnboarding,
} from "./vendor-onboarding";

function staff(userId: string, orgId: string): Session {
  return {
    userId,
    sessionId: "vendor-individual-issuer-test",
    email: "vendor-individual-issuer@example.invalid",
    name: "Test",
    kind: "staff",
    role: "admin",
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

test(
  "individual issuer stays profile-bound across phone changes, reuse and organizations",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const contacts = Array.from({ length: 4 }, () => randomUUID());
    const admin = staff(USERS.admin, ORG_ID);
    const otherAdmin = staff(USERS.coastAdmin, ORG2_ID);
    const phoneBase = Math.floor(Math.random() * 9999990);
    const phones = Array.from(
      { length: 4 },
      (_, index) => `+8869${String(phoneBase + index).padStart(8, "0")}`,
    );
    const [originalPhone, changedPhone, otherPhone, temporaryPhone] = phones;

    t.after(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `ALTER TABLE vendor_profile_versions
             DISABLE TRIGGER vendor_profile_versions_immutable`,
        );
        await client.query(
          `DELETE FROM vendor_onboarding_invites WHERE contact_id = ANY($1::uuid[])`,
          [contacts],
        );
        await client.query(
          `DELETE FROM vendor_profile_versions
            WHERE vendor_profile_id IN (
              SELECT id FROM vendor_profiles WHERE contact_id = ANY($1::uuid[])
            )`,
          [contacts],
        );
        await client.query(
          `DELETE FROM vendor_profiles WHERE contact_id = ANY($1::uuid[])`,
          [contacts],
        );
        await client.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contacts]);
        await client.query(
          `ALTER TABLE vendor_profile_versions
             ENABLE TRIGGER vendor_profile_versions_immutable`,
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    });

    await svc(null, async (client) => {
      for (let index = 0; index < contacts.length; index++) {
        await client.query(
          `INSERT INTO contacts (id,org_id,is_vendor,display_name,phone_e164)
           VALUES ($1,$2,true,'Individual issuer test',$3)`,
          [contacts[index], index === 2 ? ORG2_ID : ORG_ID, originalPhone],
        );
      }
    });

    async function onboard(session: Session, contactId: string, phone: string) {
      const invite = await createVendorOnboardingInvite(session, contactId);
      return submitVendorOnboarding(invite.url.slice(invite.url.lastIndexOf("/") + 1), {
        kind: "individual",
        display_name: "Individual issuer test",
        phone,
        service_job_types: [],
      });
    }

    async function allocate(profileId: string) {
      return svc(null, async (client) => {
        const result = await client.query<{ seq: string }>(
          `SELECT app.next_vendor_document_seq($1,'completion_statement')::text AS seq`,
          [profileId],
        );
        return Number(result.rows[0].seq);
      });
    }

    async function profile(profileId: string) {
      const result = await pool.query(
        `SELECT id::text,org_id::text,issuer_id::text,vendor_code,phone_e164,
                current_version
           FROM vendor_profiles WHERE id = $1`,
        [profileId],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0];
    }

    async function phoneAudits(profileId: string) {
      const result = await pool.query(
        `SELECT org_id::text,action::text,old_row->>'phone_e164' AS old_phone,
                new_row->>'phone_e164' AS new_phone,changed_cols
           FROM audit_log
          WHERE table_name = 'vendor_profiles' AND row_id = $1
            AND action = 'update' AND 'phone_e164' = ANY(changed_cols)
          ORDER BY id`,
        [profileId],
      );
      return result.rows;
    }

    const first = await onboard(admin, contacts[0], originalPhone);
    const second = await onboard(admin, contacts[1], otherPhone);
    const crossOrg = await onboard(otherAdmin, contacts[2], originalPhone);
    const firstIdentity = await profile(first.profileId);
    const secondIdentity = await profile(second.profileId);
    const crossOrgIdentity = await profile(crossOrg.profileId);

    assert.notEqual(first.profileId, crossOrg.profileId);
    assert.equal(firstIdentity.issuer_id, null);
    assert.equal(crossOrgIdentity.issuer_id, null);
    assert.notEqual(firstIdentity.vendor_code, crossOrgIdentity.vendor_code);
    assert.equal(await allocate(first.profileId), 1);
    assert.equal(await allocate(crossOrg.profileId), 1);

    const updated = await onboard(admin, contacts[0], changedPhone);
    assert.deepEqual(updated, { profileId: first.profileId, version: 2 });
    const afterChange = await profile(first.profileId);
    assert.equal(afterChange.vendor_code, firstIdentity.vendor_code);
    assert.equal(afterChange.issuer_id, null);
    assert.equal(afterChange.phone_e164, changedPhone);
    assert.equal(await allocate(first.profileId), 2);
    assert.equal(await allocate(crossOrg.profileId), 2);
    const audits = await phoneAudits(first.profileId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].org_id, ORG_ID);
    assert.equal(audits[0].action, "update");
    assert.equal(audits[0].old_phone, originalPhone);
    assert.equal(audits[0].new_phone, changedPhone);
    assert.ok(audits[0].changed_cols.includes("phone_e164"));
    const versions = await pool.query(
      `SELECT version,phone_e164 FROM vendor_profile_versions
        WHERE vendor_profile_id = $1 ORDER BY version`,
      [first.profileId],
    );
    assert.deepEqual(versions.rows, [
      { version: 1, phone_e164: originalPhone },
      { version: 2, phone_e164: changedPhone },
    ]);

    // The current-phone guard rejects a conflicting update atomically.
    await assert.rejects(onboard(admin, contacts[1], changedPhone));
    assert.equal((await profile(second.profileId)).phone_e164, otherPhone);
    assert.equal((await profile(second.profileId)).current_version, 1);
    assert.deepEqual(await phoneAudits(second.profileId), []);

    // A released number creates a fresh profile, never a recovered issuer.
    const reused = await onboard(admin, contacts[3], originalPhone);
    assert.notEqual(reused.profileId, first.profileId);
    const reusedIdentity = await profile(reused.profileId);
    assert.equal(reusedIdentity.issuer_id, null);
    assert.notEqual(reusedIdentity.vendor_code, firstIdentity.vendor_code);
    assert.notEqual(reusedIdentity.vendor_code, crossOrgIdentity.vendor_code);
    assert.equal(await allocate(reused.profileId), 1);
    await assert.rejects(onboard(admin, contacts[1], originalPhone));
    assert.equal((await profile(second.profileId)).current_version, 1);

    // Occupied phones can be swapped through an unused value. Identity,
    // versions and counters remain attached to each org/contact's profile.
    assert.equal((await onboard(admin, contacts[0], temporaryPhone)).profileId, first.profileId);
    assert.equal((await onboard(admin, contacts[1], changedPhone)).profileId, second.profileId);
    assert.equal((await onboard(admin, contacts[0], otherPhone)).profileId, first.profileId);
    assert.equal((await profile(first.profileId)).vendor_code, firstIdentity.vendor_code);
    assert.equal((await profile(second.profileId)).vendor_code, secondIdentity.vendor_code);
    assert.equal(await allocate(first.profileId), 3);
    assert.equal(await allocate(second.profileId), 1);
    assert.deepEqual(
      (await phoneAudits(first.profileId)).map((row) => [row.old_phone, row.new_phone]),
      [
        [originalPhone, changedPhone],
        [changedPhone, temporaryPhone],
        [temporaryPhone, otherPhone],
      ],
    );
    assert.deepEqual(
      (await phoneAudits(second.profileId)).map((row) => [row.old_phone, row.new_phone]),
      [[otherPhone, changedPhone]],
    );

    // Replay preserves the guard's catalog identity and all profile counters.
    const indexBefore = await pool.query(
      `SELECT c.oid::text,c.xmin::text,pg_get_indexdef(c.oid) AS definition
         FROM pg_class c
        WHERE c.oid = 'public.vendor_profiles_individual_identity'::regclass`,
    );
    await pool.query(readFileSync(
      new URL(
        "../../supabase/migrations/20261030150800_vendor_onboarding_job_types_receipts.sql",
        import.meta.url,
      ),
      "utf8",
    ));
    const indexAfter = await pool.query(
      `SELECT c.oid::text,c.xmin::text,pg_get_indexdef(c.oid) AS definition
         FROM pg_class c
        WHERE c.oid = 'public.vendor_profiles_individual_identity'::regclass`,
    );
    assert.deepEqual(indexAfter.rows, indexBefore.rows);
    assert.equal(await allocate(first.profileId), 4);
    assert.equal(await allocate(second.profileId), 2);
    assert.equal(await allocate(crossOrg.profileId), 3);
    assert.equal(await allocate(reused.profileId), 2);

    // The audit trigger also covers SQL writers after migration replay.
    await svc(null, (client) => client.query(
      `UPDATE vendor_profiles SET phone_e164 = $2 WHERE id = $1`,
      [first.profileId, temporaryPhone],
    ));
    const directAudits = await phoneAudits(first.profileId);
    assert.equal(directAudits.length, 4);
    assert.equal(directAudits[3].old_phone, otherPhone);
    assert.equal(directAudits[3].new_phone, temporaryPhone);
    assert.equal(await allocate(first.profileId), 5);
    await svc(null, (client) => client.query(
      `UPDATE vendor_profiles SET phone_e164 = phone_e164 WHERE id = $1`,
      [first.profileId],
    ));
    assert.equal((await phoneAudits(first.profileId)).length, 4);
  },
);
