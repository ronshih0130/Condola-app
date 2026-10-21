import Link from "next/link";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionConfirmUtility, actionPrepareUtility, actionVoidUtility } from "@/server/actions";
import { formatMoney } from "@/server/format";
import { can } from "@/server/perms";
import { currentUtilityPeriod, listUtilityBoard, utilityRunDetail } from "@/server/utility-posting";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function UtilityPostingPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string; run?: string; error?: string; saved?: string; page?: string }>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const period = currentUtilityPeriod();
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
  const statusLabel =
    detail?.run.status === "posted" ? t("i_utility_posted") : detail?.run.status === "void" ? t("i_utility_voided") : t("i_utility_draft");
  return (
    <>
      <PageHeader title={t("i_utility_title")} crumb={<Link href="/m/rent">{t("i_rentroll_title")}</Link>} />
      <ErrorBanner t={t} error={params.error} />
      {params.saved === "posted" ? <div className="alert ok" data-testid="utility-saved">{t("i_utility_saved")}</div> : null}
      {params.saved === "void" ? <div className="alert ok">{t("i_utility_voided")}</div> : null}
      <p className="small">{t("i_utility_hint")}</p>
      {units.size === 0 ? <div className="empty">{t("i_utility_empty")}</div> : null}
      {board.page > 1 || board.hasMore ? (
        <div className="row" style={{ margin: "8px 0" }}>
          {board.page > 1 ? (
            <Link className="btn sm" href={`/m/rent/utilities?page=${board.page - 1}`}>
              {t("i_utility_prev")}
            </Link>
          ) : null}
          {board.hasMore ? (
            <Link className="btn sm" href={`/m/rent/utilities?page=${board.page + 1}`}>
              {t("i_utility_next")}
            </Link>
          ) : null}
        </div>
      ) : null}
      {canPost && selected ? (
        <form className="card pad" action={actionPrepareUtility} style={{ maxWidth: 760 }} data-testid="utility-form">
          <input type="hidden" name="unitId" value={selected.id} />
          <input type="hidden" name="periodStart" value={detail?.run.period_start ?? period.start} />
          <input type="hidden" name="periodEnd" value={detail?.run.period_end ?? period.end} />
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
                <Link key={unit.id} className={unit.id === selected.id ? "btn pri sm" : "btn sm"} href={`/m/rent/utilities?unit=${unit.id}&page=${board.page}`}>
                  {unit.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("i_period")}</label>
              <p data-testid="utility-period">
                {detail?.run.period_start ?? period.start} – {detail?.run.period_end ?? period.end}
              </p>
            </div>
            <div className="fg">
              <label className="f">{t("i_rate")}</label>
              <input className="inp" name="rate" data-testid="utility-rate" inputMode="decimal" defaultValue={detail ? String(detail.rateMajor) : selected.rate} />
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_utility_total_kwh")}</label>
            <input className="inp" name="totalKwh" data-testid="utility-total-kwh" inputMode="decimal" />
          </div>
          {selected.spaces.map((space) => {
            const prior = detail?.lines.find((line) => (line.room_id ?? detail.run.unit_id) === space.space_id);
            return (
              <div className="fg" key={space.space_id}>
                <label className="f">
                  {space.space_label} · {space.tenant} · {space.method === "by_reading" ? t("i_elec_reading") : t("i_elec_submeter")}
                </label>
                <input type="hidden" name="spaceId" value={space.space_id} />
                <input
                  className="inp"
                  name="kwh"
                  data-testid={`kwh-${space.space_label}`}
                  inputMode="decimal"
                  defaultValue={prior ? prior.usage : ""}
                  placeholder={t("i_utility_kwh")}
                />
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
        <div className="card" style={{ marginTop: 16 }} data-testid="utility-review">
          <div className="hd">
            <h3>
              {detail.run.property_name} · {detail.run.unit_label}
            </h3>
            <span className="chip">{statusLabel}</span>
          </div>
          <p className="small">{t("i_utility_repost")}</p>
          <table className="t">
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.id} data-testid="utility-share">
                  <td>
                    {line.tenant || t("i_vacant")}
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
              <form action={actionConfirmUtility}>
                <input type="hidden" name="runId" value={detail.run.id} />
                <button className="btn pri" type="submit" data-testid="utility-confirm">
                  {t("i_utility_confirm")}
                </button>
              </form>
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
                    <Link href={`/m/rent/utilities?run=${run.id}`}>
                      {run.property_name} · {run.unit_label}
                    </Link>
                    <div className="small muted">
                      {run.period_start} – {run.period_end}
                    </div>
                  </td>
                  <td>{run.status === "posted" ? t("i_utility_posted") : run.status === "void" ? t("i_utility_voided") : t("i_utility_draft")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
