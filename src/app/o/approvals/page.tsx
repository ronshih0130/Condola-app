import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  return (
    <div>
      <h2>{t("i_approvals")}</h2>
      <p>{t("i_no_approvals")}</p>
    </div>
  );
}
