import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  return (
    <div data-v2-page={v2 ? "o-approvals" : undefined}>
      <h2>{t("i_approvals")}</h2>
      <p>{t("i_no_approvals")}</p>
    </div>
  );
}
