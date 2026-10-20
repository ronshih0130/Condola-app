"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  approveMatch,
  confirmPayment,
  createLease,
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
  updateTicket,
  type LeaseInput,
  type PropertyInput,
} from "./domain";
import { createOwner, createSpace, updateOwner, updateProperty, updateSpace, type SpaceKind } from "./portfolio";
import { FlowError } from "./errors";
import { addCalendarMonths, monthBounds, taipeiToday } from "./money";
import { getSession } from "./session";
import type { OrgRole } from "./types";

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

export async function actionCreateProperty(formData: FormData) {
  const back = "/m/properties/new";
  try {
    const session = await getSession();
    const input: PropertyInput = {
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
      rooms: [0, 1, 2].map((index) => ({
        label: text(formData.get(`room${index}label`)),
        roomType: text(formData.get(`room${index}type`)) || "suite",
        baseRentMajor: num(formData.get(`room${index}rent`)) || 0,
      })),
    };
    const created = await createProperty(session, input);
    redirect(`/m/properties/${created.propertyId}`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionCreateLease(formData: FormData) {
  const back = "/m/leases/new";
  try {
    const session = await getSession();
    const start = text(formData.get("startDate")).trim() || taipeiToday();
    const months = num(formData.get("months"));
    const end = addCalendarMonths(start, Number.isFinite(months) && months > 0 ? months : 12);
    const bounds = monthBounds(/^\d{4}-\d{2}/.test(start) ? start.slice(0, 7) : taipeiToday().slice(0, 7));
    const input: LeaseInput = {
      roomId: text(formData.get("roomId")),
      tenantName: text(formData.get("tenantName")),
      tenantPhone: text(formData.get("tenantPhone")),
      tenantEmail: text(formData.get("tenantEmail")),
      lineUserId: text(formData.get("lineUserId")),
      startDate: start,
      endDate: end,
      rentMajor: num(formData.get("rent")),
      depositMonths: num(formData.get("depositMonths")),
      depositReason: text(formData.get("depositReason")),
      dueDay: num(formData.get("dueDay")),
      splitMethod: (["even", "days_occupied", "sub_meter"].includes(text(formData.get("splitMethod")))
        ? text(formData.get("splitMethod"))
        : "even") as LeaseInput["splitMethod"],
      periodStart: bounds.start,
      periodEnd: bounds.end,
      billTotalMajor: num(formData.get("billTotal")),
      usageKwh: num(formData.get("usage")),
      rateMajor: num(formData.get("rate")),
      rateSource: "fixed_rate",
      overrideReason: text(formData.get("overrideReason")),
      subUsages: [],
    };
    const created = await createLease(session, input);
    const jar = await cookies();
    jar.set("condola_tenant_focus", created.tenantUserId, { path: "/", sameSite: "lax" });
    redirect(`/m/leases/${created.leaseId}?tab=sign`);
  } catch (error) {
    bounce(back, error);
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
    await createTicket(session, {
      leaseId,
      category: text(formData.get("category")) || "other",
      title: text(formData.get("title")),
      description: text(formData.get("description")),
      priority: text(formData.get("priority")) || "normal",
    });
    redirect(back === "/m/tickets" ? "/m/tickets" : "/t/repair?done=1");
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
  jar.set("condola_lease", leaseId, { path: "/", sameSite: "lax" });
  redirect("/t");
}
