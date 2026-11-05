import assert from "node:assert/strict";
import test from "node:test";
import {
  addOrUpdateLine,
  attachEvidence,
  finalizeSettlement,
  getDepositSettlementStatus,
  openSettlement,
  recordPayment,
} from "./deposit-settlement";
import { FlowError } from "./errors";
import type { Session } from "./types";

test("deposit settlement remains disabled for valid org scopes", () => {
  for (const environment of ["live", "sandbox"] as const) {
    const session = {
      orgId: "10000000-0000-4000-8000-000000000001",
      environment,
    } as Session;
    assert.deepEqual(getDepositSettlementStatus(session), { enabled: false });
  }
});

test("deposit settlement validates org and environment before returning", () => {
  for (const orgId of ["", " ", null, undefined]) {
    const session = { orgId, environment: "live" } as unknown as Session;
    assert.throws(() => getDepositSettlementStatus(session), FlowError);
  }
  for (const environment of ["", "production", null, undefined]) {
    const session = { orgId: "10000000-0000-4000-8000-000000000001", environment } as unknown as Session;
    assert.throws(() => getDepositSettlementStatus(session), FlowError);
  }

const target = {
  leaseId: "20000000-0000-4000-8000-000000000001",
  settlementId: "30000000-0000-4000-8000-000000000001",
  expectedRevision: "1",
};
const writers: ReadonlyArray<readonly [string, (session: Session) => Promise<unknown>]> = [
  ["openSettlement", session => openSettlement(session, {
    leaseId: target.leaseId, basis: "move_out", depositHeldMinor: "10000", currency: "TWD",
  })],
  ["addOrUpdateLine", session => addOrUpdateLine(session, {
    ...target, lineId: "40000000-0000-4000-8000-000000000001", itemKey: "cleaning", amountMinor: "100", reason: "Cleaning",
  })],
  ["attachEvidence", session => attachEvidence(session, {
    ...target, evidenceId: "50000000-0000-4000-8000-000000000001",
    source: { kind: "handover_attachment", attachmentId: "60000000-0000-4000-8000-000000000001" },
  })],
  ["finalizeSettlement", session => finalizeSettlement(session, {
    ...target, expectedTotalDeductionMinor: "100",
  })],
  ["recordPayment", session => recordPayment(session, {
    ...target, requestId: "70000000-0000-4000-8000-000000000001",
    direction: "refund", amountMinor: "9900", currency: "TWD", method: "bank_transfer",
  })],
];

for (const [name, write] of writers) {
  test(`${name} remains disabled without a DB client for valid org scopes`, async () => {
    for (const environment of ["live", "sandbox"] as const) {
      const session = {
        orgId: "10000000-0000-4000-8000-000000000001",
        environment,
      } as Session;
      assert.deepEqual(await write(session), { ok: false, reason: "disabled" });
    }
  });

  test(`${name} rejects bad org and environment before returning disabled`, async () => {
    for (const orgId of ["", " ", null, undefined]) {
      const session = { orgId, environment: "live" } as unknown as Session;
      await assert.rejects(() => write(session), FlowError);
    }
    for (const environment of ["", "production", null, undefined]) {
      const session = {
        orgId: "10000000-0000-4000-8000-000000000001",
        environment,
      } as unknown as Session;
      await assert.rejects(() => write(session), FlowError);
    }
  });
}
});
