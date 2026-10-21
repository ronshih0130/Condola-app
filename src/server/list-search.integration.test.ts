import assert from "node:assert/strict";
import test from "node:test";
import { query } from "./db";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { searchLeases, searchProperties, searchSpaces, searchTenants } from "./queries";
import type { Session } from "./types";

function staff(partial: Pick<Session, "userId" | "email" | "name" | "role" | "orgId">): Session {
  return {
    sessionId: "list-search",
    kind: "staff",
    liveOrgId: partial.orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
    ...partial,
  };
}

const admin = staff({
  userId: USERS.admin,
  email: "yating.lin@songxin.demo",
  name: "林雅婷",
  role: "admin",
  orgId: ORG_ID,
});

const accountant = staff({
  userId: USERS.accountant,
  email: "meiling.zhou@songxin.demo",
  name: "周美玲",
  role: "accountant",
  orgId: ORG_ID,
});

const coast = staff({
  userId: USERS.coastAdmin,
  email: "admin@coast.demo",
  name: "高海明",
  role: "admin",
  orgId: ORG2_ID,
});

test("list search stays inside the firm and ignores national ID numbers", async () => {
  const contact = await query<{ id: string }>(
    `SELECT id::text FROM contacts WHERE org_id = $1 AND display_name = '李愛玲'`,
    [ORG_ID],
  );
  assert.ok(contact.rows[0]);
  await query(
    `INSERT INTO identity_documents (org_id, contact_id, doc_type, number_masked, number_hash, storage_path, encryption_key_ref)
     VALUES ($1, $2, 'tw_national_id', 'Z9SEARCHID99', 'hash-z9searchid99', 'demo/search-id', 'test-key')`,
    [ORG_ID, contact.rows[0].id],
  );
  try {
    const ownName = await searchLeases(admin, { q: "李愛玲", limit: 20 });
    assert.ok(ownName.rows.some((row) => row.tenant === "李愛玲" && row.place.includes("大安和平")));
    assert.equal(ownName.rows.some((row) => row.place.includes("延平")), false);

    const byPhone = await searchLeases(admin, { q: "912111003", limit: 20 });
    assert.deepEqual(
      byPhone.rows.map((row) => row.tenant),
      ["李愛玲"],
    );
    const accountantPhone = await searchLeases(accountant, { q: "912111003", limit: 20 });
    assert.equal(accountantPhone.rows.length, 0);
    const accountantEmail = await searchLeases(accountant, { q: "ailing.li@tenant.demo", limit: 20 });
    assert.equal(accountantEmail.rows.length, 0);
    const adminEmail = await searchLeases(admin, { q: "ailing.li@tenant.demo", limit: 20 });
    assert.deepEqual(
      adminEmail.rows.map((row) => row.tenant),
      ["李愛玲"],
    );
    const accountantName = await searchLeases(accountant, { q: "李愛玲", limit: 20 });
    assert.ok(accountantName.rows.some((row) => row.tenant === "李愛玲"));
    const tenantRows = await searchTenants(admin, { q: "王小美", limit: 20 });
    assert.ok(tenantRows.rows.some((row) => row.tenant === "王小美" && row.place.includes("信義")));
    assert.equal((await searchTenants(accountant, { q: "912111002", limit: 20 })).rows.length, 0);
    assert.equal((await searchTenants(accountant, { q: "xiaomei.wang@tenant.demo", limit: 20 })).rows.length, 0);

    const byEmail = await searchLeases(admin, { q: "alex.kim@tenant.demo", limit: 20 });
    assert.deepEqual(
      byEmail.rows.map((row) => row.tenant),
      ["Alex Kim"],
    );
    const byUnit = await searchLeases(admin, { q: "3F", limit: 20 });
    const unitNames = byUnit.rows.map((row) => row.tenant).sort();
    assert.deepEqual(unitNames, ["張雅文", "王小美"].sort());

    const idNumber = await searchLeases(admin, { q: "Z9SEARCHID99", limit: 20 });
    const idHash = await searchLeases(admin, { q: "hash-z9searchid99", limit: 20 });
    assert.equal(idNumber.rows.length, 0);
    assert.equal(idHash.rows.length, 0);

    const injected = await searchLeases(admin, { q: "' OR org_id <> '", limit: 20 });
    assert.equal(injected.rows.length, 0);
    const wildcard = await searchProperties(admin, { q: "%", limit: 20 });
    assert.equal(wildcard.rows.length, 0);
    const underscore = await searchProperties(admin, { q: "_", limit: 20 });
    assert.equal(underscore.rows.length, 0);

    const songxinStreet = await searchProperties(admin, { q: "松仁路", limit: 20 });
    assert.deepEqual(
      songxinStreet.rows.map((row) => row.name),
      ["信義松仁"],
    );
    const owner = await searchProperties(admin, { q: "陳建宏", limit: 20 });
    assert.deepEqual(
      owner.rows.map((row) => row.name),
      ["信義松仁"],
    );
    const ownerPhone = await searchProperties(admin, { q: "923111222", limit: 20 });
    assert.deepEqual(
      ownerPhone.rows.map((row) => row.name),
      ["信義松仁"],
    );
    assert.equal((await searchProperties(accountant, { q: "923111222", limit: 20 })).rows.length, 0);
    const ownerEmail = await searchProperties(admin, { q: "chen.owner@demo.mail", limit: 20 });
    assert.deepEqual(
      ownerEmail.rows.map((row) => row.name),
      ["信義松仁"],
    );
    assert.equal((await searchProperties(accountant, { q: "chen.owner@demo.mail", limit: 20 })).rows.length, 0);
    const ownerSpace = await searchSpaces(admin, { q: "923111222", limit: 20 });
    assert.ok(ownerSpace.rows.length > 0);
    assert.ok(ownerSpace.rows.every((row) => row.property_name.includes("信義")));
    assert.equal((await searchSpaces(accountant, { q: "923111222", limit: 20 })).rows.length, 0);
    assert.equal((await searchSpaces(accountant, { q: "chen.owner@demo.mail", limit: 20 })).rows.length, 0);

    const coastLeak = await searchProperties(coast, { q: "信義松仁", limit: 20 });
    assert.equal(coastLeak.rows.length, 0);
    const coastHit = await searchProperties(coast, { q: "延平", limit: 20 });
    assert.deepEqual(
      coastHit.rows.map((row) => row.name),
      ["延平北路"],
    );
    const coastTenant = await searchLeases(coast, { q: "張雅文", limit: 20 });
    assert.ok(coastTenant.rows.every((row) => row.place.includes("延平")));
    assert.equal(coastTenant.rows.some((row) => row.place.includes("信義")), false);
    const songxinSameName = await searchLeases(admin, { q: "張雅文", limit: 20 });
    assert.ok(songxinSameName.rows.every((row) => row.place.includes("信義")));
    assert.equal(songxinSameName.rows.some((row) => row.place.includes("延平")), false);

    const forged = await searchProperties({ ...coast, orgId: ORG_ID, liveOrgId: ORG_ID }, { q: "信義", limit: 20 });
    assert.equal(forged.rows.length, 0);

    const room = await searchSpaces(admin, { q: "Apt 2B", limit: 20 });
    assert.equal(room.rows.length, 1);
    assert.equal(room.rows[0]?.property_name, "Oakland 12th");
    const coastRoom = await searchSpaces(coast, { q: "Apt 2B", limit: 20 });
    assert.equal(coastRoom.rows.length, 0);
    const coastFloor = await searchSpaces(coast, { q: "5F", limit: 20 });
    assert.ok(coastFloor.rows.length > 0);
    assert.equal(
      (await searchSpaces(admin, { q: "5F", limit: 20 })).rows.length,
      0,
    );

    const page1 = await searchProperties(admin, { limit: 1, page: 1 });
    const page2 = await searchProperties(admin, { limit: 1, page: 2 });
    assert.equal(page1.rows.length, 1);
    assert.equal(page1.hasNext, true);
    assert.equal(page2.rows.length, 1);
    assert.notEqual(page1.rows[0]?.id, page2.rows[0]?.id);
    const pageFar = await searchProperties(admin, { limit: 1, page: 99 });
    assert.equal(pageFar.rows.length, 0);
    assert.equal(pageFar.hasNext, false);
  } finally {
    await query(`DELETE FROM identity_documents WHERE number_masked = 'Z9SEARCHID99'`);
  }
});
