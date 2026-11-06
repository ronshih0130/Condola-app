import { computeOwnerNet, reconcileSnapshot } from "./owner-net-ledger-rules";
import type { ownerNetLedgerView } from "./owner-net-ledger";

type Ledger = NonNullable<Awaited<ReturnType<typeof ownerNetLedgerView>>>;
export type LedgerPanelLine = { key: string; amount: string; affectsBalance: boolean };
export type LedgerBreakdown = { lines: LedgerPanelLine[]; net: string; negative: boolean; reconciles: boolean; hasDirectRent: boolean };
export type LedgerPanelView = {
  statementId: string;
  latest: (LedgerBreakdown & { versionNo: number }) | null;
  versions: Array<{ id: string | null; versionNo: number; createdAt: string; actor: string | null; reason: string | null; breakdown: LedgerBreakdown | null }>;
  latestVersionId: string | null;
  canRecord: boolean;
  deliveries: Array<{ id: string; versionNo: number; result: string; createdAt: string }> | null;
};

/** Integer minor units → grouped major-unit text. BigInt only; never Number. */
export function formatLedgerMinor(value: bigint, currency: string, minorUnit: number, locale: string): string {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) throw new TypeError("Invalid minor unit");
  const negative = value < BigInt(0), digits = (negative ? -value : value).toString().padStart(minorUnit + 1, "0");
  const whole = minorUnit ? digits.slice(0, -minorUnit) : digits, fraction = minorUnit ? digits.slice(-minorUnit) : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const code = currency.trim().toUpperCase();
  const body = code === "TWD" && (!fraction || /^0+$/.test(fraction)) ? `NT$${grouped}` : `${code} ${grouped}${fraction ? `.${fraction}` : ""}`;
  void locale;
  return negative ? `−${body}` : body;
}

/** Original statement row = version 1; later versions come from the B-014 history. */
export function ledgerPanelView(ledger: Ledger, input: { statementId: string; locale: string }): LedgerPanelView {
  const fmt = (v: bigint) => formatLedgerMinor(v, ledger.currency, ledger.minorUnit, input.locale);
  const original = ledger.original;
  const breakdown = (snapshot: unknown): LedgerBreakdown | null => {
    if (!reconcileSnapshot(snapshot)) return null;
    const s = snapshot as Record<string, string>, n = (k: string) => BigInt(s[k]);
    const result = computeOwnerNet({
      opening: n("opening_minor"), companyRent: n("company_rent_minor"), directRent: n("direct_rent_minor"),
      otherIncome: n("other_income_minor"), managementFee: n("management_fee_minor"), expenses: n("expenses_minor"),
      payouts: n("payouts_minor"), prepayDraws: n("prepay_draws_minor"),
    });
    return {
      lines: result.lines.map((l) => ({ key: l.key, amount: fmt(l.amountMinor), affectsBalance: l.affectsBalance })),
      // 「本期淨額為負」 describes the period net, not the closing balance.
      net: fmt(result.net), negative: result.net < BigInt(0), reconciles: result.closing === n("closing_minor"),
      hasDirectRent: n("direct_rent_minor") !== BigInt(0),
    };
  };
  // Display names only; a missing name falls back to the panel's 「管理方」 label, never a UUID.
  const actorLabel = (name: string | null) => name;
  const latestBreakdown = ledger.latest ? breakdown(ledger.latest.snapshot) : null;
  const byId = new Map(ledger.versions.map((v) => [v.id, v.version_no]));
  return {
    statementId: input.statementId,
    latest: ledger.latest && latestBreakdown ? { ...latestBreakdown, versionNo: ledger.latest.version_no } : null,
    latestVersionId: ledger.latest?.id ?? null,
    versions: [
      { id: null, versionNo: 1, createdAt: original.issuedAt ?? "—", actor: original.issuedBy, reason: null, breakdown: null },
      ...[...ledger.versions].sort((a, b) => a.version_no - b.version_no).map((v) => ({
        id: v.id, versionNo: v.version_no, createdAt: v.created_at, actor: actorLabel(v.actor_name), reason: v.reason, breakdown: breakdown(v.snapshot),
      })),
    ],
    canRecord: ledger.canRecord,
    deliveries: ledger.deliveries?.map((d) => ({ id: d.id, versionNo: d.version_id ? byId.get(d.version_id) ?? 0 : 1, result: d.result, createdAt: d.created_at })) ?? null,
  };
}
