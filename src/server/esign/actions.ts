"use server";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "../consent-gate";
import { getSession } from "../session";
import { esignEnabled } from "./access";
import { esignFlow, type Command } from "./flow";
import type { Stroke } from "./rules";

function text(form: FormData, key: string) {
  const value = form.get(key);
  if (typeof value !== "string" || value.length > 50000) throw new Error("Invalid field");
  return value;
}
function refresh(leaseId: string) {
  revalidatePath("/m/leases/" + leaseId);
  revalidatePath("/t/lease");
  revalidatePath("/o/leases/" + leaseId + "/esign");
}

export async function actionEsignCreate(form: FormData) {
  await requireCurrentConsent();
  if (!esignEnabled()) notFound();
  const session = await getSession();
  const leaseId = text(form, "leaseId");
  let failed = false;
  try {
    const pdf = form.get("pdf");
    if (!(pdf instanceof File) || pdf.size > 7 * 1024 * 1024) throw new Error("PDF required");
    await esignFlow.execute(session, {
      type: "create", leaseId, pdf: new Uint8Array(await pdf.arrayBuffer()),
      ownerId: text(form, "ownerId"), tenantId: text(form, "tenantId"),
      ownerDocument: form.get("ownerDocument") === "on", tenantDocument: form.get("tenantDocument") === "on",
      order: text(form, "order") as "parallel" | "sequential", deadline: text(form, "deadline"),
    });
    refresh(leaseId);
  } catch { failed = true; }
  if (!/^[0-9a-f-]{36}$/i.test(leaseId)) notFound();
  redirect("/m/leases/" + leaseId + (failed ? "?esignError=1" : ""));
}

export async function actionEsignStep(form: FormData) {
  await requireCurrentConsent();
  if (!esignEnabled()) notFound();
  const session = await getSession();
  let leaseId = "";
  let failed = false;
  try {
    const base = { caseId: text(form, "caseId"), versionId: text(form, "versionId") };
    const type = text(form, "step");
    let command: Command;
    switch (type) {
      case "consent": case "object": case "email": case "review":
        command = { ...base, type }; break;
      case "confirm":
        command = { ...base, type, response: text(form, "response") }; break;
      case "void":
        command = { ...base, type, reason: text(form, "reason") }; break;
      case "replace":
        command = { ...base, type, body: text(form, "body"), deadline: text(form, "deadline") }; break;
      case "document":
        command = { ...base, type, signerId: text(form, "signerId"),
          documentType: text(form, "documentType") as "passport" | "residence_permit" }; break;
      default: throw new Error("Unknown step");
    }
    leaseId = (await esignFlow.execute(session, command)).leaseId;
    refresh(leaseId);
  } catch { failed = true; }
  // Never accept an arbitrary return URL or a caller-supplied lease association.
  const path = session.kind === "staff" ? (leaseId ? "/m/leases/" + leaseId : "/m/leases")
    : session.kind === "owner" ? (leaseId ? "/o/leases/" + leaseId + "/esign" : "/o") : "/t/lease";
  redirect(path + (failed ? "?esignError=1" : ""));
}

export async function actionEsignProgress(leaseId: string) {
  await requireCurrentConsent();
  if (!esignEnabled()) notFound();
  return esignFlow.list(await getSession(), leaseId);
}

export async function actionEsignSign(input: {
  caseId: string; versionId: string; digest: string; strokes: readonly Stroke[];
}) {
  await requireCurrentConsent();
  if (!esignEnabled()) notFound();
  const session = await getSession();
  const h = await headers();
  // Cloudflare overwrites cf-connecting-ip. Local development accepts loopback.
  // Do not trust a client supplied X-Forwarded-For value.
  const ip = h.get("cf-connecting-ip") ??
    (process.env.NODE_ENV !== "production" ? "127.0.0.1" : "");
  const result = await esignFlow.execute(session, {
    type: "sign", caseId: input.caseId, versionId: input.versionId,
    digest: input.digest, strokes: input.strokes, ip, userAgent: h.get("user-agent") ?? "",
  });
  refresh(result.leaseId);
}
