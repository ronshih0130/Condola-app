import { staffRepairTurns } from "./b3-repair-turns";
import { staffPaymentTurns } from "./b3-payment-turns";
import { staffRentalTurns, type StaffRentalTurns } from "./b3-rental-turns";
import { staffOverdueTurns } from "./b3-overdue-turns";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { query, tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm, can } from "./perms";
import { rentRoll } from "./queries";
import type { Session } from "./types";
import type { TodayMonthly, TodayTurns } from "../lib/b3-today";

/** Forbidden is an absent source; an operational failure is never an empty list. */
export async function readTodayTurn<T extends { state: string }>(read: () => Promise<T>): Promise<T | { state: "off" } | { state: "unavailable" }> {
  try { return await read(); }
  catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return { state: "off" };
    logServerError("b3_today_turn", error);
    return { state: "unavailable" };
  }
}
/** Presentation lookup only: the rental reader deliberately identifies spaces, not parent units. */
async function roomUnitsFor(session: Session, rentals: StaffRentalTurns): Promise<Record<string, string>> {
  const ids = rentals.state === "ready" ? rentals.mine.filter(row => row.targetKind === "room" && row.kind !== "renewal_ask").map(row => row.targetId) : [];
  if (!ids.length) return {};
  session = await guardEffectiveSession(session, "leases.edit");
  assertPerm(session, "leases.edit"); assertPerm(session, "props.view");
  return tx(session.userId, client => withEffectiveReadAuthority(client, session, "leases.edit", () =>
    withEffectiveReadAuthority(client, session, "props.view", async () => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      const rows = (await client.query<{ id: string; unit_id: string }>(
        `SELECT r.id::text, r.unit_id::text FROM rooms r JOIN units u ON u.id=r.unit_id AND u.org_id=$1
         WHERE r.org_id=$1 AND r.id=ANY($2::uuid[])`, [session.orgId, ids])).rows;
      const result = Object.fromEntries(rows.map(row => [row.id, row.unit_id]));
      if (ids.some(id => !result[id])) throw new Error("Missing rental turn unit");
      return result;
    })), requireOrgScope(session), { isolation: "repeatable read", readOnly: true });
}
async function monthlyContext(session: Session) {
  session = await guardEffectiveSession(session, "stmt.view");
  assertPerm(session, "stmt.view");
  return tx(session.userId, client => withEffectiveReadAuthority(client, session, "stmt.view", async () => {
    await client.query("SET LOCAL statement_timeout = '2s'");
    const row = (await client.query<{ period: string; currency: string }>(
      "SELECT to_char(current_date, 'YYYY-MM') AS period, default_currency AS currency FROM organizations WHERE id=$1", [session.orgId])).rows[0];
    if (!row) throw new Error("Missing monthly context");
    return row;
  }), requireOrgScope(session), { isolation: "repeatable read", readOnly: true });
}
export async function readTodayMonthly(session: Session, deps = { context: monthlyContext, rows: rentRoll }): Promise<TodayMonthly | undefined> {
  if (!can(session, "stmt.view")) return undefined;
  try {
    // Bracket the unchanged rentRoll call with the DB calendar; omit across month rollover.
    const before = await deps.context(session);
    const rows = await deps.rows(session);
    const after = await deps.context(session);
    if (before.period !== after.period || before.currency !== after.currency) return undefined;
    return { rows, month: Number(before.period.slice(5)), defaultCurrency: before.currency };
  } catch (error) {
    if (!(error instanceof FlowError && error.key === "errors.forbidden")) logServerError("b3_today_monthly", error);
    return undefined;
  }
}
/** Configuration-only service helper; today_dash includes today_home and allowlist admission. */
async function todayOperationsEnabled(session: Session): Promise<boolean> {
  const row = (await query<{ enabled: boolean }>(
    "SELECT app.b042_flag_on('today_dash', $1::uuid) AS enabled",
    [session.environment === "sandbox" ? session.liveOrgId : session.orgId])).rows[0];
  if (!row) throw new Error("Missing Today configuration");
  return row.enabled === true;
}
type TodayReadDeps = {
  enabled: typeof todayOperationsEnabled; payments: typeof staffPaymentTurns; rentals: typeof staffRentalTurns;
  overdue: typeof staffOverdueTurns; roomUnits: typeof roomUnitsFor; repairs?: typeof staffRepairTurns;
};
export async function readTodayTurns(session: Session, deps: TodayReadDeps = {
  enabled: todayOperationsEnabled, payments: staffPaymentTurns, rentals: staffRentalTurns,
  overdue: staffOverdueTurns, roomUnits: roomUnitsFor, repairs: staffRepairTurns,
}): Promise<TodayTurns> {
  const paymentAllowed = can(session, "pay.record");
  const rentalAllowed = (session.role === "admin" || session.role === "manager") && can(session, "leases.edit") && can(session, "props.view");
  const repairAllowed = can(session, "tickets.update");
  if (!paymentAllowed && !rentalAllowed && !repairAllowed) return { payments: { state: "off" }, rentals: { state: "off" }, overdue: { state: "off" }, repairs: { state: "off" }, roomUnits: {} };
  const gate = await readTodayTurn(async () => ({ state: "ready" as const, enabled: await deps.enabled(session) }));
  if (gate.state !== "ready" || !gate.enabled) {
    const state = gate.state === "unavailable" ? "unavailable" as const : "off" as const;
    return { payments: { state }, rentals: { state }, overdue: { state }, repairs: { state }, roomUnits: {} };
  }
  const [payments, initialRentals, overdue, repairs] = await Promise.all([
    paymentAllowed ? readTodayTurn(() => deps.payments(session)) : { state: "off" as const },
    rentalAllowed ? readTodayTurn(() => deps.rentals(session)) : { state: "off" as const },
    paymentAllowed ? readTodayTurn(() => deps.overdue(session)) : { state: "off" as const },
    repairAllowed ? readTodayTurn(() => (deps.repairs ?? staffRepairTurns)(session)) : { state: "off" as const },
  ]);
  let rentals = initialRentals;
  let roomUnits: Record<string, string> = {};
  if (rentals.state === "ready") {
    const result = await readTodayTurn(async () => ({ state: "ready" as const, units: await deps.roomUnits(session, rentals) }));
    if (result.state === "ready") roomUnits = result.units;
    else rentals = result;
  }
  return { payments, rentals, overdue, repairs, roomUnits };
}
