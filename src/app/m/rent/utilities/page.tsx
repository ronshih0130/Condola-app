import Link from "next/link";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionPrepareUtility, actionVoidUtility } from "@/server/actions";
import { UtilityConfirmForm } from "@/components/utility-confirm";
import { formatMoney } from "@/server/format";
import { monthBounds, taipeiToday } from "@/server/money";
import { can } from "@/server/perms";
import { listUtilityBoard, utilityRunDetail } from "@/server/utility-posting";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

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

function readingValue(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? "" : String(value);
}

export default async function UtilityPostingPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string; run?: string; error?: string; saved?: string; page?: string; month?: string }>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = utilityMonth(params.month);
  const period = monthBounds(month);
  const page = Number(params.page ?? "1");
  const board = await listUtilityBoard(session, period.start, period.end, Number.isInteger(page) ? page : 1);
  const detail = params.run ? await utilityRunDetail(session, params.run) : null;
  const canPost = can(session.role, "leases.edit");
  const units = new Map<string, { id: string; label: string; currency: string; rate: string; spaces: typeof board.spaces }>();
  for (const space of board.spaces) {
    const current = units.get(space.unit_id) ?? {
      id: space.unit_id,
      label: `${space.property_name} · ${space.unit_label}`,
      currency: space.currency,
      rate: space.rate ?? "",
      spaces: [],
    };
    if (!current.rate && space.rate) current.rate = space.rate;
    current.spaces.push(space);
    units.set(space.unit_id, current);
  }
  const selected = params.unit ? units.get(params.unit) : [...units.values()][0];
  const money = (minor: number, currency: string) => formatMoney(minor, currency, session.locale);
  const statusLabel = utilityStatusLabel(t, detail?.run.status);
  const formPeriod = detail
    ? { start: detail.run.period_start, end: detail.run.period_end }
    : period;
  const monthValue = (detail?.run.period_start ?? period.start).slice(0, 7);
  return (
    <>
      <PageHeader title={t("i_utility_title")} crumb={<Link href="/m/rent">{t("i_rentroll_title")}</Link>} />
      <ErrorBanner t={t} error={params.error} />
      {params.saved === "posted" ? <div className="alert ok" data-testid="utility-saved">{t("i_utility_saved")}</div> : null}
      {params.saved === "void" ? <div className="alert ok">{t("i_utility_voided")}</div> : null}
      <p className="small">{t("i_utility_hint")}</p>
      <form method="get" action="/m/rent/utilities" className="card pad" data-testid="utility-month-form" style={{ maxWidth: 760 }}>
        {selected ? <input type="hidden" name="unit" value={selected.id} /> : null}
        <div className="fg">
          <label className="f" htmlFor="utility-month">{t("i_utility_month")}</label>
          <input id="utility-month" className="inp" type="month" name="month" data-testid="utility-month" defaultValue={monthValue} />
        </div>
        <p className="small" data-testid="utility-period">
          {formPeriod.start} – {formPeriod.end}
        </p>
        <p className="small">{t("i_utility_period_note")}</p>
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
      {canPost && selected ? (
        <form className="card pad" action={actionPrepareUtility} style={{ maxWidth: 760 }} data-testid="utility-form">
          <input type="hidden" name="unitId" value={selected.id} />
          <input type="hidden" name="periodStart" value={formPeriod.start} />
          <input type="hidden" name="periodEnd" value={formPeriod.end} />
          <div className="fg">
            <label className="f">{t("i_floor_unit")}</label>
            <select className="inp" name="unitChoice" data-testid="utility-unit" defaultValue={selected.id} form="" disabled>
              {[...units.values()].map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.label}
                </option>
              ))}
            </select>
            <div className="row" style={{ marginTop: 8 }}>
              {[...units.values()].map((unit) => (
                <Link key={unit.id} className={unit.id === selected.id ? "btn pri sm" : "btn sm"} href={utilityHref({ month, unit: unit.id, page: board.page })}>
                  {unit.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_rate")}</label>
            <input className="inp" name="rate" data-testid="utility-rate" inputMode="decimal" defaultValue={detail ? String(detail.rateMajor) : selected.rate} />
          </div>
          <div className="fg">
            <label className="f">{t("i_utility_total_kwh")}</label>
            <input className="inp" name="totalKwh" data-testid="utility-total-kwh" inputMode="decimal" />
          </div>
          {selected.spaces.map((space) => {
            const prior = detail?.lines.find((line) => (line.room_id ?? detail.run.unit_id) === space.space_id);
            const methodLabel = space.method === "by_reading" ? t("i_elec_reading") : t("i_elec_submeter");
            return (
              <div className="fg" key={space.space_id}>
                <label className="f">
                  {space.space_label} · {space.tenant || t("i_vacant")} · {methodLabel}
                </label>
                <input type="hidden" name="spaceId" value={space.space_id} />
                <input type="hidden" name="kwh" value={prior?.usage ?? ""} />
                <div className="grid2">
                  <input
                    className="inp"
                    name="prevKwh"
                    data-testid={`kwh-prev-${space.space_label}`}
                    inputMode="decimal"
                    defaultValue={readingValue(prior?.previousKwh)}
                    placeholder={t("i_utility_prev_kwh")}
                    aria-label={`${space.space_label} ${t("i_utility_prev_kwh")}`}
                  />
                  <input
                    className="inp"
                    name="currKwh"
                    data-testid={`kwh-curr-${space.space_label}`}
                    inputMode="decimal"
                    defaultValue={readingValue(prior?.currentKwh)}
                    placeholder={t("i_utility_curr_kwh")}
                    aria-label={`${space.space_label} ${t("i_utility_curr_kwh")}`}
                  />
                </div>
              </div>
            );
          })}
          <div className="fg">
            <label className="f">{t("i_rate_reason")}</label>
            <input className="inp" name="overrideReason" data-testid="utility-override" />
          </div>
          <button className="btn" type="submit" data-testid="utility-preview">
            {t("i_utility_preview")}
          </button>
        </form>
      ) : null}
      {detail ? (
        <div className="card" style={{ marginTop: 16 }} data-testid="utility-review" key={`${detail.run.id}-${detail.run.status}-${params.saved ?? ""}`}>
          <div className="hd">
            <h3>
              {detail.run.property_name} · {detail.run.unit_label}
            </h3>
            <span className="chip" data-testid="utility-status">{statusLabel}</span>
          </div>
          <p className="small">{t("i_utility_repost")}</p>
          <table className="t">
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.id} data-testid="utility-share">
                  <td>
                    {line.bearer === "owner" ? t("i_utility_owner_vacant") : line.tenant || t("i_vacant")}
                    <div className="small muted" data-testid="utility-share-desc">
                      {line.description}
                    </div>
                  </td>
                  <td className="num">{money(Number(line.amount), detail.run.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canPost && detail.run.status !== "void" ? (
            <div className="bd">
              <UtilityConfirmForm
                runId={detail.run.id}
                month={(detail.run.period_start || monthValue).slice(0, 7)}
                unitId={detail.run.unit_id}
                label={t("i_utility_confirm")}
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
        {board.runs.length === 0 ? (
          <div className="empty">{t("i_empty")}</div>
        ) : (
          <table className="t">
            <tbody>
              {board.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link href={utilityHref({ run: run.id, month: run.period_start.slice(0, 7) })}>
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
