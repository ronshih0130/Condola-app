import { pool, tx } from "../src/server/db";
import {
  approveMatch,
  confirmPayment,
  createLease,
  createProperty,
  generateStatement,
  importBankCsv,
  recordPayment,
  sampleCsv,
  signLease,
} from "../src/server/domain";
import { FlowError } from "../src/server/errors";
import { ORG_ID, USERS } from "../src/server/ids";
import { monthBounds } from "../src/server/money";
import { resetAndSeed } from "../src/server/seed";
import type { Session } from "../src/server/types";

function persona(overrides: Partial<Session> = {}): Session {
  return {
    userId: USERS.admin,
    name: "林雅婷",
    kind: "staff",
    role: "admin",
    orgId: ORG_ID,
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
    ...overrides,
  };
}

function leaseInput(roomId: string, reason: string) {
  const start = new Date().toISOString().slice(0, 10);
  const endDate = new Date();
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
  const month = start.slice(0, 7);
  const bounds = monthBounds(month);
  return {
    roomId,
    tenantName: "試用房客",
    tenantPhone: "+886912300002",
    tenantEmail: "",
    startDate: start,
    endDate: endDate.toISOString().slice(0, 10),
    rentMajor: 12000,
    depositMonths: 2,
    dueDay: 5,
    splitMethod: "even" as const,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    billTotalMajor: 2000,
    usageKwh: 400,
    rateMajor: 6,
    rateSource: "fixed_rate" as const,
    overrideReason: reason,
    subUsages: [],
  };
}

async function main() {
  await resetAndSeed();
  const admin = persona();
  const property = await createProperty(admin, {
    name: "松德試用",
    city: "台北市",
    district: "松山區",
    street: "松德路100號",
    currency: "TWD",
    ownerMode: "new",
    ownerName: "試用屋主",
    ownerPhone: "+886912300001",
    ownerEmail: "",
    canViewTenantPhone: false,
    unitLabel: "3F",
    floor: "3",
    rentalMode: "by_room",
    rooms: [
      { label: "A", roomType: "suite", baseRentMajor: 12000 },
      { label: "B", roomType: "shared_bath", baseRentMajor: 10000 },
    ],
  });
  console.log("property", property.propertyId, "invite", property.inviteCode);

  try {
    await createProperty(persona({ userId: USERS.maintenance, role: "maintenance", name: "吳大維" }), {
      name: "不該成功",
      city: "台北市",
      district: "松山區",
      street: "松德路1號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "某人",
      ownerPhone: "+886912300009",
      ownerEmail: "",
      canViewTenantPhone: false,
      unitLabel: "1F",
      floor: "1",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 1 },
        { label: "B", roomType: "suite", baseRentMajor: 1 },
      ],
    });
    throw new Error("maintenance was allowed to create a property");
  } catch (error) {
    if (!(error instanceof FlowError) || error.key !== "errors.forbidden") throw error;
    console.log("maintenance blocked");
  }

  try {
    await createLease(admin, leaseInput(property.roomIds[0], ""));
    throw new Error("over-cap lease saved without a reason");
  } catch (error) {
    if (!(error instanceof FlowError) || error.key !== "errors.capReason") throw error;
    console.log("cap blocked");
  }

  const lease = await createLease(admin, leaseInput(property.roomIds[0], "房客已書面同意此電價，含公共區域分攤。"));
  console.log("lease", lease.leaseId, "exceeds", lease.exceeds);

  await signLease(admin, { leaseId: lease.leaseId, signedName: "林雅婷", consent: true });
  const tenant = persona({ userId: lease.tenantUserId, kind: "tenant", role: null, name: "試用房客" });
  const signed = await signLease(tenant, { leaseId: lease.leaseId, signedName: "試用房客", consent: true });
  console.log("signed", signed);

  const balance = await tx(tenant.userId, async (client) => {
    const row = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(balance_minor),0)::text AS balance FROM invoices WHERE lease_id = $1 AND status IN ('open','partially_paid')`,
      [lease.leaseId],
    );
    return Number(row.rows[0].balance);
  });
  console.log("balance", balance);
  const paidOn = new Date().toISOString().slice(0, 10);
  const payment = await recordPayment(tenant, {
    leaseId: lease.leaseId,
    amountMajor: balance / 100,
    paidOn,
    last5: "54321",
    reference: "",
  });
  await confirmPayment(admin, payment.paymentId);
  const csv = sampleCsv({ paidOn, amountMinor: balance, last5: "54321", currency: "TWD" });
  await importBankCsv(admin, csv);
  const suggestion = await tx(admin.userId, async (client) => {
    const row = await client.query<{ id: string; score: string; reasons: { last5?: string } }>(
      `SELECT id, score::text, reasons FROM bank_match_suggestions WHERE status = 'suggested' ORDER BY score DESC LIMIT 1`,
    );
    return row.rows[0];
  });
  console.log("suggestion", suggestion);
  if (suggestion.reasons.last5 !== "54321") throw new Error("matcher missed last 5");
  await approveMatch(admin, suggestion.id);

  const statement = await generateStatement(admin, {
    ownerContactId: property.ownerContactId,
    month: paidOn.slice(0, 7),
  });
  const numbers = await tx(admin.userId, async (client) => {
    const row = await client.query(
      `SELECT rent_received_minor, other_income_minor, management_fee_minor, closing_balance_minor
         FROM owner_statements WHERE id = $1`,
      [statement.statementId],
    );
    return row.rows[0];
  });
  console.log("statement", numbers);
  if (Number(numbers.rent_received_minor) !== 1_200_000) throw new Error("rent mismatch");
  if (Number(numbers.management_fee_minor) !== 96_000) throw new Error("fee mismatch");

  const hidden = await tx(USERS.owner, async (client) => {
    const row = await client.query<{ tenant_phone: string | null; phone_visible: boolean }>(
      `SELECT tenant_phone, phone_visible FROM owner_lease_tenants WHERE tenant_name = '王小美'`,
    );
    return row.rows[0];
  });
  console.log("owner phone", hidden);
  if (hidden.phone_visible) throw new Error("phone should be hidden");
  if (hidden.tenant_phone) throw new Error("phone leaked");
  console.log("smoke ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
