"use client";

import { useState } from "react";
import { formatNt, quoteMonthly, type PaidTier, type PriceOverride, type PriceSnapshot } from "@/server/billing";
import { actionPreviewCode } from "@/server/signup-actions";
import { useT } from "./locale";

export function PricingCalculator({
  initialUnits,
  savedSnapshot,
  savedCode,
  savedPartner,
  lockMonths,
  override,
}: {
  initialUnits: number;
  savedSnapshot: PriceSnapshot | null;
  savedCode: string | null;
  savedPartner: string | null;
  lockMonths: number;
  override: PriceOverride | null;
}) {
  const t = useT();
  const [units, setUnits] = useState(initialUnits);
  const [tier, setTier] = useState<PaidTier>("standard");
  const [cycle, setCycle] = useState<"month" | "year">("month");
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<PriceSnapshot | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [previewLock, setPreviewLock] = useState(0);
  const [note, setNote] = useState("");
  const [bad, setBad] = useState(false);
  const snapshot = preview ?? savedSnapshot;
  const quote = quoteMonthly({
    units,
    tier,
    cycle,
    now: new Date(),
    override,
    snapshot,
  });
  const appliedName = preview ? previewName : savedPartner;
  const appliedLock = preview ? previewLock : lockMonths;
  const years = appliedLock > 0 && appliedLock % 12 === 0 ? appliedLock / 12 : null;
  return (
    <div className="card pad pricing-calc" data-testid="price-calc">
      <h2>{t("i_price_calc")}</h2>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className={`btn sm${cycle === "month" ? " pri" : ""}`} type="button" data-testid="cycle-month" onClick={() => setCycle("month")}>
          {t("i_price_cycle_m")}
        </button>
        <button className={`btn sm${cycle === "year" ? " pri" : ""}`} type="button" data-testid="cycle-year" onClick={() => setCycle("year")}>
          {t("i_price_cycle_y")}
        </button>
        <button className={`btn sm${tier === "standard" ? " pri" : ""}`} type="button" data-testid="calc-standard" onClick={() => setTier("standard")}>
          Standard
        </button>
        <button className={`btn sm${tier === "pro" ? " pri" : ""}`} type="button" data-testid="calc-pro" onClick={() => setTier("pro")}>
          Pro
        </button>
      </div>
      <div className="fg">
        <label className="f">{t("i_price_units")}</label>
        <input
          className="inp"
          type="number"
          min={0}
          value={units}
          data-testid="calc-units"
          onChange={(event) => setUnits(Math.max(0, Number(event.target.value) || 0))}
        />
      </div>
      <p data-testid="price-result">
        {t("i_price_you", {
          n: units,
          money: formatNt(quote.monthly),
          N: units,
          "金額": formatNt(quote.monthly).replace(/^NT\$/, ""),
        })}
      </p>
      {cycle === "year" ? (
        <p data-testid="price-year">
          {t("i_price_year", {
            money: formatNt(quote.yearly),
            N: units,
            "金額": formatNt(quote.yearly).replace(/^NT\$/, ""),
          })}
        </p>
      ) : null}
      <p className="small muted" data-testid="price-note">{t("i_price_note")}</p>
      {override ? <p className="small" data-testid="price-override">{t("i_price_override", { price: override.rate })}</p> : null}
      {savedCode && !override ? (
        <p className="small" data-testid="price-saved-code">
          {years == null
            ? t("i_code_months", { n: appliedLock, name: appliedName || savedCode, price: quote.rate })
            : t("i_signup_code_ok", { name: appliedName || savedCode, price: quote.rate, years })}
        </p>
      ) : null}
      {savedCode ? null : (
        <div className="fg">
          <label className="f">{t("i_price_partner")}</label>
          <input className="inp" value={code} data-testid="calc-code" onChange={(event) => setCode(event.target.value)} />
          <button
            className="btn sm"
            type="button"
            data-testid="calc-code-apply"
            onClick={async () => {
              const result = await actionPreviewCode(code);
              if (result.state === "valid") {
                setPreview({
                  standardPrice: result.standardPrice,
                  proPrice: result.proPrice,
                  freeUnits: result.freeUnits,
                  lockedUntil: null,
                });
                setPreviewName(result.partnerName);
                setPreviewLock(result.lockMonths);
                setBad(false);
                const lockYears = result.lockMonths % 12 === 0 ? result.lockMonths / 12 : null;
                setNote(
                  lockYears == null
                    ? t("i_code_months", { n: result.lockMonths, name: result.partnerName, price: tier === "pro" ? result.proPrice : result.standardPrice })
                    : t("i_signup_code_ok", {
                        name: result.partnerName,
                        price: tier === "pro" ? result.proPrice : result.standardPrice,
                        years: lockYears,
                      }),
                );
                return;
              }
              setPreview(null);
              if (result.state === "empty") {
                setBad(false);
                setNote("");
                return;
              }
              setBad(true);
              setNote(t("i_signup_code_bad"));
            }}
          >
            {t("i_signup_code_apply")}
          </button>
          {note ? (
            <p className="small" data-testid="calc-code-note" data-valid={bad ? "false" : "true"}>
              {note}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
