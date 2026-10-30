import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { roleHome, rolesFor, type PermKey } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NoPermPage({ searchParams }: { searchParams: Promise<{ need?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const need = (params.need ?? "") as PermKey;
  const roleLabel: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  let roles = "";
  if (params.need === "admin") {
    roles = t("i_role_admin");
  } else {
    try {
      roles = rolesFor(need)
        .map((role) => t(roleLabel[role]))
        .join(t("i_list_sep"));
    } catch {
      roles = "";
    }
  }
  return (
    <>
      <PageHeader title={t("i_noperm_title")} />
      <div className="alert bad" data-testid="forbidden">
        <div>
          <p>{t("i_noperm_body", { roles: roles || t("i_role_admin") })}</p>
          <p>{t("i_ask_admin")}</p>
          <Link className="btn pri" href={roleHome(session.kind, session.role)}>
            {t("i_go_home")}
          </Link>
        </div>
      </div>
    </>
  );
}
