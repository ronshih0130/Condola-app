import type { Metadata } from "next";
import Link from "next/link";
import { makeT } from "@/i18n";
import { PricingCalculator } from "@/components/pricing-calculator";
import { appFooterText, footerHasProductLine } from "@/line-copy";
import { showDemoLineCopy } from "@/server/demo";
import { resolveCommercialPrice } from "@/server/billing";
import { loadPriceInputs } from "@/server/partners";
import { countActiveUnits } from "@/server/sandbox";
import { commercialTier, seatUsage } from "@/server/seats";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: { absolute: makeT(prefs.locale)("i_login_title") } };
}

export default async function PricingPage() {
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const session = await readSession();
  const staff = session?.kind === "staff" ? session : null;
  const inputs = staff ? await loadPriceInputs(staff.liveOrgId) : null;
  const units = staff ? await countActiveUnits(staff.liveOrgId) : 30;
  const usage = staff ? await seatUsage(staff.liveOrgId) : null;
  const tierName = staff ? await commercialTier(staff.liveOrgId) : "";
  const current = tierName === "free" || tierName === "standard" || tierName === "pro" ? tierName : null;
  const signedIn = Boolean(staff);
  const demoLine = showDemoLineCopy(staff?.environment ?? null);
  const priceFooter = appFooterText(t("i_price_footer"), demoLine);
  const now = new Date();
  const standardPrice = resolveCommercialPrice({
    tier: "standard",
    now,
    override: inputs?.override,
    snapshot: inputs?.snapshot,
  });
  const proPrice = resolveCommercialPrice({
    tier: "pro",
    now,
    override: inputs?.override,
    snapshot: inputs?.snapshot,
  });
  const standardLabel =
    standardPrice.source === "list"
      ? t("i_price_std_amt")
      : t("i_price_from", { n: standardPrice.freeUnits + 1, price: standardPrice.rate });
  const proLabel =
    proPrice.source === "list" ? t("i_price_pro_amt") : t("i_price_from", { n: proPrice.freeUnits + 1, price: proPrice.rate });
  function cta(plan: "free" | "standard" | "pro") {
    if (current === plan) {
      return (
        <button className="btn" type="button" disabled data-testid={`plan-current-${plan}`}>
          {t("i_price_current")}
        </button>
      );
    }
    if (plan === "free") {
      return signedIn ? null : (
        <Link className="btn" href="/signup">
          {t("i_login_signup")}
        </Link>
      );
    }
    return (
      <Link className="btn pri" href={signedIn ? `/m/upgrade?tier=${plan}` : "/signup"} data-testid={`plan-upgrade-${plan}`}>
        {t("i_price_upgrade")}
      </Link>
    );
  }
  return (
    <main className="pricing-page">
      <h1>{t("i_price_title")}</h1>
      <p className="lead" data-testid="price-headline">{t("i_price_headline")}</p>
      <p data-testid="price-sub">{t("i_price_sub")}</p>
      {usage ? <p data-testid="price-pending">{t("i_price_pending", { n: usage.pending })}</p> : null}
      <div className="price-grid">
        <section className="card pad">
          <h2>{t("i_price_free")}</h2>
          <p className="b">{t("i_price_free_amt")}</p>
          <p>{t("i_price_fit_free")}</p>
          <p>{t("i_price_seat_free")}</p>
          {cta("free")}
        </section>
        <section className="card pad">
          <h2>{t("i_price_standard")}</h2>
          <p className="b" data-testid="plan-price-standard">{standardLabel}</p>
          <p>{t("i_price_fit_std")}</p>
          <p>{t("i_price_trial")}</p>
          <p>{t("i_price_seat_std")}</p>
          {cta("standard")}
        </section>
        <section className="card pad">
          <h2>{t("i_price_pro")}</h2>
          <p className="b" data-testid="plan-price-pro">{proLabel}</p>
          <p>{t("i_price_fit_pro")}</p>
          <p>{t("i_price_trial")}</p>
          <p>{t("i_price_seat_pro")}</p>
          {cta("pro")}
        </section>
      </div>
      <p data-testid="price-receipt">{t("i_price_receipt")}</p>
      <PricingCalculator
        initialUnits={units}
        savedSnapshot={inputs?.snapshot ?? null}
        savedCode={inputs?.code ?? null}
        savedPartner={inputs?.partnerName ?? null}
        lockMonths={inputs?.lockMonths ?? 0}
        override={inputs?.override ?? null}
      />
      <section className="card pad" data-testid="price-faq">
        <h2>{t("i_price_faq")}</h2>
        <details>
          <summary>{t("i_price_q1")}</summary>
          <p>{t("i_price_a1")}</p>
        </details>
        <details>
          <summary>{t("i_price_q2")}</summary>
          <p>{t("i_price_a2")}</p>
        </details>
        <details>
          <summary>{t("i_price_q3")}</summary>
          <p>{t("i_price_a3")}</p>
        </details>
        <details>
          <summary>{t("i_price_q4")}</summary>
          <p>{t("i_price_a4")}</p>
        </details>
        <details>
          <summary>{t("i_price_q5")}</summary>
          <p>{t("i_price_a5")}</p>
        </details>
      </section>
      <p className="small">{t("i_price_open")}</p>
      <p className="foot" data-testid="price-footer" {...(footerHasProductLine(priceFooter) ? { "data-demo-line": "true" } : {})}>
        {priceFooter}
      </p>
    </main>
  );
}
