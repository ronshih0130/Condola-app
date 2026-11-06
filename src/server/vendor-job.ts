import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { recordVendorAppointment, repairApprovalsEnabled, type ApprovalResult } from "./repair-approval";
import { assertVendorResponse, assertCompletion, type VendorResponseTimes } from "./vendor-job-rules";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import { orgVendorDispatchEnabled } from "./vendor-repair";
import { maybe, svc } from "./db";
import { FlowError } from "./errors";
import { assertIdentifiers } from "./repair-approval-rules";

type OpenJob = { job_id: string; org_id: string; ticket_id: string };
type CurrentEvent = "none" | "vendor_proposed" | "company_confirmed"
  | "vendor_rejected" | "vendor_completion_submitted";

export type VendorJobState = {
  orgId: string;
  ticketId: string;
  vendorJobId: string;
  versionId: string;
  dispatchAllowed: boolean;
  locked: boolean;
  currentEvent: CurrentEvent;
  requestId: string;
};

async function openJob(token: string) {
  if (!vendorTokenAcceptable(token)) return null;
  return svc(null, (client) => maybe<OpenJob>(client,
    "SELECT job_id::text, org_id::text, ticket_id::text FROM app.open_vendor_job($1::text)",
    [hashVendorToken(token)],
  ));
}

async function flagsOn(orgId: string) {
  return (await orgVendorDispatchEnabled(orgId)) && (await repairApprovalsEnabled(orgId));
}

async function currentVersionId(client: Client, orgId: string, ticketId: string) {
  assertIdentifiers(orgId, ticketId);
  const row = await maybe<{ version_id: string | null }>(client,
    "SELECT h.current_version_id::text AS version_id"
    + " FROM app.b013_estimate_heads h WHERE h.org_id=$1::uuid AND h.ticket_id=$2::uuid",
    [orgId, ticketId],
  );
  if (row?.version_id) assertIdentifiers(row.version_id);
  return row?.version_id ?? null;
}

async function dispatchOk(client: Client, orgId: string, versionId: string) {
  const row = await maybe<{ r: boolean }>(client,
    "SELECT app.b013_dispatch_allowed($1::uuid,$2::uuid) AS r",
    [orgId, versionId],
  );
  return row?.r === true;
}

async function latestEvent(client: Client, orgId: string, ticketId: string, jobId: string, versionId: string) {
  const row = await maybe<{ event_kind: Exclude<CurrentEvent, "none"> }>(client,
    "SELECT event_kind::text FROM app.b013_repair_appointments"
    + " WHERE org_id=$1::uuid AND ticket_id=$2::uuid AND repair_vendor_job_id=$3::uuid"
    + " AND version_id=$4::uuid"
    + " ORDER BY occurred_at DESC, id DESC LIMIT 1",
    [orgId, ticketId, jobId, versionId],
  );
  return row?.event_kind ?? "none";
}

export async function resolveVendorJobState(token: string): Promise<VendorJobState | null> {
  if (!vendorTokenAcceptable(token)) return null;
  const job = await openJob(token);
  if (!job || !(await flagsOn(job.org_id))) return null;
  return svc(null, async (client) => {
    const versionId = await currentVersionId(client, job.org_id, job.ticket_id);
    if (!versionId) return null;
    const dispatchAllowed = await dispatchOk(client, job.org_id, versionId);
    const currentEvent = await latestEvent(client, job.org_id, job.ticket_id, job.job_id, versionId);
    return {
      orgId: job.org_id, ticketId: job.ticket_id, vendorJobId: job.job_id,
      versionId, dispatchAllowed, locked: !dispatchAllowed, currentEvent,
      requestId: randomUUID(),
    };
  });
}

async function mutationScope(token: string, pinnedVersionId: string, completion = false) {
  const job = await openJob(token);
  if (!job) throw new FlowError("errors.forbidden");
  if (!(await flagsOn(job.org_id))) return null;
  return svc(null, async (client) => {
    const versionId = await currentVersionId(client, job.org_id, job.ticket_id);
    let hasAfterPhoto = false;
    if (completion && versionId === pinnedVersionId) {
      const photos = await maybe<{ n: number }>(client,
        "SELECT count(*)::int AS n FROM ticket_attachments a"
        + " WHERE a.org_id=$1 AND a.ticket_id=$2 AND a.vendor_job_id=$3"
        + " AND NOT a.is_internal",
        [job.org_id, job.ticket_id, job.job_id],
      );
      hasAfterPhoto = (photos?.n ?? 0) > 0;
    }
    return { ...job, versionId, hasAfterPhoto };
  });
}

export async function respondVendorJob(token: string, input: {
  requestId: string;
  versionId: string;
  action: "propose" | "reject" | "accept_confirm";
  times?: VendorResponseTimes;
  reason?: string | null;
}): Promise<ApprovalResult> {
  assertVendorResponse(input);
  assertIdentifiers(input.requestId, input.versionId);
  const scope = await mutationScope(token, input.versionId);
  if (!scope) return { status: "rejected_disabled" };
  if (scope.versionId !== input.versionId) return { status: "rejected_conflict" };
  const proposed = input.action === "propose" ? {
    proposedStart: input.times?.proposedStart,
    proposedEnd: input.times?.proposedEnd,
  } : input.action === "accept_confirm" ? {
    proposedStart: input.times?.confirmedStart,
    proposedEnd: input.times?.confirmedEnd,
  } : {};
  return recordVendorAppointment({ token }, {
    orgId: scope.org_id,
    requestId: input.requestId,
    versionId: input.versionId,
    vendorJobId: scope.job_id,
    eventKind: input.action === "reject" ? "vendor_rejected" : "vendor_proposed",
    ...proposed,
    reason: input.reason,
  });
}

export async function submitVendorCompletion(token: string, input: {
  requestId: string;
  versionId: string;
  reason?: string | null;
}): Promise<ApprovalResult> {
  assertIdentifiers(input.requestId, input.versionId);
  const scope = await mutationScope(token, input.versionId, true);
  if (!scope) return { status: "rejected_disabled" };
  if (scope.versionId !== input.versionId) return { status: "rejected_conflict" };
  assertCompletion({ hasAfterPhoto: scope.hasAfterPhoto, reason: input.reason });
  return recordVendorAppointment({ token }, {
    orgId: scope.org_id,
    requestId: input.requestId,
    versionId: input.versionId,
    vendorJobId: scope.job_id,
    eventKind: "vendor_completion_submitted",
    reason: input.reason,
  });
}
