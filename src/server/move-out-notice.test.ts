import assert from "node:assert/strict";
import test from "node:test";
import {
  isMoveOutNoticeEnabled,
  recordMoveOutNotice,
} from "./move-out-notice";

type Call = { sql: string; params?: unknown[] };

class FakeClient {
  readonly calls: Call[] = [];
  found = true;
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
    return {
      rows: sql.includes("UPDATE leases") && this.found ? [{ id: input.leaseId }] : [],
    };
  }
}

const input = {
  orgId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  movedOutOn: "2026-06-10",
  actorUserId: "33333333-3333-4333-8333-333333333333",
};

test("move-out notice", { concurrency: false }, async (t) => {
  const previous = process.env.MOVE_OUT_NOTICE_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.MOVE_OUT_NOTICE_ENABLED;
    else process.env.MOVE_OUT_NOTICE_ENABLED = previous;
  });

  await t.test("flag defaults off and only exact true enables", () => {
    assert.equal(isMoveOutNoticeEnabled({}), false);
    for (const value of ["", "false", "TRUE", "True", "1", " true", "true "]) {
      assert.equal(isMoveOutNoticeEnabled({ MOVE_OUT_NOTICE_ENABLED: value }), false);
    }
    assert.equal(isMoveOutNoticeEnabled({ MOVE_OUT_NOTICE_ENABLED: "true" }), true);
  });

  await t.test("disabled performs no queries, even for an invalid date", async () => {
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

  await t.test("updates only moved_out_on, scoped by lease and org", async () => {
    process.env.MOVE_OUT_NOTICE_ENABLED = "true";
    const client = new FakeClient();
    assert.deepEqual(await recordMoveOutNotice(client, input), { ok: true });
    assert.equal(client.calls.length, 4);
    assert.equal(client.calls[0]!.sql, "BEGIN");
    assert.match(
      client.calls[1]!.sql,
      /set_config\('app\.change_reason', \$1, true\)/,
    );
    assert.deepEqual(client.calls[1]!.params, [
      "move-out notice (CAP-M-13)",
      input.actorUserId,
    ]);
    const update = client.calls[2]!;
    assert.match(
      update.sql.replace(/\s+/g, " ").trim(),
      /^UPDATE leases SET moved_out_on = \$1::date WHERE id = \$2 AND org_id = \$3 RETURNING id$/,
    );
    assert.deepEqual(update.params, [
      input.movedOutOn,
      input.leaseId,
      input.orgId,
    ]);
    assert.equal(client.calls[3]!.sql, "COMMIT");
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
    assert.deepEqual(client.calls[1]!.params, [reason, input.actorUserId]);
    assert.equal(client.calls[2]!.params![0], "2028-02-29");
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
});
