import type { Client } from "pg";
import { BILLABLE_ACTIVE_LEASE } from "./billing";
import { maybe, tx } from "./db";
import { FlowError } from "./errors";
import { displaySampleName } from "./sandbox-data";
import { formatTaipeiDate } from "./time";
import { assertStaff, type Session } from "./types";
import { dayAfter } from "./unit-limit";

export type UnitSpace = {
  id: string;
  kind: string;
  name: string;
  created: string;
  editable: boolean;
  kept: boolean;
};

export type UnitLimitView = {
  phase: "open" | "trial" | "grace" | "locked";
  graceDaysLeft: number;
  spaceCount: number;
  otherCount: number;
  billed: number | null;
  pending: number | null;
  periodEnd: string | null;
  nextStart: string | null;
  active: number;
  spaces: UnitSpace[];
};

export async function assertSpaceEditable(client: Client, orgId: string, spaceId: string | null) {
  if (!spaceId) return;
  const row = await client.query<{ ok: boolean }>(`SELECT app.space_editable($1::uuid, $2::uuid) AS ok`, [orgId, spaceId]);
  if (row.rows[0]?.ok === false) throw new FlowError("errors.forbidden");
}

export async function assertLeaseEditable(client: Client, orgId: string, leaseId: string) {
  const row = await maybe<{ space_id: string | null }>(
    client,
    `SELECT coalesce(target_room_id, target_unit_id)::text AS space_id
       FROM leases WHERE id = $1 AND org_id = $2`,
    [leaseId, orgId],
  );
  await assertSpaceEditable(client, orgId, row?.space_id ?? null);
}

export async function spaceIsEditable(session: Session, spaceId: string) {
  return tx(session.userId, async (client) => {
    const row = await client.query<{ ok: boolean }>(`SELECT app.space_editable($1::uuid, $2::uuid) AS ok`, [
      session.orgId,
      spaceId,
    ]);
    return row.rows[0]?.ok !== false;
  });
}

export async function leaseIsEditable(session: Session, leaseId: string) {
  return tx(session.userId, async (client) => {
    const row = await client.query<{ ok: boolean }>(
      `SELECT app.space_editable(l.org_id, coalesce(l.target_room_id, l.target_unit_id)) AS ok
         FROM leases l
        WHERE l.id = $1 AND l.org_id = $2`,
      [leaseId, session.orgId],
    );
    return row.rows[0]?.ok !== false;
  });
}

export async function saveKeptUnits(session: Session, ids: string[]) {
  assertStaff(session, ["admin"]);
  const unique = [...new Set(ids.filter(Boolean))];
  await tx(session.userId, async (client) => {
    await client.query(`SELECT app.set_kept_units($1::uuid, $2::uuid[])`, [session.orgId, unique]);
  });
}

export async function loadUnitLimit(session: Session): Promise<UnitLimitView> {
  return tx(session.userId, async (client) => {
    const activeRow = await client.query<{ n: number }>(
      `SELECT count(DISTINCT coalesce(target_room_id::text, target_unit_id::text))::int AS n
         FROM leases
        WHERE org_id = $1 AND ${BILLABLE_ACTIVE_LEASE}
          AND coalesce(target_room_id, target_unit_id) IS NOT NULL`,
      [session.orgId],
    );
    const active = activeRow.rows[0]?.n ?? 0;
    const billed = await client.query<{ billed: number | null; pending: number | null; period_end: string | null }>(
      `SELECT billed, pending, period_end::text FROM app.sync_billed_units($1::uuid, $2, NULL)`,
      [session.orgId, active],
    );
    const state = await client.query<{ phase: UnitLimitView["phase"]; grace_days_left: number; space_count: number }>(
      `SELECT phase, grace_days_left, space_count FROM app.unit_limit_state($1::uuid)`,
      [session.orgId],
    );
    const spaces = await client.query<{
      id: string;
      kind: string;
      label: string;
      created_at: Date;
      editable: boolean;
      kept: boolean;
    }>(
      `SELECT s.id::text, s.kind, s.label, s.created_at,
              app.space_editable($1::uuid, s.id) AS editable,
              EXISTS (SELECT 1 FROM app.kept_space_ids($1::uuid) k WHERE k = s.id) AS kept
         FROM app.portfolio_spaces($1::uuid) s
        ORDER BY s.created_at, s.id`,
      [session.orgId],
    );
    const bill = billed.rows[0];
    const phase = state.rows[0]?.phase ?? "open";
    const spaceCount = state.rows[0]?.space_count ?? spaces.rows.length;
    const periodEnd = bill?.period_end ?? null;
    return {
      phase,
      graceDaysLeft: state.rows[0]?.grace_days_left ?? 0,
      spaceCount,
      otherCount: Math.max(0, spaceCount - 4),
      billed: bill?.billed ?? null,
      pending: bill?.pending ?? null,
      periodEnd,
      nextStart: periodEnd ? dayAfter(periodEnd) : null,
      active,
      spaces: spaces.rows.map((space) => ({
        id: space.id,
        kind: space.kind,
        name: displaySampleName(space.label),
        created: formatTaipeiDate(space.created_at).replaceAll("-", "/"),
        editable: space.editable,
        kept: space.kept,
      })),
    };
  });
}
