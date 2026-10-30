import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ImportWizard } from "@/components/import-wizard";
import { PageHeader } from "@/components/ui";
import { can } from "@/server/perms";
import { getSession } from "@/server/session";
import { maybe, tx } from "@/server/db";
import { importErrorDetailsEnabled } from "@/server/import-feature";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  if (!can(session.role, "props.edit")) {
    return (
      <div className="alert bad" data-testid="forbidden">
        {t("i_forbidden")}
      </div>
    );
  }
  let detailsEnabled = false;
  if (process.env.IMPORT_ERROR_DETAILS_ENABLED === "true") {
    try {
      const org = await tx(session.userId, (client) => maybe<{ feature_flags: unknown }>(
        client, `SELECT feature_flags FROM organizations WHERE id = $1`, [session.orgId],
      ), { orgId: session.orgId, environment: session.environment });
      detailsEnabled = importErrorDetailsEnabled(process.env.IMPORT_ERROR_DETAILS_ENABLED, org?.feature_flags);
    } catch {
      // Missing or unavailable configuration must not enable the feature.
    }
  }
  return (
    <>
      <PageHeader title={t("im_title")} crumb={t("s_e03a6ec")} />
      <ImportWizard detailsEnabled={detailsEnabled} />
    </>
  );
}
