import { logServerError } from "./errors";
import { tenantRepairs, ticketDetail } from "./queries";
import { isUuid } from "./repair-rules";
import { ticketPhotoRecovery } from "./upload-recovery";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 3: the read parts of RT-REPAIR (TEN-56-AC4/AC5) and RT-LEASE (TEN-57-AC1).
 * Composes only the readers the tenant pages already call, under the tenant's own RLS; adds no query, no write,
 * no database object. The vendor time question, visit choice and entry authorisation (B-088) and the renewal
 * question (B-089) have no data yet and are not modelled here.
 */

// ---------- RT-REPAIR ----------

/** Where a repair stands, from the existing ticket status only (the same mapping as RT-HOME's cards). */
export type RepairStage = "reported" | "dispatched" | "working" | "done" | "cancelled";
export function repairStage(status: string): RepairStage | null {
  if (status === "open" || status === "triaged") return "reported";
  if (status === "assigned") return "dispatched";
  if (status === "in_progress" || status === "on_hold") return "working";
  if (status === "resolved" || status === "closed") return "done";
  if (status === "cancelled") return "cancelled";
  return null;
}

/** TEN-56-AC4 steps. 約好時間 is left out: no tenant-provable agreed time until B-088. */
export const REPAIR_STEPS = ["reported", "dispatched", "working", "done"] as const;
export type RepairStepId = (typeof REPAIR_STEPS)[number];
export type RepairStep = { id: RepairStepId; state: "done" | "now" | "todo"; current: boolean; date: string | null };

/**
 * Steps up to the current stage are done; the current one is "now" (已完成 is done and current).
 * TEN-56-AC5: 已完成 carries the completion date when the ticket has one. A cancelled repair has no steps.
 */
export function repairSteps(stage: RepairStage, completedOn: string | null): RepairStep[] {
  if (stage === "cancelled") return [];
  const at = REPAIR_STEPS.indexOf(stage);
  return REPAIR_STEPS.map((id, i) => ({
    id,
    state: i < at || (i === at && id === "done") ? "done" : i === at ? "now" : "todo",
    current: i === at,
    date: id === "done" && stage === "done" && completedOn && /^\d{4}-\d{2}-\d{2}$/.test(completedOn) ? completedOn : null,
  }));
}

export type TenantRepairRow = { id: string; number: string; title: string; category: string; stage: RepairStage | null };
type Detail = NonNullable<Awaited<ReturnType<typeof ticketDetail>>>;
export type TenantRepairProgress = {
  id: string; number: string; title: string; description: string | null; category: string; status: string;
  stage: RepairStage; steps: RepairStep[];
};
export type TenantRepairView =
  | { state: "error" }
  | { state: "list"; repairs: TenantRepairRow[] }
  | { state: "progress"; repair: TenantRepairProgress; comments: Detail["comments"]; photos: Detail["photos"];
      uploadRecovery: Awaited<ReturnType<typeof ticketPhotoRecovery>> };

type RepairDeps = { repairs?: typeof tenantRepairs; detail?: typeof ticketDetail; recovery?: typeof ticketPhotoRecovery };

/**
 * `/t/repair` (list) and `/t/repair?id=` (progress). A repair opens only when it is in the tenant's own selected
 * lease's list (the same ownership check as the existing page); anything else shows the list.
 * Costs, vendor names and internal notes are never copied into the view (TEN-56-AC4).
 */
export async function tenantRepairView(session: Session, leaseId: string, selectedId: string | undefined, deps: RepairDeps = {}): Promise<TenantRepairView> {
  const readRepairs = deps.repairs ?? tenantRepairs, readDetail = deps.detail ?? ticketDetail, readRecovery = deps.recovery ?? ticketPhotoRecovery;
  try {
    const rows = await readRepairs(session, leaseId);
    const id = selectedId && isUuid(selectedId) ? selectedId : "";
    const detail = id && rows.some(r => r.id === id) ? await readDetail(session, id) : null;
    const own = detail && rows.some(r => r.id === detail.ticket.id) ? detail : null;
    if (own) {
      const stage = repairStage(own.ticket.status);
      if (!stage) return { state: "error" };
      const t = own.ticket;
      return {
        state: "progress",
        repair: { id: t.id, number: t.number, title: t.title, description: t.description, category: t.category, status: t.status, stage,
          steps: repairSteps(stage, t.completed_on) },
        comments: own.comments.filter(c => !c.internal),
        photos: own.photos.filter(p => !p.internal),
        uploadRecovery: await readRecovery(session, t.id),
      };
    }
    return { state: "list", repairs: rows.map(r => ({ id: r.id, number: r.number, title: r.title, category: r.category, stage: repairStage(r.status) })) };
  } catch (error) {
    logServerError("b090_tenant_repair", error);
    return { state: "error" };
  }
}

// ---------- RT-LEASE ----------

type LeaseMoney = { currency: string; lease: { place: string; start_date: string; end_date: string; rent: string; deposit: string; due_day: number | null } };
export type TenantLeaseTerms = {
  place: string; start: string; end: string; rentMinor: number; depositMinor: number; currency: string; dueDay: number | null;
};

/**
 * TEN-57-AC1 terms, read-only, from the existing tenant lease reader (tenantLeaseMoney): 物件／租期／租金／繳租日／押金.
 * A due day outside 1–31 is left out rather than shown wrong.
 */
export function tenantLeaseTerms(money: LeaseMoney): TenantLeaseTerms {
  const dueDay = Number.isInteger(money.lease.due_day) && Number(money.lease.due_day) >= 1 && Number(money.lease.due_day) <= 31 ? Number(money.lease.due_day) : null;
  return {
    place: money.lease.place, start: money.lease.start_date, end: money.lease.end_date,
    rentMinor: Number(money.lease.rent), depositMinor: Number(money.lease.deposit), currency: money.currency, dueDay,
  };
}
