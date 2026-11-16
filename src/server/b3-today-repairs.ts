import { staffRepairTodayTurns, type RepairMatter, type StaffRepairTurns } from "./b3-repair-turns";
import { turnDayNumber } from "./b3-payment-turns";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { vendorLinkOn } from "./vendor-link-rules";
import type { Session } from "./types";

/** MGT-149-AC5 why clauses: 「廠商沒有接」 / 「廠商的連結已失效」. */
export type RepairWhy = "declined" | "link";
export type TodayRepairRow = RepairMatter & { title: string; why: RepairWhy | null; dayNumber: number | null };
export type TodayRepairs = { state: "off" | "unavailable" } | {
  state: "ready"; counts: Extract<StaffRepairTurns, { state: "ready" }>["counts"]; yourTurn: number;
  mine: TodayRepairRow[]; others: TodayRepairRow[];
};
export type RepairJobFacts = { title: string; activeJob: boolean; expired: boolean; unshared: boolean; lastRevoked: boolean };

/**
 * Only states whose cause is a fact we can show: R6 is by definition a declined job; an R8-blocked job is
 * explained only when its link is expired, unshared (enhanced links) or the latest job was revoked. Any other
 * blocked cause (authorisation, cost guard, a declined job that is not yet re-dispatchable) gets no clause.
 */
export function repairWhy(matter: Pick<RepairMatter, "rule">, facts: Omit<RepairJobFacts, "title">, enhanced: boolean): RepairWhy | null {
  if (matter.rule === "R6") return "declined";
  if (matter.rule !== "R8-blocked") return null;
  if (facts.activeJob) return facts.expired || (enhanced && facts.unshared) ? "link" : null;
  return facts.lastRevoked ? "link" : null;
}
export function repairDayNumber(matter: Pick<RepairMatter, "since" | "sinceExact" | "timezone">, now = new Date()): number | null {
  return matter.since && matter.sinceExact ? turnDayNumber({ since: matter.since, sinceExact: true, timezone: matter.timezone }, now) : null;
}

/** Presentation lookup only (repair item and why facts) for the ≤100 matters already admitted by the gateway. */
async function repairFacts(session: Session, ids: string[]): Promise<{ enhanced: boolean; facts: Record<string, RepairJobFacts> }> {
  session = await guardEffectiveSession(session, "tickets.update");
  assertPerm(session, "tickets.update");
  return tx(session.userId, client => withEffectiveReadAuthority(client, session, "tickets.update", async () => {
    await client.query("SET LOCAL statement_timeout = '2s'");
    const org = (await client.query<{ feature_flags: unknown; vendor_link: unknown }>(
      "SELECT feature_flags, (SELECT value FROM platform_settings WHERE key = 'vendor_link') AS vendor_link FROM organizations WHERE id = $1",
      [session.orgId])).rows[0];
    if (!org) throw new Error("Missing repair organization");
    const rows = (await client.query<RepairJobFacts & { id: string }>(
      `SELECT t.id::text, t.title,
              j.id IS NOT NULL AS "activeJob",
              coalesce(j.expires_at <= now(), false) AS expired,
              coalesce(j.sharing_approved_at IS NULL, false) AS unshared,
              coalesce((SELECT h.revoked_at IS NOT NULL FROM repair_vendor_jobs h
                 WHERE h.org_id = t.org_id AND h.ticket_id = t.id ORDER BY h.created_at DESC, h.id DESC LIMIT 1), false) AS "lastRevoked"
         FROM maintenance_tickets t
         LEFT JOIN repair_vendor_jobs j ON j.org_id = t.org_id AND j.ticket_id = t.id AND j.active AND j.revoked_at IS NULL
        WHERE t.org_id = $1 AND t.id = ANY($2::uuid[])`, [session.orgId, ids])).rows;
    const facts = Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
    if (ids.some(id => !facts[id])) throw new Error("Missing repair row facts");
    return { enhanced: vendorLinkOn(org.vendor_link, org.feature_flags, session.orgId), facts };
  }), requireOrgScope(session), { isolation: "repeatable read", readOnly: true });
}

/** The B6 sentences approved for each holder (MGT-149-AC2); anything else fails honestly (T-FAIL), never invented text. */
const APPROVED_STEPS: Record<string, readonly string[]> = {
  manager: ["confirm_cost", "dispatch", "re_estimate", "in_progress"], owner: ["approve_estimate"], vendor: ["do_repair", "report_cost"],
};
export function approvedRepairSentence(m: Pick<RepairMatter, "holder" | "step">): boolean {
  return APPROVED_STEPS[m.holder]?.includes(m.step) === true;
}
type Deps = { turns?: typeof staffRepairTodayTurns; facts?: typeof repairFacts; now?: () => Date };
/** Throws on failure; readTodayTurn maps forbidden to off and anything else to unavailable. */
export async function todayRepairRows(session: Session, deps: Deps = {}): Promise<TodayRepairs> {
  const turns = await (deps.turns ?? staffRepairTodayTurns)(session);
  if (turns.state !== "ready") return turns;
  // P-MNT sees no repair rows on 今天 (MGT-149-AC7); the maintenance projection carries no turn facts.
  if (turns.projection === "maintenance") return { state: "off" };
  const matters = [...turns.mine, ...turns.others];
  if (!matters.every(approvedRepairSentence)) throw new Error("Repair turn has no approved sentence");
  let lookup: Awaited<ReturnType<typeof repairFacts>> = { enhanced: false, facts: {} };
  if (matters.length) {
    try { lookup = await (deps.facts ?? repairFacts)(session, matters.map(m => m.ticketId)); }
    // The gateway admitted these rows; a denial on their presentation lookup is a failure, not an absent source.
    catch (error) { throw error instanceof FlowError && error.key === "errors.forbidden" ? new Error("Repair row facts denied") : error; }
  }
  const { enhanced, facts } = lookup;
  const now = (deps.now ?? (() => new Date()))();
  const row = (m: RepairMatter): TodayRepairRow => {
    const fact = facts[m.ticketId];
    if (!fact) throw new Error("Missing repair row facts");
    return { ...m, title: fact.title, why: repairWhy(m, fact, enhanced), dayNumber: repairDayNumber(m, now) };
  };
  return { state: "ready", counts: turns.counts, yourTurn: turns.yourTurn, mine: turns.mine.map(row), others: turns.others.map(row) };
}
