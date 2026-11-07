import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ImportWizard } from "@/components/import-wizard";
import { PageHeader } from "@/components/ui";
import { can } from "@/server/perms";
import { getSession } from "@/server/session";
import { tx } from "@/server/db";
import { loadImportRegion } from "@/server/import-region-context";
import type { ImportRegion } from "@/server/import-region";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await guardEffectiveSession(await getSession(), "props.edit");
  const t = makeT(session.locale);
  if (!can(session, "props.edit")) {
    return (
      <div className="alert bad" data-testid="forbidden">
        {t("i_forbidden")}
      </div>
    );
  }
  let region: ImportRegion | null = null;
  let regionUnavailable = false;
  if (process.env.IMPORT_ERROR_DETAILS_ENABLED === "true") {
    try {
      region = await tx(session.userId, client => loadImportRegion(client, session.orgId),
        { orgId: session.orgId, environment: session.environment });
    } catch {
      regionUnavailable = true;
    }
  }
  return (
    <>
      <PageHeader title={t("im_title")} crumb={t("s_e03a6ec")} />
      {regionUnavailable ? <div className="alert bad" data-testid="import-region-unavailable">{t("im_region_unavailable")}</div>
        : <ImportWizard detailsEnabled={Boolean(region)} region={region} />}
    </>
  );
}
