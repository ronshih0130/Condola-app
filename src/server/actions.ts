"use server";

import { requireCurrentConsent } from "./consent-gate";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { appCookieOptions } from "./public-origin";
import { redirect } from "next/navigation";
import {
  approveMatch,
  confirmPayment,
  createProperty,
  createTicket,
  generateStatement,
  importBankCsv,
  inviteTeammate,
  postMessage,
  recordPayment,
  rejectPayment,
  setMeterSerial,
  setOwnerPhoneVisibility,
  signLease,
  simulateTenantSignature,
  uploadSignedLeasePdf,
  updateLease,
  updateTicket,
  type PropertyInput,
} from "./domain";
import { createOwner, createSpace, updateOwner, updateProperty, updateSpace, type SpaceKind } from "./portfolio";
import { SESSION_COOKIE } from "./auth";
import { FlowError, logServerError } from "./errors";
import { finalizeTenantId, issuePhotoUrlsForToken, reviewIdCheck } from "./id-docs";
import { normalizePhone } from "./lease-rules";
import { typedStreet } from "@/property-address";
import { loadOrgCountry } from "./org-country";
import { createLeaseFromForm } from "./lease-form";
import { addTicketComment, cancelTenantRepair, saveRepairRecord } from "./repairs";
import { addVendor, confirmVendorCost, dispatchVendor, revokeVendorJob, submitVendorReport } from "./vendor-repair";
import { taipeiToday } from "./money";
import { getSession, sessionTokenHash } from "./session";
import { assertTeamInvitesAllowed } from "./team-invites";
import type { OrgRole } from "./types";
import { meterUsageKwh } from "./utility-post";
import { confirmUtilityRun, prepareUtilityRun, voidUtilityRun } from "./utility-posting";

export type ActionState = {
  error: string;
  field?: string;
  step?: number;
  vars?: Record<string, string>;
  propertyId?: string;
  leaseHref?: string;
};

const EMPTY_ACTION: ActionState = { error: "" };

function isRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
  );
}

function bounce(path: string, error: unknown): never {
  if (isRedirect(error)) throw error;
  const key = error instanceof FlowError ? error.key : "errors.generic";
  if (key === "errors.generic") {
    const message = error instanceof Error ? error.message : String(error);
    console.error("action failed:", message);
  }
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("error", key);
  redirect(`${pathname}?${params.toString()}`);
}

function num(value: FormDataEntryValue | null) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

function text(value: FormDataEntryValue | null) {
  return String(value ?? "");
}

function optionalNum(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function propertyIds(formData: FormData) {
  return formData.getAll("propertyId").map((value) => String(value));
}

function spaceInput(formData: FormData) {
  return {
    propertyId: text(formData.get("propertyId")),
    ownerContactId: text(formData.get("ownerContactId")),
    kind: text(formData.get("kind")),
    floor: text(formData.get("floor")),
    roomLabel: text(formData.get("roomLabel")),
    roomType: text(formData.get("roomType")),
    area: optionalNum(formData.get("area")),
    rentMajor: num(formData.get("rent")),
    electricityMethod: text(formData.get("electricityMethod")),
    ratePerKwh: optionalNum(formData.get("ratePerKwh")),
    rateCapReason: text(formData.get("rateCapReason")),
    taipowerKwh: optionalNum(formData.get("taipowerKwh")),
    taipowerAmountMajor: optionalNum(formData.get("taipowerAmount")),
    notes: text(formData.get("notes")),
  };
}

function submittedPhone(formData: FormData, name: string) {
  const raw = text(formData.get(name));
  if (!raw.trim()) return "";
  const calling = text(formData.get(`${name}Country`)) || "+886";
  return normalizePhone(raw, calling) ?? raw;
}

function postedRooms(formData: FormData, prefix: string, count: number) {
  return Array.from({ length: Math.min(count, 30) }, (_, index) => ({
    label: text(formData.get(`${prefix}${index}label`)),
    roomType: text(formData.get(`${prefix}${index}type`)),
    baseRentMajor: num(formData.get(`${prefix}${index}rent`)) || 0,
  }));
}

function propertyInput(formData: FormData): PropertyInput {
  const rawCurrency = text(formData.get("currency"));
  const splitRaw = text(formData.get("electricSplit"));
  const split = splitRaw === "even" || splitRaw === "sub" || splitRaw === "owner" || splitRaw === "reading" || splitRaw === "days" ? splitRaw : "";
  const rateRaw = text(formData.get("electricRate")).trim();
  const roomCount = Number(text(formData.get("roomCount"))) || 0;
  const rooms = postedRooms(formData, "room", roomCount);
  const unitCount = Math.min(Math.max(Number(text(formData.get("unitCount"))) || 1, 1), 20);
  return {
    name: text(formData.get("name")),
    city: text(formData.get("city")),
    district: text(formData.get("district")),
    street: typedStreet(text(formData.get("street")), text(formData.get("number"))),
    currency: rawCurrency === "USD" ? "USD" : "TWD",
    ownerMode: text(formData.get("ownerMode")) || "new",
    ownerName: text(formData.get("ownerName")),
    ownerPhone: submittedPhone(formData, "ownerPhone"),
    ownerEmail: text(formData.get("ownerEmail")),
    canViewTenantPhone: formData.get("canViewTenantPhone") === "on",
    unitLabel: text(formData.get("unitLabel")),
    floor: text(formData.get("floor")),
    doorSupplement: text(formData.get("doorSupplement")),
    rentalMode: text(formData.get("rentalMode")) === "whole_unit" ? "whole_unit" : "by_room",
    rooms,
    extraUnits: Array.from({ length: unitCount - 1 }, (_, index) => {
      const unit = index + 1;
      const count = Number(text(formData.get(`unit${unit}roomCount`))) || 0;
      return {
        label: text(formData.get(`unit${unit}label`)),
        floor: text(formData.get(`unit${unit}floor`)),
        door: text(formData.get(`unit${unit}door`)),
        rooms: postedRooms(formData, `unit${unit}room`, count),
      };
    }),
    electric: split
      ? {
          split,
          rateMajor: rateRaw === "" ? null : num(formData.get("electricRate")),
          openings: rooms.map((_, index) => {
            const raw = text(formData.get(`room${index}opening`)).trim();
            if (!raw) return null;
            const parsed = Number(raw);
            return Number.isFinite(parsed) ? parsed : null;
          }),
        }
      : null,
    submitToken: text(formData.get("submitToken")).trim().slice(0, 80),
  };
}

function actionError(error: unknown, fallback = "errors.generic"): ActionState {
  if (isRedirect(error)) throw error;
  if (!(error instanceof FlowError)) return { error: fallback };
  const key = error.key === "errors.generic" ? fallback : error.key;
  const field = typeof error.vars?.field === "string" ? error.vars.field : undefined;
  const step = typeof error.vars?.step === "number" ? error.vars.step : undefined;
  const vars: Record<string, string> = {};
  if (error.vars) {
    for (const [name, value] of Object.entries(error.vars)) {
      if (name === "field" || name === "step") continue;
      vars[name] = String(value);
    }
  }
  return {
    error: key,
    ...(field ? { field } : {}),
    ...(step != null ? { step } : {}),
    ...(Object.keys(vars).length ? { vars } : {}),
  };
}

export async function actionCreateProperty(prev: ActionState = EMPTY_ACTION, formData: FormData): Promise<ActionState> {
  await requireCurrentConsent();
  void prev;
  try {
    const session = await getSession();
    const input = propertyInput(formData);
    if (!text(formData.get("currency"))) {
      const country = await loadOrgCountry(session.orgId);
      input.currency = country.currency === "USD" ? "USD" : "TWD";
    }
    const created = await createProperty(session, input);
    redirect(`/m/properties/${created.propertyId}?created=1`);
  } catch (error) {
    if (!(error instanceof FlowError) || error.key === "errors.generic") console.error("createProperty", error);
    return actionError(error);
  }
}

export async function actionCreateLease(prev: ActionState = EMPTY_ACTION, formData: FormData): Promise<ActionState> {
  await requireCurrentConsent();
  void prev;
  try {
    const session = await getSession();
    const created = await createLeaseFromForm(session, formData);
    const jar = await cookies();
    jar.set("condola_tenant_focus", created.tenantUserId, appCookieOptions({ httpOnly: false }));
    const notice = new URLSearchParams();
    if (created.utilityKept) notice.set("utility", "kept");
    if (created.billKept) notice.set("bill", "kept");
    const extra = notice.toString();
    revalidatePath("/m/leases");
    revalidatePath(`/m/leases/${created.leaseId}`);
    return { error: "", leaseHref: `/m/leases/${created.leaseId}?created=1${extra ? `&${extra}` : ""}` };
  } catch (error) {
    return actionError(error, "errors.leaseFailed");
  }
}

export async function actionUpdateLease(prev: ActionState = EMPTY_ACTION, formData: FormData): Promise<ActionState> {
  await requireCurrentConsent();
  void prev;
  const leaseId = text(formData.get("leaseId"));
  try {
    const session = await getSession();
    const firstPeriodChoice = formData.get("firstPeriodProrate");
    if (firstPeriodChoice !== null && firstPeriodChoice !== "true" && firstPeriodChoice !== "false") throw new FlowError("errors.required");
    await updateLease(session, {
      leaseId,
      rentMajor: optionalNum(formData.get("rent")),
      depositMonths: optionalNum(formData.get("depositMonths")),
      depositReason: text(formData.get("depositReason")),
      updatedAt: text(formData.get("updatedAt")),
      ...(firstPeriodChoice === null ? {} : { firstPeriodProrate: firstPeriodChoice === "true" }),
    });
    revalidatePath(`/m/leases/${leaseId}`);
    redirect(`/m/leases/${leaseId}?saved=rent`);
  } catch (error) {
    return actionError(error, "errors.leaseFailed");
  }
}

export async function actionSimulateSign(formData: FormData) {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  const back = `/m/leases/${leaseId}?tab=sign`;
  try {
    const session = await getSession();
    const result = await simulateTenantSignature(session, leaseId);
    redirect(result.invoiceId ? `/m/leases/${leaseId}?tab=ledger` : back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUploadSignedPdf(formData: FormData) {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  const back = `/m/leases/${leaseId}?tab=sign`;
  try {
    const session = await getSession();
    const file = formData.get("signedPdf");
    if (!(file instanceof File) || file.size === 0) throw new FlowError("errors.pdf");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await uploadSignedLeasePdf(session, leaseId, {
      bytes,
      fileName: file.name || "signed.pdf",
      replaceReason: formData.get("replaceReason"),
    });
    redirect(`/m/leases/${leaseId}?tab=sign`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionSign(formData: FormData) {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  const back = `/m/leases/${leaseId}?tab=sign`;
  try {
    const session = await getSession();
    const result = await signLease(session, {
      leaseId,
      signedName: text(formData.get("signedName")),
      consent: formData.get("consent") === "on",
    });
    redirect(result.invoiceId ? `/m/leases/${leaseId}?tab=ledger` : `/m/leases/${leaseId}?tab=sign`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionRecordPayment(formData: FormData) {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  const staff = text(formData.get("returnTo")) !== "tenant";
  const back = staff ? `/m/leases/${leaseId}?tab=ledger` : "/t/pay";
  try {
    const session = await getSession();
    await recordPayment(session, {
      leaseId,
      amountMajor: num(formData.get("amount")),
      paidOn: text(formData.get("paidOn")) || taipeiToday(),
      last5: text(formData.get("last5")).trim(),
      reference: text(formData.get("reference")),
      requestId: text(formData.get("requestId")) || undefined,
    });
    redirect(staff ? `/m/leases/${leaseId}?tab=ledger` : "/t/pay?done=1");
  } catch (error) {
    bounce(back, error);
  }
}

import { readProxyOwnerConfirmed } from "./b010-proxy-confirm-rules";

export async function actionConfirmPayment(formData: FormData) {
  await requireCurrentConsent();
  const id = text(formData.get("paymentId"));
  try {
    const session = await getSession();
    await confirmPayment(session, id, {
      proxyOwnerConfirmed: readProxyOwnerConfirmed(formData.get("proxyOwnerConfirmed")),
      source: "staff_ui",
    });
    redirect("/m/payments");
  } catch (error) {
    bounce("/m/payments", error);
  }
}

export async function actionRejectPayment(formData: FormData) {
  await requireCurrentConsent();
  const id = text(formData.get("paymentId"));
  try {
    const session = await getSession();
    await rejectPayment(session, id, text(formData.get("reason")));
    redirect("/m/payments");
  } catch (error) {
    bounce("/m/payments", error);
  }
}

export async function actionImportCsv(formData: FormData) {
  await requireCurrentConsent();
  try {
    const session = await getSession();
    await importBankCsv(session, text(formData.get("csv")));
    redirect("/m/bank");
  } catch (error) {
    bounce("/m/bank", error);
  }
}

export async function actionApproveMatch(formData: FormData) {
  await requireCurrentConsent();
  try {
    const session = await getSession();
    await approveMatch(session, text(formData.get("suggestionId")));
    redirect("/m/bank");
  } catch (error) {
    bounce("/m/bank", error);
  }
}

export async function actionStatement(formData: FormData) {
  await requireCurrentConsent();
  try {
    const session = await getSession();
    const result = await generateStatement(session, {
      ownerContactId: text(formData.get("ownerContactId")),
      month: text(formData.get("month")),
      previewFingerprint: text(formData.get("previewFingerprint")),
    });
    revalidatePath("/m/statements");
    revalidatePath("/m/statements/preview");
    revalidatePath(`/m/statements/${result.statementId}`);
    redirect(`/m/statements/${result.statementId}`);
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.statementPreviewChanged") {
      const params = new URLSearchParams({ owner: text(formData.get("ownerContactId")), month: text(formData.get("month")), changed: "1" });
      redirect(`/m/statements/preview?${params.toString()}`);
    }
    bounce("/m/statements", error);
  }
}

export async function actionTicket(formData: FormData) {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  const back = text(formData.get("returnTo")) === "staff" ? "/m/tickets" : "/t/repair";
  try {
    const session = await getSession();
    const id = await createTicket(session, {
      leaseId,
      category: text(formData.get("category")) || "other",
      title: text(formData.get("title")),
      description: text(formData.get("description")),
      priority: text(formData.get("priority")) || "normal",
    });
    redirect(back === "/m/tickets" ? `/m/tickets/${id}` : `/t/repair?done=1&id=${id}`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionSaveRepair(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = `/m/tickets/${ticketId}`;
  try {
    const session = await getSession();
    await saveRepairRecord(session, ticketId, {
      status: text(formData.get("status")),
      note: text(formData.get("note")),
      internal: formData.get("internal") === "on",
      vendorName: text(formData.get("vendorName")),
      estimated: text(formData.get("estimated")),
      finalCost: text(formData.get("finalCost")),
      costBearer: text(formData.get("costBearer")) || "undecided",
      scheduledOn: text(formData.get("scheduledOn")),
      completedOn: text(formData.get("completedOn")),
      postExpense: formData.get("postExpense") === "on",
    });
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionCancelRepair(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = `/t/repair?id=${ticketId}`;
  try {
    const session = await getSession();
    await cancelTenantRepair(session, ticketId);
    redirect(`${back}&cancelled=1`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionTicketComment(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = text(formData.get("returnTo")) === "tenant" ? `/t/repair?id=${ticketId}` : `/m/tickets/${ticketId}`;
  try {
    const session = await getSession();
    await addTicketComment(session, ticketId, text(formData.get("body")), formData.get("internal") === "on");
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

async function requestOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

export async function actionAddVendor(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = `/m/tickets/${ticketId}`;
  try {
    const session = await getSession();
    const vendorId = await addVendor(session, ticketId, {
      name: text(formData.get("vendorName")),
      phone: text(formData.get("vendorPhone")),
      trade: text(formData.get("vendorTrade")),
    });
    redirect(`${back}?vendor=${vendorId}`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionDispatchVendor(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = `/m/tickets/${ticketId}`;
  try {
    const session = await getSession();
    await dispatchVendor(
      session,
      ticketId,
      {
        vendorId: text(formData.get("vendorId")),
        vendorName: text(formData.get("vendorName")),
        vendorPhone: text(formData.get("vendorPhone")),
        vendorTrade: text(formData.get("vendorTrade")),
        contactWindow: text(formData.get("contactWindow")),
      },
      await requestOrigin(),
    );
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionRevokeVendor(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = `/m/tickets/${ticketId}`;
  try {
    const session = await getSession();
    await revokeVendorJob(session, ticketId, text(formData.get("jobId")));
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionConfirmVendor(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = text(formData.get("ticketId"));
  const back = `/m/tickets/${ticketId}`;
  try {
    const session = await getSession();
    await confirmVendorCost(session, ticketId, text(formData.get("jobId")));
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionVendorReport(formData: FormData) {
  const token = text(formData.get("token")).trim();
  const back = `/v/${encodeURIComponent(token)}`;
  try {
    await submitVendorReport(token, { done: formData.get("done") === "on", cost: text(formData.get("cost")) });
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUpdateTicket(formData: FormData) {
  await requireCurrentConsent();
  try {
    const session = await getSession();
    await updateTicket(session, text(formData.get("ticketId")), {
      status: text(formData.get("status")) || undefined,
      note: text(formData.get("note")),
    });
    redirect("/m/tickets");
  } catch (error) {
    bounce("/m/tickets", error);
  }
}

export async function actionMessage(formData: FormData) {
  await requireCurrentConsent();
  const threadId = text(formData.get("threadId"));
  const back = text(formData.get("returnTo")) === "tenant" ? "/t/messages" : `/m/messages/${threadId}`;
  try {
    const session = await getSession();
    await postMessage(session, threadId, text(formData.get("body")));
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionInvite(formData: FormData) {
  await requireCurrentConsent();
  try {
    const session = await getSession();
    assertTeamInvitesAllowed(session.orgId);
    const role = text(formData.get("role")) as OrgRole;
    const result = await inviteTeammate(session, { email: text(formData.get("email")), role });
    redirect(`/m/team?code=${encodeURIComponent(result.code)}`);
  } catch (error) {
    bounce("/m/team", error);
  }
}

export async function actionSetMeter(formData: FormData) {
  await requireCurrentConsent();
  const propertyId = text(formData.get("propertyId"));
  const back = `/m/properties/${propertyId}`;
  try {
    const session = await getSession();
    await setMeterSerial(session, propertyId, text(formData.get("serial")));
    redirect(back);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionPhoneVisibility(formData: FormData) {
  await requireCurrentConsent();
  const propertyId = text(formData.get("propertyId"));
  try {
    const session = await getSession();
    await setOwnerPhoneVisibility(session, text(formData.get("propertyOwnerId")), formData.get("canView") === "on");
    redirect(`/m/properties/${propertyId}`);
  } catch (error) {
    bounce(`/m/properties/${propertyId}`, error);
  }
}

export async function actionCreateOwner(formData: FormData) {
  await requireCurrentConsent();
  const back = "/m/owners/new";
  try {
    const session = await getSession();
    await createOwner(session, {
      name: text(formData.get("name")),
      email: text(formData.get("email")),
      phone: submittedPhone(formData, "phone"),
      propertyIds: propertyIds(formData),
    });
    redirect("/m/owners");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUpdateOwner(formData: FormData) {
  await requireCurrentConsent();
  const ownerId = text(formData.get("ownerId"));
  const back = `/m/owners/${ownerId}`;
  try {
    const session = await getSession();
    await updateOwner(session, ownerId, {
      name: text(formData.get("name")),
      email: text(formData.get("email")),
      phone: submittedPhone(formData, "phone"),
      propertyIds: propertyIds(formData),
    });
    redirect("/m/owners");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUpdateProperty(formData: FormData) {
  await requireCurrentConsent();
  const propertyId = text(formData.get("propertyId"));
  const back = `/m/properties/${propertyId}/edit`;
  try {
    const session = await getSession();
    await updateProperty(session, propertyId, {
      name: text(formData.get("name")),
      city: text(formData.get("city")),
      district: text(formData.get("district")),
      street: text(formData.get("street")),
      ownerContactId: text(formData.get("ownerContactId")),
      electricity: {
        serial: text(formData.get("meterSerial")),
        split: text(formData.get("split")),
        bill: text(formData.get("bill")),
        usage: text(formData.get("usage")),
        rate: text(formData.get("rate")),
      },
    });
    redirect(`/m/properties/${propertyId}`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionCreateSpace(formData: FormData) {
  await requireCurrentConsent();
  const back = "/m/units/new";
  try {
    const session = await getSession();
    await createSpace(session, spaceInput(formData));
    redirect("/m/units");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUpdateSpace(formData: FormData) {
  await requireCurrentConsent();
  const kind = text(formData.get("kind")) === "whole_unit" ? "whole_unit" : "room";
  const spaceId = text(formData.get("spaceId"));
  const back = kind === "whole_unit" ? `/m/units/whole/${spaceId}` : `/m/units/room/${spaceId}`;
  try {
    const session = await getSession();
    await updateSpace(session, kind satisfies SpaceKind, spaceId, spaceInput(formData));
    redirect("/m/units");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionFinalizeId(formData: FormData): Promise<{ error: string } | void> {
  await requireCurrentConsent();
  try {
    const session = await getSession();
    await finalizeTenantId(session, {
      leaseId: text(formData.get("leaseId")),
      docType: text(formData.get("docType")),
      number: text(formData.get("number")),
      consent: text(formData.get("consent")) === "on",
    });
    redirect("/t/id?sent=1");
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (!(error instanceof FlowError) || error.key === "errors.generic") logServerError("actionFinalizeId", error);
    return { error: error instanceof FlowError ? error.key : "errors.generic" };
  }
}

export async function actionViewIdPhotos(documentId: string) {
  await requireCurrentConsent();
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) redirect("/login");
    const session = await getSession();
    return await issuePhotoUrlsForToken(
      {
        tokenHash: sessionTokenHash(token),
        userId: session.userId,
        preferredOrg: session.liveOrgId,
        env: session.environment,
      },
      documentId,
    );
  } catch (error) {
    if (isRedirect(error)) throw error;
    return { error: error instanceof FlowError ? error.key : "errors.generic" };
  }
}

export async function actionMarkIdChecked(formData: FormData): Promise<{ error: string } | void> {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  try {
    const session = await getSession();
    await reviewIdCheck(session, text(formData.get("documentId")), "checked");
    revalidatePath(`/m/leases/${leaseId}`);
  } catch (error) {
    if (isRedirect(error)) throw error;
    return { error: error instanceof FlowError ? error.key : "errors.generic" };
  }
}

export async function actionReturnId(formData: FormData): Promise<{ error: string } | void> {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  try {
    const session = await getSession();
    await reviewIdCheck(session, text(formData.get("documentId")), "returned", text(formData.get("reason")));
    revalidatePath(`/m/leases/${leaseId}`);
  } catch (error) {
    if (isRedirect(error)) throw error;
    return { error: error instanceof FlowError ? error.key : "errors.generic" };
  }
}

function fieldAt(formData: FormData, name: string, index: number) {
  const value = formData.getAll(name)[index];
  return typeof value === "string" ? value : null;
}

function utilityInput(formData: FormData) {
  const spaceIds = formData.getAll("spaceId").map((value) => String(value));
  const total = optionalNum(formData.get("totalKwh"));
  const bill = optionalNum(formData.get("billTotal"));
  return {
    unitId: text(formData.get("unitId")),
    sourceRunId: text(formData.get("sourceRunId")) || undefined,
    periodStart: text(formData.get("periodStart")),
    periodEnd: text(formData.get("periodEnd")),
    rateMajor: num(formData.get("rate")),
    totalKwh: total,
    billTotalMajor: bill,
    overrideReason: text(formData.get("overrideReason")),
    readings: spaceIds.map((spaceId, index) => {
      const previousText = String(fieldAt(formData, "prevKwh", index) ?? "").trim();
      const currentText = String(fieldAt(formData, "currKwh", index) ?? "").trim();
      const hasEnds = previousText !== "" || currentText !== "";
      const previousKwh = optionalNum(fieldAt(formData, "prevKwh", index));
      const currentKwh = optionalNum(fieldAt(formData, "currKwh", index));
      const direct = optionalNum(fieldAt(formData, "kwh", index));
      return {
        spaceId,
        kwh: hasEnds ? meterUsageKwh(previousKwh ?? Number.NaN, currentKwh ?? Number.NaN) : (direct ?? Number.NaN),
        previousKwh: hasEnds ? previousKwh : null,
        currentKwh: hasEnds ? currentKwh : null,
      };
    }),
  };
}

function utilityBack(formData: FormData) {
  const params = new URLSearchParams();
  const unitId = text(formData.get("unitId"));
  const month = text(formData.get("periodStart")).slice(0, 7);
  if (unitId) params.set("unit", unitId);
  const sourceRunId = text(formData.get("sourceRunId"));
  if (sourceRunId) { params.set("run", sourceRunId); if (unitId) params.set("historyUnit", unitId); }
  if (/^\d{4}-\d{2}$/.test(month)) params.set("month", month);
  const bill = text(formData.get("billTotal")).trim().slice(0, 16);
  const kwh = text(formData.get("totalKwh")).trim().slice(0, 16);
  if (bill) params.set("bill", bill);
  if (kwh) params.set("kwh", kwh);
  const query = params.toString();
  return query ? `/m/rent/utilities?${query}` : "/m/rent/utilities";
}

export async function actionPrepareUtility(formData: FormData) {
  await requireCurrentConsent();
  const unitId = text(formData.get("unitId"));
  const month = text(formData.get("periodStart")).slice(0, 7);
  const back = utilityBack(formData);
  try {
    const session = await getSession();
    const result = await prepareUtilityRun(session, utilityInput(formData));
    redirect(`/m/rent/utilities?run=${result.runId}&unit=${encodeURIComponent(unitId)}&month=${encodeURIComponent(month)}`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionConfirmUtility(formData: FormData) {
  await requireCurrentConsent();
  const runId = text(formData.get("runId"));
  const month = text(formData.get("month"));
  const unitId = text(formData.get("unitId"));
  const next = new URLSearchParams({ run: runId });
  if (/^\d{4}-\d{2}$/.test(month)) next.set("month", month);
  if (unitId) next.set("unit", unitId);
  try {
    const session = await getSession();
    await confirmUtilityRun(session, runId);
    revalidatePath("/m/rent/utilities");
    revalidatePath("/m/expenses");
    revalidatePath("/m/statements");
    next.set("saved", "posted");
    redirect(`/m/rent/utilities?${next.toString()}`);
  } catch (error) {
    bounce(`/m/rent/utilities?${next.toString()}`, error);
  }
}

export async function actionVoidUtility(formData: FormData) {
  await requireCurrentConsent();
  const runId = text(formData.get("runId"));
  try {
    const session = await getSession();
    await voidUtilityRun(session, runId, text(formData.get("reason")));
    redirect(`/m/rent/utilities?run=${runId}&saved=void`);
  } catch (error) {
    bounce(`/m/rent/utilities?run=${runId}`, error);
  }
}

export async function actionPickLease(formData: FormData) {
  await requireCurrentConsent();
  const leaseId = text(formData.get("leaseId"));
  const jar = await cookies();
  jar.set("condola_lease", leaseId, appCookieOptions({ httpOnly: false }));
  redirect("/t");
}
