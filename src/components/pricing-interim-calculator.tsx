// FILE: src/components/pricing-interim-calculator.tsx
"use client";
//
// Condola B-045 — Interim pricing calculator (flag-ON /pricing).
// Implements PLT-26-AC2: monthly = max(0, floor(units) − 5) × rate; yearly = monthly × 11.
// Standard NT$39 / Premium("pro") NT$59 display rates. Worked example: 8 units → 117 / 1,287.
// UI-only: no network, no billing.ts, no partner-code (Q-F).

import { useState } from "react";
import { pricingInterimCopy } from "@/i18n/pricing-interim";
import {
  quoteInterim,
  parseInterimUnits,
  formatNtInterim,
  type InterimPaidTier,
} from "@/server/b045-pricing-interim-rules";
import styles from "./pricing-interim.module.css";

type Cycle = "month" | "year";

// calc_result_* already prefixes "NT$", so pass only the grouped number.
function groupedNt(amount: number): string {
  return formatNtInterim(amount).replace(/^NT\$/, "");
}

export function PricingInterimCalculator({ locale }: { locale: string }) {
  const copy = pricingInterimCopy(locale).pricing;

  // Default "8" so the 117 / 1,287 worked example (PLT-26-AC2) is visible.
  const [units, setUnits] = useState("8");
  const [cycle, setCycle] = useState<Cycle>("month");

  const parsed = parseInterimUnits(units);

  const lineFor = (tier: InterimPaidTier) => {
    // parsed.ok is guaranteed by the caller before invoking.
    const value = (parsed as { ok: true; value: number }).value;
    const { monthly, yearly } = quoteInterim(value, tier);
    return {
      n: value,
      month: groupedNt(monthly),
      year: groupedNt(yearly),
    };
  };

  return (
    <div className={`card pad ${styles.usage}`}>
      <h3 className="fg">{copy.calc_title}</h3>

      {/* Billing cycle toggle — both figures always show; the toggle marks intent. */}
      <div className="f" role="group" aria-label={copy.calc_title}>
        <button
          type="button"
          className={`btn sm ${cycle === "month" ? "pri" : ""}`}
          aria-pressed={cycle === "month"}
          onClick={() => setCycle("month")}
        >
          {copy.cycle_month}
        </button>
        <button
          type="button"
          className={`btn sm ${cycle === "year" ? "pri" : ""}`}
          aria-pressed={cycle === "year"}
          onClick={() => setCycle("year")}
        >
          {copy.cycle_year}
        </button>
      </div>

      <div className="fg">
        <label htmlFor="interim-calc-units">{copy.calc_units}</label>
        <input
          id="interim-calc-units"
          className="inp"
          type="text"
          inputMode="numeric"
          value={units}
          data-testid="interim-calc-units"
          onChange={(e) => setUnits(e.target.value)}
        />
      </div>

      {!parsed.ok ? (
        <p className={styles.err} data-testid="interim-calc-err">
          {copy.calc_err}
        </p>
      ) : (
        <>
          {(() => {
            const std = lineFor("standard");
            const pre = lineFor("pro");
            return (
              <>
                <p className="fg" data-testid="interim-calc-std">
                  {copy.calc_result_std(std.n, std.month, std.year)}
                </p>
                <p className="fg" data-testid="interim-calc-pre">
                  {copy.calc_result_pre(pre.n, pre.month, pre.year)}
                </p>
              </>
            );
          })()}
        </>
      )}

      <p className="fg">{copy.calc_note}</p>
    </div>
  );
}
