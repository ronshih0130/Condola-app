import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { brandV2Enabled } from "@/server/brand-v2";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const v2 = brandV2Enabled();
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  return (
    <div data-v2-page={v2 ? "o-approvals" : undefined}>
      <h2>{t("i_approvals")}</h2>
      <p>{t("i_no_approvals")}</p>
    </div>
  );
}
