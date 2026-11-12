// FILE: src/server/pricing-apply-actions.ts
"use server";

// B-045 (pricing_interim) / PLT-30 apply queue + C2 management handoff.
// 0 real outbound: this file imports NO mail / notification / SMS / LINE /
// transport, and never writes upgrade_requests. Submissions only land in the
// app.*_pricing_apply SQL functions; a human in /m/admin follows up.

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { isPricingPaidReceivedDate, validateApplyInput } from "./b045-pricing-interim-rules";
import { query } from "./db";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { isPricingInterimGloballyEnabled } from "@/server/pricing-interim";
import { requireCurrentConsent } from "./consent-gate";
import { getSession, readSession } from "./session";
import { isPlatformAdmin } from "./platform";

export type ApplyActionState = {
  ok: false;
  errors: { companyName?: true; phone?: true; units?: true };
  first: "companyName" | "phone" | "units";
};

// PLT-30 applicants self-identify; the queue is for management applicants, so a
// staff (platform-side) session carries its liveOrgId while tenant/owner
// sessions still record userId but leave org_id null.
function staffOrgId(session: Awaited<ReturnType<typeof readSession>>): string | null {
  if (session && session.kind === "staff") {
    return session.liveOrgId ?? null;
  }
  return null;
}

/**
 * PLT-30-AC2 submit action, useActionState-compatible.
 *
 * Gated on the pricing_interim global flag:
 *   - flag OFF => notFound() at the very start, before any validation/query:
 *     no insert and no redirect to ?done=1, even for an anonymous, otherwise
 *     valid form. Anonymous submits are allowed ONLY when the global flag is on.
 *   - flag ON  => unchanged behavior: validateApplyInput, optional session (no
 *     login required), staffOrgId, app.submit_pricing_apply, then
 *     redirect("/pricing/apply?done=1").
 *
 * Validation failures return focus state (no insert); success redirect()s and
 * therefore never returns. Never sends email/SMS/LINE.
 *
 * C3 public cutover still needs Ron's own-words GO before the prod flag-ON.
 */
export async function actionSubmitPricingApply(
  _prev: ApplyActionState | null,
  form: FormData,
): Promise<ApplyActionState> {
  return runSubmitPricingApply(form, {
    isEnabled: isPricingInterimGloballyEnabled,
    readSession,
    query,
  });
}

/**
 * Testable core of actionSubmitPricingApply with its collaborators injected so
 * the flag gate and the ON path can be unit-tested without module mocks.
 */
export async function runSubmitPricingApply(
  form: FormData,
  deps: {
    isEnabled: () => Promise<boolean>;
    readSession: () => ReturnType<typeof readSession>;
    query: typeof query;
  },
): Promise<ApplyActionState> {
  // Flag OFF: reject server-side before any validation/query/redirect.
  if (!(await deps.isEnabled())) {
    notFound();
  }

  const parsed = validateApplyInput({
    companyName: String(form.get("companyName") ?? ""),
    phone: String(form.get("phone") ?? ""),
    units: String(form.get("units") ?? ""),
    plan: form.get("plan") === null ? null : String(form.get("plan")),
    note: form.get("note") === null ? null : String(form.get("note")),
  });

  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors, first: parsed.first };
  }

  // Optional session: do not require login for the public apply form.
  const session = await deps.readSession();
  const orgId = staffOrgId(session);
  const userId = session?.userId ?? null;

  const { companyName, phone, units, plan, note } = parsed.value;

  // Insert ONLY through the SQL entry point; let SQL errors propagate (Next
  // renders the error boundary) rather than leaking details into state.
  await deps.query(
    `SELECT app.submit_pricing_apply($1,$2,$3,$4,$5,$6,$7) AS id`,
    [orgId, userId, companyName, phone, units, plan, note],
  );

  redirect("/pricing/apply?done=1");
}

export type PricingApplyRequest = {
  id: string;
  org_id: string | null;
  user_id: string | null;
  company_name: string;
  phone: string;
  units: number;
  plan: "standard" | "pro" | "unsure" | null;
  note: string | null;
  status: string;
  paid_received_on: string | null;
  paid_received_set_at: string | null;
  paid_received_set_by: string | null;
  created_at: string;
};

/**
 * C2 admin listing. Platform-admin gate: login required, then
 * isPlatformAdmin(email) or notFound() — the queue stays invisible otherwise.
 */
export async function listPricingApplyRequests(): Promise<PricingApplyRequest[]> {
  await requireCurrentConsent();
  const session = await getSession();
  // Admin gate.
  if (!session || !isPlatformAdmin(session.email)) {
    notFound();
  }
  await guardEffectiveSession(session, null);

  const result = await query<PricingApplyRequest>(
    `SELECT * FROM app.list_pricing_apply_requests()`,
  );
  return result.rows;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;


/**
 * C2 admin action: record (or clear) the date interim payment was received.
 * Platform-admin gate as above. No notifications are sent — this only stamps
 * the row for the human-driven management handoff.
 * Returns void so it can be used as a <form action>. Invalid input redirects
 * to /m/admin?error=invalid.
 */
export async function actionSetPricingApplyPaidReceived(form: FormData): Promise<void> {
  await requireCurrentConsent();
  const session = await getSession();
  // Admin gate.
  if (!session || !isPlatformAdmin(session.email)) {
    notFound();
  }
  await guardEffectiveSession(session, null);

  const id = String(form.get("id") ?? "").trim();
  const paidReceivedOn = String(form.get("paidReceivedOn") ?? "").trim();

  if (!UUID_RE.test(id) || (paidReceivedOn !== "" && !DATE_RE.test(paidReceivedOn))) {
    redirect("/m/admin?error=invalid");
  }

  // Reject impossible calendar dates (e.g. 2026-02-31) before they reach SQL.
  // Empty still means "clear the date" and is handled below.
  if (paidReceivedOn !== "" && !isPricingPaidReceivedDate(paidReceivedOn)) {
    redirect("/m/admin?error=invalid");
  }

  const date = paidReceivedOn === "" ? null : paidReceivedOn;

  await query(
    `SELECT app.set_pricing_apply_paid_received($1,$2,$3)`,
    [id, date, session.userId],
  );

  revalidatePath("/m/admin");
  redirect("/m/admin?saved=1");
}
