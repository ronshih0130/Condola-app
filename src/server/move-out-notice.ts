type Environment = { readonly [key: string]: string | undefined };

type SqlClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type MoveOutNoticeInput = {
  orgId: string;
  leaseId: string;
  movedOutOn: string;
  actorUserId: string;
  liveOrgId: string;
  environment: "live" | "sandbox";
  reason?: string;
};

export type MoveOutNoticeResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "not_found" | "forbidden" };

export function isMoveOutNoticeEnabled(
  env: Environment = process.env,
): boolean {
  return env.MOVE_OUT_NOTICE_ENABLED === "true";
}

function validateDate(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
    value.startsWith("0000-")
  ) {
    throw new TypeError("movedOutOn must be a valid YYYY-MM-DD date");
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError("movedOutOn must be a valid YYYY-MM-DD date");
  }
}

/**
 * Call with a dedicated, connected client and no active transaction.
 * The caller must authenticate and authorize the actor for input.orgId.
 */
export async function recordMoveOutNotice(
  client: SqlClient,
  input: MoveOutNoticeInput,
): Promise<MoveOutNoticeResult> {
  if (!isMoveOutNoticeEnabled()) {
    return { ok: false, reason: "disabled" };
  }

  validateDate(input.movedOutOn);

  await client.query("BEGIN");
  try {
    await client.query(
      `SELECT set_config('app.change_reason', $1, true),
              set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', 'authenticated', true),
              set_config('app.active_org_id', $3, true),
              set_config('app.env', $4, true)`,
      [input.reason ?? "move-out notice (CAP-M-13)", input.actorUserId, input.orgId, input.environment],
    );

    const authorized = await client.query(
      `SELECT 1 FROM organizations o JOIN organizations live ON live.id=$2 AND live.environment='live'
       JOIN org_members m ON m.org_id=live.id AND m.user_id=$3 AND m.status='active'
         AND m.role IN ('admin','manager')
       WHERE o.id=$1 AND o.environment::text=$4
         AND (o.id=live.id AND o.environment='live' OR o.live_org_id=live.id AND o.environment='sandbox')
       FOR SHARE OF o, live, m`,
      [input.orgId, input.liveOrgId, input.actorUserId, input.environment],
    );
    if (!authorized.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "forbidden" };
    }
    await client.query("SET LOCAL ROLE authenticated");

    const result = await client.query(
      `UPDATE leases
          SET moved_out_on = $1::date
        WHERE id = $2 AND org_id = $3
        RETURNING id`,
      [input.movedOutOn, input.leaseId, input.orgId],
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}
