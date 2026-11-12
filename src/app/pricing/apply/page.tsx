// FILE: src/app/pricing/apply/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requestPrefs } from "@/server/session";
import { pricingInterimCopy } from "@/i18n/pricing-interim";
import { PricingApplyForm } from "@/components/pricing-apply-form";
import { isPricingInterimGloballyEnabled } from "@/server/pricing-interim";

// PLT-30: public B-045 apply route. Per Q-C / C3, there is no "old" public
// apply form — the old paid CTA pointed logged-in staff at /m/settings and
// anonymous visitors at /signup. This page is no longer always-rendered for
// anonymous visitors. Per CEO ruling 2026-11-12 03:45 PST it is now gated on
// the global pricing_interim flag (fail-closed):
//   - Flag OFF (global enabled !== true) => notFound() server-side (a real
//     404, NOT a redirect; submits are gated separately in the action file).
//   - Flag ON (enabled === true) => existing public form, reachable to
//     logged-out visitors who arrive via the 「或聯絡我們申請付費」 link on a
//     flag-ON page. We do not require login.
// C3 public cutover still needs Ron's own-words GO before the prod flag goes ON.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  const copy = pricingInterimCopy(prefs.locale);
  return { title: { absolute: copy.apply.title } };
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function PricingApplyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isPricingInterimGloballyEnabled())) {
    notFound();
  }

  const prefs = await requestPrefs();
  const locale = prefs.locale;
  const copy = pricingInterimCopy(locale);
  const params = await searchParams;
  const done = Boolean(firstParam(params.done));
  const plan = firstParam(params.plan);

  if (done) {
    return (
      <main className="pricing-page interim-root" data-testid="apply-success">
        <h1>{copy.apply.success_title}</h1>
        <p>{copy.apply.success_body}</p>
        <p>{copy.apply.success_note}</p>
        <Link href="/pricing" data-testid="apply-back">
          {copy.apply.back}
        </Link>
      </main>
    );
  }

  return (
    <main className="pricing-page interim-root">
      <h1>{copy.apply.title}</h1>
      <p className="lead" data-testid="apply-lead">
        {copy.apply.lead}
      </p>
      <PricingApplyForm locale={locale} defaultPlan={plan} />
    </main>
  );
}
