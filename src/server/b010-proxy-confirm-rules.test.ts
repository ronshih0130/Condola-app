import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  decideConfirmation,
  needsProxyPopup,
  PROXY_CONFIRM_LABEL,
  readProxyOwnerConfirmed,
  type Collector,
  type ConfirmActor,
} from "./b010-proxy-confirm-rules";
import {
  reminderEligible,
  planScheduledReminder,
} from "./reminder-foundation";

type ConfirmationInput = Parameters<typeof decideConfirmation>[0];

function confirmationInput(
  overrides: Partial<ConfirmationInput> = {},
): ConfirmationInput {
  return {
    collector: "owner",
    ownerContactId: "owner-1",
    actor: { kind: "staff", role: "admin", userId: "staff-1" },
    proxyOwnerConfirmed: false,
    paymentStatus: "submitted",
    ...overrides,
  };
}

const collectors: Collector[] = ["management", "owner"];
const staffRoles = [
  "admin",
  "manager",
  "accountant",
  "maintenance",
  null,
] as const;

const actors: ConfirmActor[] = [
  ...staffRoles.map(
    (role): ConfirmActor => ({
      kind: "staff",
      role,
      userId: `staff-${role}`,
    }),
  ),
  { kind: "owner", userId: "owner-user-1", ownerContactId: "owner-1" },
  { kind: "owner", userId: "owner-user-2", ownerContactId: "owner-2" },
  { kind: "owner", userId: "owner-user-3", ownerContactId: null },
  { kind: "tenant", userId: "tenant-1" },
];

test("confirmed status takes precedence over actor and collector rules", () => {
  for (const collector of collectors) {
    for (const actor of actors) {
      assert.deepEqual(
        decideConfirmation(
          confirmationInput({
            collector,
            actor,
            paymentStatus: "confirmed",
          }),
        ),
        { ok: false, code: "already_confirmed" },
      );
    }
  }
});

test("every status other than submitted or confirmed is not_submitted", () => {
  for (const paymentStatus of ["draft", "paid", "rejected", "", "SUBMITTED"]) {
    for (const actor of actors) {
      assert.deepEqual(
        decideConfirmation(confirmationInput({ paymentStatus, actor })),
        { ok: false, code: "not_submitted" },
      );
    }
  }
});

test("tenants cannot confirm for either collector", () => {
  for (const collector of collectors) {
    for (const proxyOwnerConfirmed of [false, true]) {
      assert.deepEqual(
        decideConfirmation(
          confirmationInput({
            collector,
            proxyOwnerConfirmed,
            actor: { kind: "tenant", userId: "tenant-1" },
          }),
        ),
        { ok: false, code: "forbidden" },
      );
    }
  }
});

test("maintenance and missing staff roles are forbidden before proxy checks", () => {
  for (const role of ["maintenance", null] as const) {
    for (const collector of collectors) {
      for (const proxyOwnerConfirmed of [false, true]) {
        assert.deepEqual(
          decideConfirmation(
            confirmationInput({
              collector,
              proxyOwnerConfirmed,
              actor: { kind: "staff", role, userId: "staff-1" },
            }),
          ),
          { ok: false, code: "forbidden" },
        );
      }
    }
  }
});

for (const role of ["admin", "manager", "accountant"] as const) {
  test(`${role} confirms management collection without proxy consent`, () => {
    for (const proxyOwnerConfirmed of [false, true]) {
      assert.deepEqual(
        decideConfirmation(
          confirmationInput({
            collector: "management",
            proxyOwnerConfirmed,
            actor: { kind: "staff", role, userId: "staff-1" },
          }),
        ),
        {
          ok: true,
          confirmedVia: "management",
          onBehalfOfOwnerContactId: null,
        },
      );
    }
  });

  test(`${role} requires explicit proxy consent for owner collection`, () => {
    assert.deepEqual(
      decideConfirmation(
        confirmationInput({
          actor: { kind: "staff", role, userId: "staff-1" },
        }),
      ),
      { ok: false, code: "proxy_confirmation_required" },
    );
  });

  test(`${role} confirms on behalf of the collecting owner with consent`, () => {
    for (const ownerContactId of ["owner-1", null]) {
      assert.deepEqual(
        decideConfirmation(
          confirmationInput({
            ownerContactId,
            proxyOwnerConfirmed: true,
            actor: { kind: "staff", role, userId: "staff-1" },
          }),
        ),
        {
          ok: true,
          confirmedVia: "staff_proxy",
          onBehalfOfOwnerContactId: ownerContactId,
        },
      );
    }
  });
}

test("truthy non-boolean proxy values do not bypass explicit consent", () => {
  for (const value of ["true", "1", "on", 1, {}, []]) {
    assert.deepEqual(
      decideConfirmation(
        confirmationInput({
          proxyOwnerConfirmed: value as unknown as boolean,
        }),
      ),
      { ok: false, code: "proxy_confirmation_required" },
    );
  }
});

test("owners cannot confirm management collection", () => {
  for (const ownerContactId of ["owner-1", "owner-2", null]) {
    assert.deepEqual(
      decideConfirmation(
        confirmationInput({
          collector: "management",
          proxyOwnerConfirmed: true,
          actor: { kind: "owner", userId: "owner-user", ownerContactId },
        }),
      ),
      { ok: false, code: "forbidden" },
    );
  }
});

test("matching owner contact IDs confirm directly without proxy consent", () => {
  for (const ownerContactId of ["owner-1", null]) {
    for (const proxyOwnerConfirmed of [false, true]) {
      const actor: ConfirmActor = {
        kind: "owner",
        userId: "independent-user-id",
        ownerContactId,
      };

      assert.deepEqual(
        decideConfirmation(
          confirmationInput({
            ownerContactId,
            actor,
            proxyOwnerConfirmed,
          }),
        ),
        {
          ok: true,
          confirmedVia: "owner_direct",
          onBehalfOfOwnerContactId: null,
        },
      );
      assert.equal(needsProxyPopup("owner", actor), false);
    }
  }
});

test("mismatched owner contact IDs are forbidden even with proxy consent", () => {
  const pairs: Array<[string | null, string | null]> = [
    ["owner-1", "owner-2"],
    ["owner-1", null],
    [null, "owner-1"],
  ];

  for (const [ownerContactId, actorOwnerContactId] of pairs) {
    for (const proxyOwnerConfirmed of [false, true]) {
      assert.deepEqual(
        decideConfirmation(
          confirmationInput({
            ownerContactId,
            proxyOwnerConfirmed,
            actor: {
              kind: "owner",
              userId: "owner-1",
              ownerContactId: actorOwnerContactId,
            },
          }),
        ),
        { ok: false, code: "forbidden" },
      );
    }
  }
});

test("proxy popup is needed exactly for staff with owner collection", () => {
  for (const collector of collectors) {
    for (const actor of actors) {
      assert.equal(
        needsProxyPopup(collector, actor),
        collector === "owner" && actor.kind === "staff",
      );
    }
  }
});

test("proxy confirmation label matches the required text", () => {
  assert.equal(PROXY_CONFIRM_LABEL, "代屋主確認已繳款");
});

test("proxy confirmation parser accepts only the four explicit values", () => {
  for (const value of [true, "true", "1", "on"]) {
    assert.equal(readProxyOwnerConfirmed(value), true);
  }

  for (const value of [
    false,
    undefined,
    null,
    0,
    1,
    -1,
    NaN,
    "",
    "false",
    "0",
    "off",
    "TRUE",
    "ON",
    " true ",
    "yes",
    [],
    {},
    ["true"],
    new Boolean(true),
  ]) {
    assert.equal(readProxyOwnerConfirmed(value), false);
  }
});

type ReminderCandidate = Parameters<typeof reminderEligible>[0];

function reminderCandidate(
  overrides: Partial<ReminderCandidate> = {},
): ReminderCandidate {
  return {
    leaseStatus: "active",
    terminatedOn: null,
    invoiceStatus: "open",
    balanceMinor: 10000,
    hasRent: true,
    dueDate: "2026-03-08",
    timeZone: "America/Los_Angeles",
    ...overrides,
  };
}

const schedule = { due: [-3, 0], overdue: [1, 7] };

test("an active lease with unpaid rent is reminder eligible", () => {
  assert.equal(reminderEligible(reminderCandidate()), true);
});

test("a paid invoice with zero balance is reminder ineligible", () => {
  const candidate = reminderCandidate({
    invoiceStatus: "paid",
    balanceMinor: 0,
  });

  assert.equal(reminderEligible(candidate), false);
  assert.deepEqual(
    planScheduledReminder(candidate, schedule, new Date("2026-03-08T09:30Z")),
    [],
  );
});

test("a terminated lease is reminder ineligible", () => {
  const candidate = reminderCandidate({
    leaseStatus: "terminated",
    terminatedOn: "2026-03-01",
  });

  assert.equal(reminderEligible(candidate), false);
  assert.deepEqual(
    planScheduledReminder(candidate, schedule, new Date("2026-03-08T09:30Z")),
    [],
  );
});

test("planning the same instant twice produces the same occurrence key", () => {
  const candidate = reminderCandidate();
  const at = new Date("2026-03-08T09:30Z");
  const first = planScheduledReminder(candidate, schedule, at);
  const second = planScheduledReminder(candidate, schedule, new Date(at));

  assert.equal(first.length, 1);
  assert.equal(first[0]!.occurrenceKey, "2026-03-08:0");
  assert.deepEqual(second, first);
});

test("Los Angeles DST transition instants use the correct local dates", () => {
  const cases = [
    {
      instant: "2026-03-08T09:30Z",
      localDate: "2026-03-08",
    },
    {
      instant: "2026-11-01T08:30Z",
      localDate: "2026-11-01",
    },
  ];

  for (const { instant, localDate } of cases) {
    const planned = planScheduledReminder(
      reminderCandidate({ dueDate: localDate }),
      schedule,
      new Date(instant),
    );

    assert.equal(planned.length, 1);
    assert.equal(planned[0]!.localDate, localDate);
    assert.equal(planned[0]!.occurrenceKey, `${localDate}:0`);
  }
});

test("Los Angeles planning uses the local date when it differs from UTC", () => {
  const planned = planScheduledReminder(
    reminderCandidate({ dueDate: "2026-03-07" }),
    schedule,
    new Date("2026-03-08T07:30Z"),
  );

  assert.equal(planned.length, 1);
  assert.equal(planned[0]!.localDate, "2026-03-07");
  assert.equal(planned[0]!.occurrenceKey, "2026-03-07:0");
});
