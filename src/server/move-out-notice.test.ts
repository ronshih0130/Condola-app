import assert from "node:assert/strict";
import test from "node:test";
import {
  isMoveOutNoticeEnabled,
  isMoveOutNoticeGloballyEnabled,
  moveOutNoticeAdmitted,
  recordMoveOutNotice,
} from "./move-out-notice";

type Call = { sql: string; params?: unknown[] };

const input = {
  orgId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  movedOutOn: "2026-06-10",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  liveOrgId: "11111111-1111-4111-8111-111111111111",
  environment: "live" as const,
};

class FakeClient {
  readonly calls: Call[] = [];
  found = true;
  admitted = true;
  missingOrg = false;
  failAt?: "config" | "update" | "commit";
  readonly failure = new Error("database failure");

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, params });
    if (
      (this.failAt === "config" && sql.includes("set_config")) ||
      (this.failAt === "update" && sql.includes("UPDATE leases")) ||
      (this.failAt === "commit" && sql === "COMMIT")
    ) {
      throw this.failure;
    }
    if (sql.includes("key='move_out_notice'")) {
      if (this.missingOrg) return { rows: [] };
      return {
        rows: [
          this.admitted
            ? {
                value: { enabled: true, allowed_org_ids: [input.orgId] },
                feature_flags: { move_out_notice: true },
              }
            : {
                value: { enabled: false, allowed_org_ids: [] },
                feature_flags: { move_out_notice: false },
              },
        ],
      };
    }
    return {
      rows: sql.includes("FROM organizations o JOIN organizations live")
        ? [{}]
        : sql.includes("UPDATE leases") && this.found
          ? [{ id: input.leaseId }]
          : [],
    };
  }
}

test("move-out notice", { concurrency: false }, async (t) => {
  const previous = process.env.MOVE_OUT_NOTICE_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.MOVE_OUT_NOTICE_ENABLED;
    else process.env.MOVE_OUT_NOTICE_ENABLED = previous;
  });

  await t.test("global kill switch only accepts the exact string true", () => {
    assert.equal(isMoveOutNoticeGloballyEnabled({}), false);
    for (const value of ["", "false", "TRUE", "True", "1", " true", "true "]) {
      assert.equal(
        isMoveOutNoticeGloballyEnabled({ MOVE_OUT_NOTICE_ENABLED: value }),
        false,
      );
    }
    assert.equal(
      isMoveOutNoticeGloballyEnabled({ MOVE_OUT_NOTICE_ENABLED: "true" }),
      true,
    );
  });

  await t.test("per-org admission fails closed on malformed admission data", () => {
    const allow = { enabled: true, allowed_org_ids: [input.orgId] };
    const flag = { move_out_notice: true };
    assert.equal(moveOutNoticeAdmitted(allow, flag, input.orgId), true);
    assert.equal(
      moveOutNoticeAdmitted({ ...allow, enabled: "true" }, flag, input.orgId),
      false,
    );
    assert.equal(
      moveOutNoticeAdmitted({ enabled: true, allowed_org_ids: [] }, flag, input.orgId),
      false,
    );
    assert.equal(
      moveOutNoticeAdmitted(
        { enabled: true, allowed_org_ids: ["99999999-9999-4999-8999-999999999999"] },
        flag,
        input.orgId,
      ),
      false,
    );
    for (const bad of [null, undefined, "move_out_notice", 1, [input.orgId]]) {
      assert.equal(moveOutNoticeAdmitted(bad, flag, input.orgId), false);
      assert.equal(moveOutNoticeAdmitted(allow, bad, input.orgId), false);
    }
    assert.equal(
      moveOutNoticeAdmitted(allow, { move_out_notice: "true" }, input.orgId),
      false,
    );
  });

  await t.test("global kill off performs no queries, even for an invalid date", async () => {
    delete process.env.MOVE_OUT_NOTICE_ENABLED;
    const client = new FakeClient();
    assert.deepEqual(
      await recordMoveOutNotice(client, { ...input, movedOutOn: "invalid" }),
      { ok: false, reason: "disabled" },
    );
    assert.deepEqual(client.calls, []);

    process.env.MOVE_OUT_NOTICE_ENABLED = "TRUE";
    assert.deepEqual(await recordMoveOutNotice(client, input), {
      ok: false,
      reason: "disabled",
    });
    assert.deepEqual(client.calls, []);
  });

  await t.test("invalid dates are rejected before any query", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    for (const movedOutOn of [
      "",
      "2026-6-10",
      "2026-06-10T00:00:00Z",
      "2026-02-29",
      "2026-02-30",
      "2026-04-31",
      "2026-13-01",
      "2026-00-01",
      "2026-01-00",
      "0000-01-01",
      "2026-06-10'; DROP TABLE leases; --",
    ]) {
      const client = new FakeClient();
      await assert.rejects(
        recordMoveOutNotice(client, { ...input, movedOutOn }),
        /valid YYYY-MM-DD date/,
      );
      assert.deepEqual(client.calls, []);
    }
  });

  await t.test("admits the org, then updates only moved_out_on", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    const client = new FakeClient();
    assert.deepEqual(await recordMoveOutNotice(client, input), { ok: true });
    assert.equal(client.calls.length, 7);
    assert.match(client.calls[0]!.sql, /key='move_out_notice'/);
    assert.deepEqual(client.calls[0]!.params, [input.orgId]);
    assert.equal(client.calls[1]!.sql, "BEGIN");
    assert.match(
      client.calls[2]!.sql,
      /set_config\('app\.change_reason', \$1, true\)/,
    );
    assert.deepEqual(client.calls[2]!.params, [
      "move-out notice (CAP-M-13)",
      input.actorUserId,
      input.orgId,
      input.environment,
    ]);
    assert.match(client.calls[2]!.sql, /request\.jwt\.claim\.sub/);
    assert.equal(client.calls[4]!.sql, "SET LOCAL ROLE authenticated");
    const update = client.calls[5]!;
    assert.match(
      update.sql.replace(/\s+/g, " ").trim(),
      /^UPDATE leases SET moved_out_on = \$1::date WHERE id = \$2 AND org_id = \$3 RETURNING id$/,
    );
    assert.deepEqual(update.params, [
      input.movedOutOn,
      input.leaseId,
      input.orgId,
    ]);
    assert.equal(client.calls[6]!.sql, "COMMIT");
  });

  await t.test("accepts leap day and preserves an explicit reason", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    const client = new FakeClient();
    const reason = "Tenant's confirmed move-out";
    assert.deepEqual(
      await recordMoveOutNotice(client, {
        ...input,
        movedOutOn: "2028-02-29",
        reason,
      }),
      { ok: true },
    );
    assert.deepEqual(client.calls[2]!.params, [
      reason,
      input.actorUserId,
      input.orgId,
      input.environment,
    ]);
    assert.equal(client.calls[5]!.params![0], "2028-02-29");
  });

  await t.test("returns not_found and rolls back when no lease matches", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    const client = new FakeClient();
    client.found = false;
    assert.deepEqual(await recordMoveOutNotice(client, input), {
      ok: false,
      reason: "not_found",
    });
    assert.equal(client.calls.at(-1)!.sql, "ROLLBACK");
    assert.equal(client.calls.some((call) => call.sql === "COMMIT"), false);
  });

  for (const failAt of ["config", "update", "commit"] as const) {
    await t.test(`rolls back and preserves the ${failAt} error`, async () => {
      process.env.MOVE_OUT_NOTICE_ENABLED = "true";
      const client = new FakeClient();
      client.failAt = failAt;
      await assert.rejects(recordMoveOutNotice(client, input), (error) => {
        assert.equal(error, client.failure);
        return true;
      });
      assert.equal(client.calls.at(-1)!.sql, "ROLLBACK");
    });
  }

  await t.test("org not admitted disables the write without a transaction", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    const client = new FakeClient();
    client.admitted = false;
    assert.deepEqual(await recordMoveOutNotice(client, input), {
      ok: false,
      reason: "disabled",
    });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0]!.sql, /key='move_out_notice'/);
    assert.equal(client.calls.some((call) => call.sql === "BEGIN"), false);
  });

  await t.test("global kill off wins even when the org would be admitted", async () => {
    delete process.env.MOVE_OUT_NOTICE_ENABLED;
    const client = new FakeClient();
    client.admitted = true;
    assert.deepEqual(await recordMoveOutNotice(client, input), {
      ok: false,
      reason: "disabled",
    });
    assert.deepEqual(client.calls, []);
  });

  await t.test("a non-UUID org id disables the write without a query", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    for (const orgId of ["", "not-a-uuid"]) {
      const client = new FakeClient();
      assert.deepEqual(await recordMoveOutNotice(client, { ...input, orgId }), {
        ok: false,
        reason: "disabled",
      });
      assert.deepEqual(client.calls, []);
    }
  });

  await t.test("a missing org row admits nothing and opens no transaction", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    const client = new FakeClient();
    client.missingOrg = true;
    assert.deepEqual(await recordMoveOutNotice(client, input), {
      ok: false,
      reason: "disabled",
    });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0]!.sql, /key='move_out_notice'/);
    assert.equal(client.calls.some((call) => call.sql === "BEGIN"), false);
  });
});
