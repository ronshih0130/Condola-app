"use server";

import { cookies } from "next/headers";
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
import { FlowError } from "./errors";
import { taipeiToday } from "./money";
import { createLeaseFromForm } from "./lease-form";
import { addTicketComment, saveRepairRecord } from "./repairs";
import { getSession } from "./session";
import type { OrgRole } from "./types";

export type ActionState = { error: string; field?: string };

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

function propertyInput(formData: FormData): PropertyInput {
  return {
    name: text(formData.get("name")),
    city: text(formData.get("city")),
    district: text(formData.get("district")),
    street: `${text(formData.get("street")).trim()}${text(formData.get("number")).trim()}`,
    currency: text(formData.get("currency")) === "USD" ? "USD" : "TWD",
    ownerMode: text(formData.get("ownerMode")) || "new",
    ownerName: text(formData.get("ownerName")),
    ownerPhone: text(formData.get("ownerPhone")),
    ownerEmail: text(formData.get("ownerEmail")),
    canViewTenantPhone: formData.get("canViewTenantPhone") === "on",
    unitLabel: text(formData.get("unitLabel")),
    floor: text(formData.get("floor")),
    rentalMode: text(formData.get("rentalMode")) === "whole_unit" ? "whole_unit" : "by_room",
    rooms: Array.from({ length: Math.min(Number(text(formData.get("roomCount"))) || 0, 30) }, (_, index) => ({
      label: text(formData.get(`room${index}label`)),
      roomType: text(formData.get(`room${index}type`)) || "suite",
      baseRentMajor: num(formData.get(`room${index}rent`)) || 0,
    })),
  };
}

function actionError(error: unknown, fallback = "errors.generic"): ActionState {
  if (isRedirect(error)) throw error;
  if (!(error instanceof FlowError)) return { error: fallback };
  const key = error.key === "errors.generic" ? fallback : error.key;
  const field = typeof error.vars?.field === "string" ? error.vars.field : undefined;
  return field ? { error: key, field } : { error: key };
}

export async function actionCreateProperty(prev: ActionState = EMPTY_ACTION, formData: FormData): Promise<ActionState> {
  void prev;
  try {
    const session = await getSession();
    const created = await createProperty(session, propertyInput(formData));
    redirect(`/m/properties/${created.propertyId}`);
  } catch (error) {
    return actionError(error);
  }
}

export async function actionCreateLease(prev: ActionState = EMPTY_ACTION, formData: FormData): Promise<ActionState> {
  void prev;
  try {
    const session = await getSession();
    const created = await createLeaseFromForm(session, formData);
    const jar = await cookies();
    jar.set("condola_tenant_focus", created.tenantUserId, appCookieOptions({ httpOnly: false }));
    redirect(`/m/leases/${created.leaseId}?tab=sign`);
  } catch (error) {
    return actionError(error, "errors.leaseFailed");
  }
}

export async function actionUpdateLease(prev: ActionState = EMPTY_ACTION, formData: FormData): Promise<ActionState> {
  void prev;
  const leaseId = text(formData.get("leaseId"));
  try {
    const session = await getSession();
    await updateLease(session, {
      leaseId,
      rentMajor: optionalNum(formData.get("rent")),
      depositMonths: optionalNum(formData.get("depositMonths")),
      depositReason: text(formData.get("depositReason")),
      updatedAt: text(formData.get("updatedAt")),
    });
    redirect(`/m/leases/${leaseId}`);
  } catch (error) {
    return actionError(error, "errors.leaseFailed");
  }
}

export async function actionSimulateSign(formData: FormData) {
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
  const leaseId = text(formData.get("leaseId"));
  const back = `/m/leases/${leaseId}?tab=sign`;
  try {
    const session = await getSession();
    const file = formData.get("signedPdf");
    if (!(file instanceof File) || file.size === 0) throw new FlowError("errors.pdf");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await uploadSignedLeasePdf(session, leaseId, { bytes, fileName: file.name || "signed.pdf" });
    redirect(`/m/leases/${leaseId}?tab=sign`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionSign(formData: FormData) {
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
    });
    redirect(staff ? `/m/leases/${leaseId}?tab=ledger` : "/t/pay?done=1");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionConfirmPayment(formData: FormData) {
  const id = text(formData.get("paymentId"));
  try {
    const session = await getSession();
    await confirmPayment(session, id);
    redirect("/m/payments");
  } catch (error) {
    bounce("/m/payments", error);
  }
}

export async function actionRejectPayment(formData: FormData) {
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
  try {
    const session = await getSession();
    await importBankCsv(session, text(formData.get("csv")));
    redirect("/m/bank");
  } catch (error) {
    bounce("/m/bank", error);
  }
}

export async function actionApproveMatch(formData: FormData) {
  try {
    const session = await getSession();
    await approveMatch(session, text(formData.get("suggestionId")));
    redirect("/m/bank");
  } catch (error) {
    bounce("/m/bank", error);
  }
}

export async function actionStatement(formData: FormData) {
  try {
    const session = await getSession();
    const result = await generateStatement(session, {
      ownerContactId: text(formData.get("ownerContactId")),
      month: text(formData.get("month")),
    });
    redirect(`/m/statements/${result.statementId}`);
  } catch (error) {
    bounce("/m/statements", error);
  }
}

export async function actionTicket(formData: FormData) {
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

export async function actionTicketComment(formData: FormData) {
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

export async function actionUpdateTicket(formData: FormData) {
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
  try {
    const session = await getSession();
    const role = text(formData.get("role")) as OrgRole;
    const result = await inviteTeammate(session, { email: text(formData.get("email")), role });
    redirect(`/m/team?code=${encodeURIComponent(result.code)}`);
  } catch (error) {
    bounce("/m/team", error);
  }
}

export async function actionSetMeter(formData: FormData) {
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
  const back = "/m/owners/new";
  try {
    const session = await getSession();
    await createOwner(session, {
      name: text(formData.get("name")),
      email: text(formData.get("email")),
      phone: text(formData.get("phone")),
      propertyIds: propertyIds(formData),
    });
    redirect("/m/owners");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUpdateOwner(formData: FormData) {
  const ownerId = text(formData.get("ownerId"));
  const back = `/m/owners/${ownerId}`;
  try {
    const session = await getSession();
    await updateOwner(session, ownerId, {
      name: text(formData.get("name")),
      email: text(formData.get("email")),
      phone: text(formData.get("phone")),
      propertyIds: propertyIds(formData),
    });
    redirect("/m/owners");
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionUpdateProperty(formData: FormData) {
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

export async function actionPickLease(formData: FormData) {
  const leaseId = text(formData.get("leaseId"));
  const jar = await cookies();
  jar.set("condola_lease", leaseId, appCookieOptions({ httpOnly: false }));
  redirect("/t");
}
