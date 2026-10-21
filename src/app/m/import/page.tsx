import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionImportCsv } from "@/server/import-actions";
import { can } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!can(session.role, "props.edit")) {
    return <div className="alert bad" data-testid="forbidden">{t("i_forbidden")}</div>;
  }
  return (
    <>
      <PageHeader title={t("i_import_title")} crumb={t("i_nav_dash")} />
      <ErrorBanner t={t} error={params.error === "rows" ? "errors.generic" : params.error} />
      <form action={actionImportCsv} className="card pad" style={{ maxWidth: 640 }} data-testid="import-form">
        <p className="hint">{t("i_import_help")}</p>
        <div className="fg">
          <label className="f">{t("i_import_title")}</label>
          <input className="inp" type="file" name="file" accept=".csv,text/csv" data-testid="import-file" />
        </div>
        <button className="btn pri" type="submit" data-testid="import-submit">
          {t("i_import_title")}
        </button>
      </form>
    </>
  );
}
