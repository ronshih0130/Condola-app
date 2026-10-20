import Link from "next/link";
import { makeT } from "@/i18n";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const prefs = await requestPrefs();
  const params = await searchParams;
  const t = makeT(prefs.locale);
  const brand = t("i_brand");
  return (
    <div className="start">
      {params.reset === "1" ? (
        <div className="toast" data-testid="reset-toast">
          {t("s_fe71059")}
        </div>
      ) : null}
      <div className="hero">
        <div>
          <div className="logo" style={{ width: 48, height: 48, fontSize: 24 }}>
            {brand === "Condola" ? "C" : "租"}
          </div>
          <h1 style={{ marginTop: 12 }}>{brand}</h1>
          <p>{t("i_hero")}</p>
          <p className="small">{t("i_positioning", { brand })}</p>
        </div>
      </div>
      <div className="grid2">
        <Link className="card mcard" href="/m">
          <div className="b">{t("i_open_mgr")}</div>
          <p className="small">{t("i_start_mgr")}</p>
        </Link>
        <Link className="card mcard" href="/t">
          <div className="b">{t("i_open_ten")}</div>
          <p className="small">{t("i_start_ten")}</p>
        </Link>
        <Link className="card mcard" href="/o">
          <div className="b">{t("i_open_own")}</div>
          <p className="small">{t("i_start_own")}</p>
        </Link>
        <Link className="card mcard" href="/walk">
          <div className="b">{t("i_walk_title")}</div>
          <p className="small">{t("i_start_walk")}</p>
        </Link>
      </div>
      <p className="foot">{t("i_footer", { brand })}</p>
    </div>
  );
}
