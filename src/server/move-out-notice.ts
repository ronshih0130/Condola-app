type Environment = { readonly [key: string]: string | undefined };

type SqlClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type MoveOutNoticeInput = {
  orgId: string;
  leaseId: string;
  movedOutOn: string;
  actorUserId: string;
  reason?: string;
};

export type MoveOutNoticeResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "not_found" };

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
              set_config('app.actor_user_id', $2, true)`,
      [input.reason ?? "move-out notice (CAP-M-13)", input.actorUserId],
    );

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
