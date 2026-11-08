import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { connection } from "next/server";
import { makeT } from "@/i18n";
import { archiveCopy } from "@/i18n/record-archive";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionPrepareUtility, actionVoidUtility } from "@/server/actions";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { PendingSubmit, UtilityConfirmForm } from "@/components/utility-confirm";
import { UtilityUnitSelect } from "@/components/utility-unit-select";
import { electricityMonthLabel, signedMoney } from "@/server/format";
import { monthBounds, taipeiToday } from "@/server/money";
import { can } from "@/server/perms";
import { listUtilityBoard, utilityRunDetail } from "@/server/utility-posting";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function utilityStatusLabel(t: (key: string) => string, status: string | undefined) {
  if (status === "posted") return t("i_utility_posted");
  if (status === "pending_repost") return t("i_utility_pending");
  if (status === "void") return t("i_utility_voided");
  return t("i_utility_draft");
}

function utilityMonth(raw: string | undefined) {
  const today = taipeiToday().slice(0, 7);
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return today;
  const month = Number(raw.slice(5));
  if (!Number.isInteger(month) || month < 1 || month > 12) return today;
  return raw;
}

function utilityHref(query: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `/m/rent/utilities?${text}` : "/m/rent/utilities";
}

function methodLabel(t: (key: string) => string, method: string | null) {
  if (method === "even") return t("s_ecf0e25");
  if (method === "by_reading") return t("i_elec_reading");
  if (method === "submeter") return t("s_9f8b19c");
  return t("i_elec_unset");
}

function readingValue(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? "" : String(value);
}

export default async function UtilityPostingPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string; run?: string; error?: string; saved?: string; page?: string; month?: string; bill?: string; kwh?: string; runPage?: string; historyUnit?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  await connection();
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = utilityMonth(params.month);
  const period = monthBounds(month);
  const page = Number(params.page ?? "1");
  const runPage = Number(params.runPage ?? "1");
  const board = await listUtilityBoard(session, period.start, period.end, Number.isInteger(page) ? page : 1, undefined, Number.isInteger(runPage) ? runPage : 1, params.historyUnit);
  const detail = params.run ? await utilityRunDetail(session, params.run) : null;
  const canPost = can(session, "leases.edit");
  const units = new Map<string, { id: string; propertyId: string; label: string; currency: string; rate: string; spaces: typeof board.spaces }>();
  for (const space of board.spaces) {
    const current = units.get(space.unit_id) ?? {
      id: space.unit_id,
      propertyId: space.property_id,
      label: `${space.property_name} · ${space.unit_label}`,
      currency: space.currency,
      rate: space.rate ?? "",
      spaces: [],
    };
    if (!current.rate && space.rate) current.rate = space.rate;
    current.spaces.push(space);
    units.set(space.unit_id, current);
  }
  const resultUnit = detail?.run;
  if (resultUnit && !units.has(resultUnit.unit_id)) {
    units.set(resultUnit.unit_id, {
      id: resultUnit.unit_id,
      propertyId: resultUnit.property_id,
      label: `${resultUnit.property_name} · ${resultUnit.unit_label}`,
      currency: resultUnit.currency,
      rate: "",
      spaces: [],
    });
  }
  const selected = (resultUnit ? units.get(resultUnit.unit_id) : undefined) ?? (params.unit ? units.get(params.unit) : undefined) ?? [...units.values()][0];
  const correctionDetail = detail && (detail.run.status === "posted" || detail.run.status === "pending_repost") ? detail : null;
  const formSpaces = correctionDetail ? correctionDetail.correctionSpaces : selected?.spaces ?? [];
  const canPrepare = !!selected && (correctionDetail ? correctionDetail.correctionAvailable : selected.spaces.length > 0);
  const money = (minor: number, currency: string) => signedMoney(minor, currency, session.locale, v2);
  const statusLabel = utilityStatusLabel(t, detail?.run.status);
  const formPeriod = detail
    ? { start: detail.run.period_start, end: detail.run.period_end }
    : period;
  const monthValue = (detail?.run.period_start ?? period.start).slice(0, 7);
  return (
    <>
      <PageHeader title={t("i_utility_title")} crumb={<Link href="/m/rent">{t("i_rentroll_title")}</Link>} />
      <ErrorBanner t={t} error={params.error} />
      {params.saved === "posted" && detail?.run.status === "posted" ? <div className="alert ok" data-testid="utility-saved">{t("i_utility_saved")}</div> : null}
      {params.saved === "void" ? <div className="alert ok">{t("i_utility_voided")}</div> : null}
      <p className="small">{t("i_utility_hint")}</p>
      <form method="get" action="/m/rent/utilities" className="card pad" data-testid="utility-month-form" style={{ maxWidth: 760 }}>
        <div className="grid2">
          <div className="fg">
            <label className="f" htmlFor="utility-unit">{t("i_property_name")}</label>
            <UtilityUnitSelect
              units={[...units.values()].map((unit) => ({ id: unit.id, label: unit.label }))}
              selectedId={selected?.id ?? ""}
            />
          </div>
          <div className="fg">
            <label className="f" htmlFor="utility-month">{t("i_utility_month")}</label>
            <input id="utility-month" className="inp" type="month" name="month" data-testid="utility-month" key={monthValue} defaultValue={monthValue} />
          </div>
        </div>
        <p className="small" data-testid="utility-period">{formPeriod.start} – {formPeriod.end}</p>
        <button className="btn sm" type="submit">{t("i_utility_month_apply")}</button>
      </form>
      {units.size === 0 ? <div className="empty" data-testid="utility-empty">{t("i_utility_empty")}</div> : null}
      {board.page > 1 || board.hasMore ? (
        <div className="row" style={{ margin: "8px 0" }}>
          {board.page > 1 ? (
            <Link className="btn sm" href={utilityHref({ month, unit: selected?.id, page: board.page - 1 })}>
              {t("i_utility_prev")}
            </Link>
          ) : null}
          {board.hasMore ? (
            <Link className="btn sm" href={utilityHref({ month, unit: selected?.id, page: board.page + 1 })}>
              {t("i_utility_next")}
            </Link>
          ) : null}
        </div>
      ) : null}
      {canPost && correctionDetail && !canPrepare && <p role="status">{archiveCopy(session.locale).unavailable}</p>}
      {canPost && selected && canPrepare ? (
        <form className="card pad" action={actionPrepareUtility} style={{ maxWidth: 760 }} data-testid="utility-form">
          <input type="hidden" name="unitId" value={selected.id} />
          {correctionDetail && <input type="hidden" name="sourceRunId" value={correctionDetail.run.id} />}
          <input type="hidden" name="periodStart" value={formPeriod.start} />
          <input type="hidden" name="periodEnd" value={formPeriod.end} />
          <div className="row" data-testid="utility-method" style={{ gap: 16, alignItems: "center", background: "#F6EEE6", borderRadius: 10, padding: "10px 14px" }}>
            <span>{t("i_split")}：<b>{methodLabel(t, formSpaces[0]?.method ?? null)}</b></span>
            <span>{t("i_rate")}：<b>NT$</b></span>
            <input className="inp" name="rate" data-testid="utility-rate" inputMode="decimal" defaultValue={detail ? String(detail.rateMajor) : selected.rate} style={{ maxWidth: 120 }} />
            <Link href={`/m/properties/${selected.propertyId}/edit`} style={{ marginLeft: "auto" }}>{t("i_utility_settings")}</Link>
          </div>
          <h3 style={{ marginTop: 16 }}>{t("i_utility_section_bill")}</h3>
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("i_bill_total")}</label>
              <input className="inp" name="billTotal" data-testid="utility-bill" inputMode="decimal" defaultValue={params.bill ?? (correctionDetail ? correctionDetail.correctionBillMajor ?? "" : "")} />
            </div>
            <div className="fg">
              <label className="f">{t("i_utility_total_kwh")}</label>
              <input className="inp" name="totalKwh" data-testid="utility-total-kwh" inputMode="decimal" defaultValue={params.kwh ?? (correctionDetail ? readingValue(correctionDetail.correctionTotalKwh) : "")} />
            </div>
          </div>
          {formSpaces.length > 0 && formSpaces.every((space) => space.method === "even") ? (
            <p className="small">{t("i_utility_even_help")}</p>
          ) : (
            <>
              <h3>{t("i_utility_section_rooms")}</h3>
              {formSpaces.map((space) => {
                const prior = detail?.lines.find((line) => (line.room_id ?? detail.run.unit_id) === space.space_id);
                const saved = correctionDetail ? correctionDetail.correctionSpaces.find((item) => item.space_id === space.space_id) : undefined;
                return (
                  <div className="fg" key={space.space_id}>
                    <label className="f">
                      {space.space_label} · {space.tenant || t("i_vacant")} · {methodLabel(t, space.method)}
                    </label>
                    <input type="hidden" name="spaceId" value={space.space_id} />
                    <input type="hidden" name="kwh" value={saved?.kwh ?? prior?.usage ?? ""} />
                    <div className="grid2">
                      <input
                        className="inp"
                        name="prevKwh"
                        data-testid={`kwh-prev-${space.space_label}`}
                        inputMode="decimal"
                        defaultValue={readingValue(saved?.previousKwh ?? prior?.previousKwh)}
                        placeholder={t("i_utility_prev_kwh")}
                        aria-label={`${space.space_label} ${t("i_utility_prev_kwh")}`}
                      />
                      <input
                        className="inp"
                        name="currKwh"
                        data-testid={`kwh-curr-${space.space_label}`}
                        inputMode="decimal"
                        defaultValue={readingValue(saved?.currentKwh ?? prior?.currentKwh)}
                        placeholder={t("i_utility_curr_kwh")}
                        aria-label={`${space.space_label} ${t("i_utility_curr_kwh")}`}
                      />
                    </div>
                  </div>
                );
              })}
            </>
          )}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <PendingSubmit label={t("i_utility_preview")} pendingLabel={t("i_utility_working")} testId="utility-preview" />
          </div>
        </form>
      ) : null}
      {detail ? (
        <div className="card" style={{ marginTop: 16 }} data-testid="utility-review" key={`${detail.run.id}-${detail.run.status}-${params.saved ?? ""}`}>
          <div className="hd">
            <h3>{t("i_utility_section_result")}</h3>
            <span className="chip" data-testid="utility-status">{statusLabel}</span>
          </div>
          {detail.run.status === "posted" ? (
            <div className="alert ok" data-testid="utility-posted-lock">{t("i_utility_posted_locked")}</div>
          ) : detail.run.status === "pending_repost" ? (
            <p className="small" data-testid="utility-repost">{t("i_utility_repost")}</p>
          ) : null}
          {detail.adjustments.publicKwhMilli < 0 ? (
            <div className="alert warn" data-testid="utility-public-warn">{t("i_utility_public_warn")}</div>
          ) : null}
          {detail.adjustments.billGapWarn ? (
            <div className="alert warn" data-testid="utility-gap-warn">{t("i_utility_gap_warn")}</div>
          ) : null}
          <table className="t">
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.id} data-testid="utility-share">
                  <td>
                    {line.bearer === "owner" ? t("i_utility_owner_vacant") : line.tenant || t("i_vacant")}
                    <div className="small muted" data-testid="utility-share-desc">{electricityMonthLabel(detail.run.period_start, line.description)}</div>
                  </td>
                  <td className="num">{money(Number(line.amount), detail.run.currency)}</td>
                </tr>
              ))}
              {detail.adjustments.publicAmountMinor !== 0 ? (
                <tr data-testid="utility-public">
                  <td>{t("i_utility_owner_public")}<div className="small muted">{t("i_utility_public_help", { kwh: String(detail.adjustments.publicKwhMilli / 1000) })}</div></td>
                  <td className="num">{money(detail.adjustments.publicAmountMinor, detail.run.currency)}</td>
                </tr>
              ) : null}
              {detail.adjustments.billGapMinor !== 0 ? (
                <tr data-testid="utility-gap">
                  <td>{t("i_utility_gap")}</td>
                  <td className="num">{money(detail.adjustments.billGapMinor, detail.run.currency)}</td>
                </tr>
              ) : null}
              {detail.adjustments.remainderMinor !== 0 ? (
                <tr data-testid="utility-remainder">
                  <td>{t("i_utility_remainder")}</td>
                  <td className="num">{money(detail.adjustments.remainderMinor, detail.run.currency)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {canPost && detail.run.status !== "void" && detail.run.status !== "posted" ? (
            <div className="bd">
              <UtilityConfirmForm
                runId={detail.run.id}
                month={(detail.run.period_start || monthValue).slice(0, 7)}
                unitId={detail.run.unit_id}
                label={t("i_utility_confirm")}
                pendingLabel={t("i_utility_working")}
              />
              <form action={actionVoidUtility} style={{ marginTop: 12 }}>
                <input type="hidden" name="runId" value={detail.run.id} />
                <label className="f">{t("i_utility_void_reason")}</label>
                <input className="inp" name="reason" data-testid="utility-void-reason" />
                <button className="btn" type="submit" data-testid="utility-void" style={{ marginTop: 8 }}>
                  {t("i_utility_void")}
                </button>
              </form>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{t("i_utility_runs")}</h3>
        </div>
        <div className="row">
          {board.runPage > 1 && <Link className="btn sm" href={utilityHref({month, unit: selected?.id, historyUnit: params.historyUnit, runPage: board.runPage - 1})}>{t("i_utility_prev")}</Link>}
          {board.runHasMore && <Link className="btn sm" href={utilityHref({month, unit: selected?.id, historyUnit: params.historyUnit, runPage: board.runPage + 1})}>{t("i_utility_next")}</Link>}
        </div>
        {board.runs.length === 0 ? (
          <div className="empty">{t("i_empty")}</div>
        ) : (
          <table className="t">
            <tbody>
              {board.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link href={utilityHref({ run: run.id, unit: run.unit_id, month: run.period_start.slice(0, 7), historyUnit: params.historyUnit, runPage: board.runPage })}>
                      {run.property_name} · {run.unit_label}
                    </Link>
                    <div className="small muted">
                      {run.period_start} – {run.period_end}
                    </div>
                  </td>
                  <td>{utilityStatusLabel(t, run.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
