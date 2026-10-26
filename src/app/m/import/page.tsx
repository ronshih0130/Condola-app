import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ImportWizard } from "@/components/import-wizard";
import { PageHeader } from "@/components/ui";
import { can } from "@/server/perms";
import { getSession } from "@/server/session";

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
  return (
    <>
      <PageHeader title={t("im_title")} crumb={t("s_e03a6ec")} />
      <ImportWizard />
    </>
  );
}
