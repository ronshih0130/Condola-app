import assert from "node:assert/strict";
import test from "node:test";
import { acceptInvite, signIn } from "./auth";
import { query } from "./db";
import { createProperty } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { issuePortalInvite } from "./portal-invite";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

const meta = { ua: "test", ip: "203.0.113.50" };
const STAFF_EMAIL = "yating.lin@songxin.demo";

function admin(): Session {
  return {
    userId: USERS.admin,
    sessionId: "property-owner",
    email: STAFF_EMAIL,
    name: "Admin",
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

async function accountCount(email: string) {
  const row = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth.users WHERE lower(email) = lower($1)`,
    [email],
  );
  return row.rows[0].n;
}

async function removeProperty(propertyId: string, contactId: string) {
  if (!propertyId && !contactId) return;
  await query(`DELETE FROM management_agreements WHERE owner_contact_id = $1 OR property_id = $2`, [
    contactId || "00000000-0000-0000-0000-000000000000",
    propertyId || "00000000-0000-0000-0000-000000000000",
  ]);
  if (propertyId) await query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
  if (contactId) {
    await query(`DELETE FROM invitations WHERE contact_id = $1`, [contactId]);
    await query(`UPDATE contacts SET user_id = NULL WHERE id = $1`, [contactId]);
    await query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
  }
}

async function removeLogin(email: string) {
  if (email.toLowerCase() === STAFF_EMAIL) return;
  const row = await query<{ id: string }>(`SELECT id::text FROM auth.users WHERE lower(email) = lower($1)`, [email]);
  const id = row.rows[0]?.id;
  if (!id || id === USERS.admin) return;
  await query(`DELETE FROM auth_sessions WHERE user_id = $1`, [id]);
  await query(`DELETE FROM profiles WHERE id = $1`, [id]);
  await query(`DELETE FROM auth.users WHERE id = $1`, [id]);
}

test.before(async () => {
  await resetAndSeed();
});

test("a new owner is only a contact, and an invite binds after the right password", async () => {
  const stamp = Date.now().toString(36);
  const freshEmail = `owner.${stamp}@example.com`;
  const takenEmail = `taken.${stamp}@example.com`;
  const staffBefore = await accountCount(STAFF_EMAIL);
  let staffProperty = "";
  let staffContact = "";
  let freshProperty = "";
  let freshContact = "";
  let takenContact = "";
  try {
    await assert.rejects(
      () =>
        createProperty(admin(), {
          name: `壞電話 ${stamp}`,
          city: "台中市",
          district: "西區",
          street: "府後街38",
          currency: "TWD",
          ownerMode: "new",
          ownerName: "施振榮",
          ownerPhone: "123",
          ownerEmail: freshEmail,
          canViewTenantPhone: false,
          unitLabel: "3F",
          floor: "",
          rentalMode: "by_room",
          rooms: [{ label: "A", roomType: "雅房", baseRentMajor: 1000 }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof FlowError);
        assert.equal(error.key, "errors.phone");
        assert.equal(error.vars?.field, "i_phone_label");
        assert.equal(error.vars?.step, 1);
        return true;
      },
    );

    const staffCreated = await createProperty(admin(), {
      name: `員工信箱 ${stamp}`,
      city: "台中市",
      district: "西區",
      street: "府後街38",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "施振榮",
      ownerPhone: "+886912378683",
      ownerEmail: STAFF_EMAIL,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "3",
      rentalMode: "whole_unit",
      rooms: [{ label: "3F", roomType: "whole_home", baseRentMajor: 10000 }],
    });
    staffProperty = staffCreated.propertyId;
    staffContact = staffCreated.ownerContactId;
    const freshCreated = await createProperty(admin(), {
      name: `府後街 38 ${stamp}`,
      city: "台中市",
      district: "西區",
      street: "府後街38",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "施振榮",
      ownerPhone: "+886912378683",
      ownerEmail: freshEmail,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "雅房", baseRentMajor: 1000 },
        { label: "B", roomType: "獨立套房", baseRentMajor: 8000 },
      ],
    });
    freshProperty = freshCreated.propertyId;
    freshContact = freshCreated.ownerContactId;
    assert.equal(staffCreated.inviteCode, null);
    assert.equal(freshCreated.inviteCode, null);
    assert.deepEqual(Object.keys(staffCreated).sort(), Object.keys(freshCreated).sort());
    assert.equal(await accountCount(STAFF_EMAIL), staffBefore);
    assert.equal(await accountCount(freshEmail), "0");

    const contacts = await query<{ id: string; user_id: string | null; email: string; phone: string }>(
      `SELECT id::text, user_id::text AS user_id, email::text AS email, phone_e164 AS phone
         FROM contacts WHERE id = ANY($1::uuid[])`,
      [[staffContact, freshContact]],
    );
    assert.equal(contacts.rows.length, 2);
    assert.equal(contacts.rows.every((row) => row.user_id === null), true);

    const freshRow = await query<{ floor: string | null; phone: string; label: string; room_type: string; rent: string }>(
      `SELECT u.floor, c.phone_e164 AS phone, r.label, r.room_type::text, r.base_rent_minor::text AS rent
         FROM contacts c
         JOIN units u ON u.property_id = $2
         JOIN rooms r ON r.unit_id = u.id
        WHERE c.id = $1
        ORDER BY r.label`,
      [freshContact, freshProperty],
    );
    assert.equal(freshRow.rows[0].phone, "+886912378683");
    assert.equal(freshRow.rows[0].floor, null);
    assert.deepEqual(
      freshRow.rows.map((row) => ({ label: row.label, room_type: row.room_type, rent: row.rent })),
      [
        { label: "A", room_type: "shared_bath", rent: "100000" },
        { label: "B", room_type: "studio", rent: "800000" },
      ],
    );

    const issued = await issuePortalInvite(admin(), { kind: "owner", contactId: freshContact, pageId: freshContact }, "https://app.condola.app");
    assert.equal(issued.activated, false);
    if (issued.activated) return;
    assert.equal(issued.email, freshEmail);
    assert.equal(await accountCount(freshEmail), "0");
    const accepted = await acceptInvite(issued.token, "", "Owner1234", "", meta);
    assert.equal(accepted.ok, true);
    assert.equal(await accountCount(freshEmail), "1");
    const bound = await query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [freshContact]);
    assert.ok(bound.rows[0].user_id);
    const signedIn = await signIn(freshEmail, "Owner1234", false, meta);
    assert.equal(signedIn.ok, true);

    const taken = await query<{ id: string; encrypted_password: string }>(
      `INSERT INTO auth.users (
         id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud
       ) VALUES (
         gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), '{}'::jsonb, 'authenticated', 'authenticated'
       ) RETURNING id::text, encrypted_password`,
      [takenEmail, "Owner1234"],
    );
    await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, '已有帳號', $2)`, [taken.rows[0].id, takenEmail]);
    const takenContactRow = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
       VALUES ($1, true, '已有帳號屋主', $2, 'zh-TW') RETURNING id::text`,
      [ORG_ID, takenEmail],
    );
    takenContact = takenContactRow.rows[0].id;
    const takenLink = await issuePortalInvite(admin(), { kind: "owner", contactId: takenContact, pageId: takenContact }, "https://app.condola.app");
    assert.equal(takenLink.activated, false);
    if (takenLink.activated) return;
    assert.equal(await accountCount(takenEmail), "1");
    const wrong = await acceptInvite(takenLink.token, "", "Wrong1234", "", meta);
    assert.deepEqual(wrong, { ok: false, error: "auth", kind: "owner" });
    const unbound = await query<{ user_id: string | null }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [takenContact]);
    assert.equal(unbound.rows[0].user_id, null);
    const still = await query<{ encrypted_password: string }>(
      `SELECT encrypted_password FROM auth.users WHERE id = $1`,
      [taken.rows[0].id],
    );
    assert.equal(still.rows[0].encrypted_password, taken.rows[0].encrypted_password);
    const right = await acceptInvite(takenLink.token, "", "Owner1234", "", meta);
    assert.equal(right.ok, true);
    const linked = await query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [takenContact]);
    assert.equal(linked.rows[0].user_id, taken.rows[0].id);
    const unchanged = await query<{ encrypted_password: string }>(
      `SELECT encrypted_password FROM auth.users WHERE id = $1`,
      [taken.rows[0].id],
    );
    assert.equal(unchanged.rows[0].encrypted_password, taken.rows[0].encrypted_password);
    assert.equal(await accountCount(STAFF_EMAIL), staffBefore);
  } finally {
    await removeProperty(staffProperty, staffContact);
    await removeProperty(freshProperty, freshContact);
    await removeProperty("", takenContact);
    await removeLogin(freshEmail);
    await removeLogin(takenEmail);
  }
});
